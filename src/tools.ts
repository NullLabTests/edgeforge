import type { Workspace } from "@cloudflare/computer";
import type { Env, ToolCall, ToolResult, ExecResult } from "./types.js";
import { simulateExec } from "./exec-sim.js";
import { requestDeploy as gatekeeperRequestDeploy } from "./gatekeeper.js";
import { ensureParentDirs } from "./fs-helpers.js";
import { createLogger } from "./logger.js";

const logger = createLogger("tools");

async function collectAllFiles(ws: Workspace, path: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const entries = await ws.fs.readdir(path);
  for (const entry of entries) {
    const fullPath = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
    if (entry.isDirectory) {
      Object.assign(files, await collectAllFiles(ws, fullPath));
    } else {
      try {
        files[fullPath] = await ws.fs.readFile(fullPath, "utf8") as string;
      } catch {
        // skip binary files
      }
    }
  }
  return files;
}

// ─── Tool Definitions for Workers AI ────────────────────────────────────────

export function getToolDefinitions(): unknown[] {
  return [
    {
      type: "function",
      function: {
        name: "write",
        description: "Write content to a file in the virtual filesystem",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path, e.g. 'src/index.ts'" },
            content: { type: "string", description: "Full file contents" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read",
        description: "Read a file from the virtual filesystem",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path to read" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit",
        description: "Edit a file by replacing an exact string match",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            oldContent: { type: "string", description: "Exact string to find" },
            newContent: { type: "string", description: "Replacement string" },
          },
          required: ["path", "oldContent", "newContent"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ls",
        description: "List files and directories at a path",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path, default '/'" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "find",
        description: "Find files matching a glob pattern",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern, e.g. '*.ts'" },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "grep",
        description: "Search file contents for a regex pattern",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regex pattern to search for" },
            path: { type: "string", description: "Directory to search in, default '/'" },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "delete",
        description: "Delete a file or directory",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File or directory path to delete" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "exec",
        description: "Execute a shell command in the sandbox. Returns stdout/stderr. Supports: npm install, npm test, npx wrangler deploy --dry-run, tsc, and basic shell commands.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to execute" },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "deploy",
        description: "Request deployment of the current project. Triggers async human approval — the deploy is simulated until the user approves.",
        parameters: {
          type: "object",
          properties: {
            projectName: { type: "string", description: "Name for the deployed Worker" },
          },
          required: ["projectName"],
        },
      },
    },
  ];
}

// ─── Tool Execution ─────────────────────────────────────────────────────────

export async function executeTool(
  call: ToolCall,
  workspace: Workspace,
  env: Env,
): Promise<ToolResult> {
  try {
    let content: string;

    switch (call.name) {
      case "write": {
        const path = call.arguments.path as string;
        const fileContent = call.arguments.content as string;
        await ensureParentDirs(workspace, path);
        await workspace.fs.writeFile(path, fileContent);
        content = JSON.stringify({ success: true, path, bytes: fileContent.length });
        break;
      }

      case "read": {
        const path = call.arguments.path as string;
        const data = await workspace.fs.readFile(path, "utf8");
        content = data as string;
        break;
      }

      case "edit": {
        const path = call.arguments.path as string;
        const oldContent = call.arguments.oldContent as string;
        const newContent = call.arguments.newContent as string;
        const existing = await workspace.fs.readFile(path, "utf8") as string;
        if (!existing.includes(oldContent)) {
          content = JSON.stringify({ success: false, error: "oldContent not found in file" });
        } else {
          const updated = existing.replace(oldContent, newContent);
          await workspace.fs.writeFile(path, updated);
          content = JSON.stringify({ success: true, path });
        }
        break;
      }

      case "ls": {
        const path = (call.arguments.path as string) || "/";
        const entries = await workspace.fs.readdir(path);
        const listing = entries.map(e => `${e.isDirectory ? "d" : "-"} ${e.name}`).join("\n");
        content = listing || "(empty directory)";
        break;
      }

      case "find": {
        const pattern = call.arguments.pattern as string;
        const results = await workspace.fs.find("/", pattern);
        const paths = (results as Array<{ path: string }>).map(f => f.path);
        content = paths.length > 0 ? paths.join("\n") : "(no matches)";
        break;
      }

      case "grep": {
        const pattern = call.arguments.pattern as string;
        const path = (call.arguments.path as string) || "/";
        const results = await workspace.fs.grep(pattern, path);
        const formatted = results.map(r => `${r.path}:${r.line}: ${r.text}`).join("\n");
        content = formatted || "(no matches)";
        break;
      }

      case "delete": {
        const path = call.arguments.path as string;
        await workspace.fs.rm(path, { recursive: true });
        content = JSON.stringify({ success: true, deleted: path });
        break;
      }

      case "exec": {
        const command = call.arguments.command as string;
        const result = await simulateExec(command, workspace);
        content = formatExecResult(result);
        break;
      }

      case "deploy": {
        const projectName = call.arguments.projectName as string || "my-worker";
        const files = await collectAllFiles(workspace, "/");
        const request = await gatekeeperRequestDeploy(env, { projectName, files, requestedBy: "agent" });
        const boot = request.bootTest;
        const bootSummary = !boot || boot.status === "skipped"
          ? "no live boot test run (no Cloudflare credentials on this deployment)."
          : boot.status === "pass"
            ? `LIVE BOOT TEST PASSED — preview URL ${boot.previewUrl} answered HTTP ${boot.httpStatus} in ${boot.latencyMs}ms.`
            : `LIVE BOOT TEST FAILED — the artifact was deployed to preview URL ${boot.previewUrl} but ${boot.error}. This is a REAL runtime failure. Fix the code, re-run tests via exec(), then call deploy() again.`;
        content = JSON.stringify({
          success: true,
          message: `Deploy request ${request.deployId} queued for user approval. ${bootSummary} The agent keeps working; the deploy is applied only after a human approves in the UI.`,
          deployId: request.deployId,
          projectName: request.projectName,
          fileCount: request.fileCount,
          simulatedUrl: request.simulatedUrl,
          bootTest: boot,
        });
        break;
      }

      default:
        content = JSON.stringify({ error: `Unknown tool: ${call.name}` });
    }

    return { toolCallId: call.id, content };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { toolCallId: call.id, content: JSON.stringify({ error: message }), isError: true };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatExecResult(result: ExecResult): string {
  const parts: string[] = [];
  if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
  if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
  parts.push(`exit code: ${result.exitCode}`);
  return parts.join("\n\n");
}
