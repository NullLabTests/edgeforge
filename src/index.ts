import { Hono } from "hono";
import { cors } from "hono/cors";
import { WorkspaceDO } from "./workspace.js";
import type { Env } from "./types.js";
import { createLogger } from "./logger.js";
import * as gatekeeper from "./gatekeeper.js";
import * as analytics from "./analytics.js";
import { getNeuronBudget, rolloverBudget } from "./budget.js";

const logger = createLogger("worker");

// ─── Hono App ───────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors());

// ─── Health Check ───────────────────────────────────────────────────────────

app.get("/api/health", (c) => {
  return c.json({ status: "ok", version: "0.2.0", name: "edgeforge" });
});

// ─── Workspace API ──────────────────────────────────────────────────────────

// Get or create workspace DO stub
type WorkspaceStub = DurableObjectStub<InstanceType<typeof WorkspaceDO>>;
function getWorkspaceStub(env: Env, userId: string = "default"): WorkspaceStub {
  const id = env.WORKSPACE.idFromName(`workspace:${userId}`);
  return env.WORKSPACE.get(id) as WorkspaceStub;
}

// Chat: send a prompt and get agent response
app.post("/api/chat", async (c) => {
  const body = await c.req.json<{ prompt: string; userId?: string }>();
  const { prompt, userId = "default" } = body;

  if (!prompt) {
    return c.json({ error: "prompt is required" }, 400);
  }

  logger.info("Chat request received", { event: "chat.request", userId, promptLength: prompt.length });

  const ws = getWorkspaceStub(c.env, userId);
  const startedAt = Date.now();
  const result = await ws.runAgentLoop(prompt);

  await analytics.recordAgentRun(c.env.BUDGET, {
    userId,
    model: c.env.MODEL || "@cf/ibm-granite/granite-4.0-h-micro",
    status: result.status,
    promptLength: prompt.length,
    iterations: result.iterations,
    neuronsUsed: result.neuronsUsed,
    filesWritten: result.filesWritten,
    durationMs: Date.now() - startedAt,
    startedAt,
  });

  logger.info("Agent completed", { event: "chat.complete", status: result.status, iterations: result.iterations });

  return c.json(result);
});

// File tree
app.get("/api/files/:userId?", async (c) => {
  const userId = c.req.param("userId") || "default";
  const ws = getWorkspaceStub(c.env, userId);
  const tree = await ws.getFileTree();
  return c.json(tree);
});

// Read file
app.get("/api/file/*", async (c) => {
  const path = "/" + c.req.path.replace("/api/file/", "");
  const userId = c.req.query("userId") || "default";
  const ws = getWorkspaceStub(c.env, userId);
  try {
    const content = await ws.readFile(path);
    return c.json({ path, content });
  } catch (e) {
    return c.json({ error: "File not found" }, 404);
  }
});

// ─── AI Budget ──────────────────────────────────────────────────────────────

app.get("/api/budget", async (c) => {
  const budget = await getNeuronBudget(c.env.BUDGET);
  return c.json(budget);
});

// Daily rollover history (the cron trigger at midnight UTC archives each day's
// spend; see rolloverBudget in src/budget.ts and [triggers] in wrangler.toml).
app.get("/api/budget/history", async (c) => {
  return c.json(await rolloverBudget(c.env.BUDGET));
});

// ─── Agent Analytics ────────────────────────────────────────────────────────
// Real per-task observability: neurons burned, iterations, files written,
// duration latency, and per-day / per-model rollups (see src/analytics.ts).

app.get("/api/analytics", async (c) => {
  const days = Math.min(Math.max(parseInt(c.req.query("days") || "7", 10) || 7, 1), 30);
  return c.json(await analytics.getAnalytics(c.env.BUDGET, days));
});

// ─── Deploy Gatekeeper API ──────────────────────────────────────────────────
// This is the human-in-the-loop security boundary. The agent can only REQUEST
// deploys; applying one requires an explicit approval from this API, which no
// agent prompt can reach. See src/gatekeeper.ts.

// Request deploy
app.post("/api/deploy", async (c) => {
  const body = await c.req.json<{ projectName: string; userId?: string }>();
  const { projectName, userId = "default" } = body;

  if (!projectName) {
    return c.json({ error: "projectName is required" }, 400);
  }

  const ws = getWorkspaceStub(c.env, userId);
  const fileTree = await ws.getFileTree();
  const files = await collectFilesFromTree(c.env, userId, fileTree);

  const request = await gatekeeper.requestDeploy(c.env, { projectName, files, requestedBy: userId });

  logger.info("Deploy requested", { event: "deploy.request", deployId: request.deployId, projectName });

  return c.json(request);
});

// List pending deployments
app.get("/api/approvals/:userId?", async (c) => {
  const deployments = await gatekeeper.listDeployments(c.env);
  return c.json(deployments);
});

// Approve deploy → real upload to the account's free tier when configured
app.post("/api/approvals/:deployId/approve", async (c) => {
  const deployId = c.req.param("deployId");
  const result = await gatekeeper.approveDeploy(c.env, deployId);

  if (!result.success && result.deploy.status === "failed") {
    logger.warn("Deploy approval failed", { event: "deploy.approve.failed", deployId, error: result.message });
  } else {
    logger.info("Deploy approved", { event: "deploy.approved", deployId, url: result.deploy.deployedUrl, mode: result.deploy.deployMode });
  }

  return c.json({ success: result.success, message: result.message, deploy: result.deploy });
});

// Reject deploy
app.post("/api/approvals/:deployId/reject", async (c) => {
  const deployId = c.req.param("deployId");
  const deploy = await gatekeeper.rejectDeploy(c.env, deployId);

  if (!deploy) {
    return c.json({ error: "Deploy not found" }, 404);
  }

  logger.info("Deploy rejected", { event: "deploy.rejected", deployId });
  return c.json({ success: true, deploy });
});

// Deploy audit log
app.get("/api/approvals/:deployId/logs", async (c) => {
  const deployId = c.req.param("deployId");
  const logs = await gatekeeper.getDeployLogs(c.env, deployId);
  return c.json(logs);
});

// Deploy code review: the exact file contents the agent generated for this
// deploy, with a per-file verification verdict. This is what the human reviews
// before approving — inspectable through the API and shown in the UI.
app.get("/api/approvals/:deployId/files", async (c) => {
  const deployId = c.req.param("deployId");
  const review = await gatekeeper.getDeployReview(c.env, deployId);
  if (!review) {
    return c.json({ error: "Deploy not found" }, 404);
  }
  return c.json(review);
});

// Get deployed artifact (archive mode)
app.get("/api/artifacts/:deployId/*", async (c) => {
  const deployId = c.req.param("deployId");
  const path = "/" + c.req.path.replace(`/api/artifacts/${deployId}/`, "");
  const artifact = await gatekeeper.getArtifact(c.env, deployId, path);

  if (!artifact) {
    return c.json({ error: "Not found" }, 404);
  }

  return new Response(artifact.content, {
    headers: { "content-type": artifact.contentType },
  });
});

// ─── Static Assets ──────────────────────────────────────────────────────────

app.get("/*", async (c) => {
  // Try to serve static assets (frontend)
  try {
    const response = await c.env.ASSETS.fetch(c.req.raw);
    if (response.status !== 404) return response;
  } catch {
    // No assets binding or error
  }

  // Fall back to a module redirect for the assets binding without a shell page
  return c.json({ error: "Not found" }, 404);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: TreeNode[];
}

async function collectFilesFromTree(env: Env, userId: string, tree: TreeNode[], out: Record<string, string> = {}): Promise<Record<string, string>> {
  const ws = getWorkspaceStub(env, userId);
  for (const node of tree) {
    if (node.isDirectory && node.children) {
      await collectFilesFromTree(env, userId, node.children, out);
    } else if (!node.isDirectory) {
      try {
        out[node.path] = await ws.readFile(node.path);
      } catch {
        // skip binary/undecodable files
      }
    }
  }
  return out;
}

// ─── Export ─────────────────────────────────────────────────────────────────

// The module entry also listens for the Cron Trigger (wrangler.toml [triggers]):
// every midnight UTC it archives the previous day's neuron spend into the
// budget history ledger, so the free-tier 10K/day counter restarts clean.
export default {
  fetch: app.fetch,
  scheduled: async (_controller: ScheduledController, env: Env, _ctx: ExecutionContext) => {
    logger.info("Budget rollover triggered", { event: "scheduled.rollover" });
    const history = await rolloverBudget(env.BUDGET);
    logger.info("Budget rollover complete", { event: "scheduled.rollover.done", archivedDays: history.length });
  },
};

// Re-export the Durable Object class
export { WorkspaceDO } from "./workspace.js";