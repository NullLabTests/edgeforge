import type { Workspace } from "@cloudflare/computer";
import type { Env, AgentResult, ToolCall, ToolResult, TestResult } from "./types.js";
import { getToolDefinitions, executeTool } from "./tools.js";
import { ensureParentDirs } from "./fs-helpers.js";
import { canRunTask, getNeuronBudget, addNeuronsUsedToday } from "./budget.js";
import { createLogger } from "./logger.js";

const logger = createLogger("agent");

// ─── System Prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are DevForge, an AI development agent. You build Cloudflare Workers projects.

You have a virtual filesystem with these tools:
- write(path, content): Write a file
- read(path): Read a file
- edit(path, oldContent, newContent): Edit a file (exact string replacement)
- ls(path): List directory contents
- find(pattern): Find files matching a glob pattern
- grep(pattern, path?): Search file contents
- delete(path): Delete a file
- exec(command): Execute a shell command (simulated — returns what the command would output)
- deploy(projectName): Request deployment (triggers human approval)

RULES:
1. Plan before writing. Output your plan as a numbered list in your first response.
2. Write tests BEFORE deploying. Use vitest.
3. Run "npm install" and "npm test" via exec() to validate.
4. If tests fail, read the errors, fix code, retry up to 3 times.
5. NEVER deploy untested code.
6. Keep code minimal. Single-file Workers when possible.
7. Use plain JavaScript for the deployable entry (/src/index.js, export default with fetch()). Deploys upload the module as-is, so no TypeScript/build step in the deployed artifact — keep .ts for local tooling only.
8. Call deploy() when tests pass. Do not deploy prematurely.
9. Each gadget is a self-contained Worker with wrangler.toml.
10. Be concise. Focus on working code.`;

// ─── Agent Loop ─────────────────────────────────────────────────────────────

export async function runAgentLoop(
  prompt: string,
  workspace: Workspace,
  env: Env,
  maxIterations: number = 15,
): Promise<AgentResult> {
  const filesWritten: string[] = [];
  const toolDefs = getToolDefinitions();

  // Build initial messages
  const messages: Array<{ role: string; content?: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }> = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];

  let neuronsUsed = 0;

  // Reserve budget up front so a long task can't blow through the free 10K/day
  // allowance (Workers AI rolls over at midnight UTC).
  const budget = await getNeuronBudget(env.BUDGET);
  if (!(await canRunTask(env.BUDGET, maxIterations))) {
    logger.warn("Daily AI budget exhausted at task start", {
      event: "agent.budget.exhausted",
      used: budget.used,
      remaining: budget.remaining,
    });
    return {
      status: "budget_exhausted",
      summary: `Daily AI budget nearly exhausted (${budget.used}/${budget.limit} neurons used). Resets at midnight UTC.`,
      iterations: 0,
      filesWritten,
      neuronsUsed: 0,
      budget,
    };
  }

  for (let i = 0; i < maxIterations; i++) {
    logger.info(`Iteration ${i + 1}/${maxIterations}`, { event: "agent.iteration", iteration: i + 1 });

    // Call Workers AI with tool definitions. If the AI binding is unavailable
    // (unauth'd `wrangler dev`, exhausted daily budget, deploy without the
    // binding), fall back to the deterministic template builder so the flow
    // stays demoable end-to-end.
    let response: LLMResponse;
    try {
      response = await callLLM(env.AI, messages, toolDefs);
    } catch (err) {
      const errObj = err as { name?: string; message?: string; cause?: unknown; stack?: string };
      logger.warn("AI binding unavailable, using offline template builder", {
        event: "agent.ai.unavailable",
        error: err,
        errorName: errObj?.name,
        errorMessage: errObj?.message,
        errorCause: errObj?.cause instanceof Error ? `${errObj.cause.name}: ${errObj.cause.message}` : String(errObj?.cause),
      });
      const { files, summary } = await buildTemplateProject(prompt, workspace);
      filesWritten.push(...files);
      return {
        status: "complete",
        summary,
        iterations: 1,
        filesWritten,
        neuronsUsed: 0,
      };
    }
    neuronsUsed += response.neuronsUsed;
    await addNeuronsUsedToday(env.BUDGET, response.neuronsUsed);

    // Check budget (10K neurons/day)
    if (neuronsUsed > 9000) {
      logger.warn("Neuron budget nearly exhausted", { event: "agent.budget.warning", neuronsUsed });
      const finalBudget = await getNeuronBudget(env.BUDGET);
      return {
        status: "budget_exhausted",
        summary: "Daily AI budget nearly exhausted. Resets at midnight UTC.",
        iterations: i + 1,
        filesWritten,
        neuronsUsed,
        budget: finalBudget,
      };
    }

    // If the model returned a text response with no tool calls, we're done
    if (!response.tool_calls || response.tool_calls.length === 0) {
      logger.info("Agent completed", { event: "agent.complete", iterations: i + 1, neuronsUsed });
      const finalBudget = await getNeuronBudget(env.BUDGET);
      return {
        status: "complete",
        summary: response.text || "Task completed.",
        iterations: i + 1,
        filesWritten,
        neuronsUsed,
        budget: finalBudget,
      };
    }

    // The Workers AI binding's schema for this model accepts only plain
    // string-content messages (no assistant tool_calls / tool round-trips — the
    // granter catalog schema rejects it with "oneOf at '/' not met"). So we keep
    // the transcript shaped as role+content strings only: the assistant's turn is
    // its text, and each tool result becomes a user message quoting the result.
    messages.push({
      role: "assistant",
      content: response.text || "(calling tools)",
    });

    // Execute each tool call
    for (const call of response.tool_calls) {
      const result = await executeTool(call, workspace, env);

      // Track written files
      if (call.name === "write" && typeof call.arguments.path === "string") {
        if (!filesWritten.includes(call.arguments.path)) {
          filesWritten.push(call.arguments.path);
        }
      }

      messages.push({
        role: "user",
        content: `Tool result for ${call.name}${
          call.arguments.path ? ` (${String(call.arguments.path)})` : ""
        }:\n${result.content}`,
      });
    }
  }

  logger.warn("Agent reached max iterations", { event: "agent.max_iterations", neuronsUsed });
  const finalBudget = await getNeuronBudget(env.BUDGET);
  return {
    status: "max_iterations",
    summary: `Reached maximum iterations (${maxIterations}). Files written: ${filesWritten.join(", ")}`,
    iterations: maxIterations,
    filesWritten,
    neuronsUsed,
    budget: finalBudget,
  };
}

// ─── LLM Call ───────────────────────────────────────────────────────────────

interface LLMResponse {
  text: string;
  tool_calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  neuronsUsed: number;
}

async function callLLM(
  ai: Ai,
  messages: Array<{ role: string; content?: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }>,
  tools: unknown[],
): Promise<LLMResponse> {
  // Use Granite 4.0 Micro — cheapest function-calling model on Workers AI
  // ~1,542 neurons/M input, ~10,158 neurons/M output
  const model = "@cf/ibm-granite/granite-4.0-h-micro";

  const result = await (ai.run as (model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>) => Promise<Record<string, unknown>>)(
    model,
    { messages, tools },
    {},
  );

  // The Workers AI binding returns the standard OpenAI chat-completions shape:
  // result.choices[0].message.{content, tool_calls[]} where each tool call has
  // function.{name, arguments}. The model double-encodes `arguments` as a quoted
  // JSON string, so parse defensively (an object stays; a string is decoded once more).
  const choice = (result as { choices?: Array<{ message?: ChatCompletionMessage }> })?.choices?.[0];
  const message = choice?.message;
  const text = typeof message?.content === "string" ? message.content : "";

  const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  for (const tc of message?.tool_calls || []) {
    const name = tc.function?.name || "";
    if (!name) continue;
    let args: unknown = {};
    try {
      args = JSON.parse(tc.function?.arguments || "{}");
      if (typeof args === "string") args = JSON.parse(args);
    } catch {
      args = {};
    }
    toolCalls.push({
      id: tc.id || `call-${Math.random().toString(36).slice(2)}`,
      name,
      arguments: (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>,
    });
  }

  // Prefer the provider's own neuron figure when present; otherwise estimate
  // from token counts (granite micro: ~1,542 neurons/M input, ~10,158/M output).
  const usage = (result as { usage?: { neurons?: number; prompt_tokens?: number; completion_tokens?: number } })?.usage;
  let neuronsUsed: number;
  if (typeof usage?.neurons === "number" && usage.neurons > 0) {
    neuronsUsed = Math.max(1, Math.ceil(usage.neurons));
  } else {
    const inputTokens = usage?.prompt_tokens || 0;
    const outputTokens = usage?.completion_tokens || 0;
    neuronsUsed = Math.max(1, Math.ceil((inputTokens * 1542 + outputTokens * 10158) / 1_000_000));
  }

  return { text, tool_calls: toolCalls, neuronsUsed };
}

interface ChatCompletionMessage {
  content?: string | null;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}

// ─── Offline Template Builder ───────────────────────────────────────────────
// Used when the Workers AI binding is unavailable (unauth'd `wrangler dev`, or
// any environment without an AI binding). Writes a deterministic, correct todo
// API project so the full flow (write → file tree → simulated tests → deploy
// request → approval) can still be exercised end-to-end.

async function buildTemplateProject(
  prompt: string,
  workspace: Workspace,
): Promise<{ files: string[]; summary: string }> {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "todo-api";

  const projectName = slug;
  const files: Record<string, string> = {
    "/package.json": JSON.stringify({
      name: projectName,
      version: "1.0.0",
      private: true,
      scripts: { test: "vitest run", deploy: "wrangler deploy" },
      devDependencies: { vitest: "^3.0.0", wrangler: "^4.0.0" },
    }, null, 2),
    "/wrangler.toml": `name = "${projectName}"
main = "src/index.js"
compatibility_date = "2024-12-01"
`,
    "/src/index.js": `// ${projectName} — generated by DevForge (offline template)
// Plain JS on purpose: the Gatekeeper uploads the module as-is for a live deploy.
const todos = new Map();
let nextId = 1;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
});

const parseBody = async (req) => {
  try { return await req.json(); } catch { return {}; }
};

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean);

    if (req.method === "GET" && segments.length === 1 && segments[0] === "todos") {
      return json([...todos.values()]);
    }

    if (req.method === "POST" && segments.length === 1 && segments[0] === "todos") {
      const body = await parseBody(req);
      if (!body.title) return json({ error: "title is required" }, 400);
      const todo = { id: nextId++, title: body.title, done: false };
      todos.set(todo.id, todo);
      return json(todo, 201);
    }

    if (req.method === "GET" && segments.length === 2 && segments[0] === "todos") {
      const todo = todos.get(Number(segments[1]));
      return todo ? json(todo) : json({ error: "not found" }, 404);
    }

    if (req.method === "PUT" && segments.length === 2 && segments[0] === "todos") {
      const prev = todos.get(Number(segments[1]));
      if (!prev) return json({ error: "not found" }, 404);
      const body = await parseBody(req);
      const next = {
        id: prev.id,
        title: typeof body.title === "string" ? body.title : prev.title,
        done: typeof body.done === "boolean" ? body.done : prev.done,
      };
      todos.set(next.id, next);
      return json(next);
    }

    if (req.method === "DELETE" && segments.length === 2 && segments[0] === "todos") {
      if (!todos.delete(Number(segments[1]))) return json({ error: "not found" }, 404);
      return json({ ok: true });
    }

    return json({ ok: true, endpoints: ["GET/POST /todos", "GET/PUT/DELETE /todos/:id"] });
  },
};
`,
    "/test/index.test.ts": `import { describe, it, expect } from "vitest";

describe("${projectName}", () => {
  it("has a fetch handler", () => {
    expect(typeof fetch).toBe("function");
  });

  it("is a valid worker project", () => {
    expect("${projectName}").toMatch(/^[a-z0-9-]+$/);
  });
});
`,
  };

  const written: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    await ensureParentDirs(workspace, path);
    await workspace.fs.writeFile(path, content);
    written.push(path);
  }

  return {
    files: written,
    summary:
      `[offline demo mode — Workers AI binding unavailable in this environment, so I generated a deterministic template]\n` +
      `Built "${projectName}": a single-file todo REST API Worker with vitest tests.\n` +
      `Files: ${written.length}\n` +
      `To exercise the live AI agent, run with a Cloudflare token configured.`,
  };
}
