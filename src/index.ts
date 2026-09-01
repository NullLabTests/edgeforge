import { Hono } from "hono";
import { cors } from "hono/cors";
import { WorkspaceDO } from "./workspace.js";
import type { Env } from "./types.js";
import { createLogger } from "./logger.js";

const logger = createLogger("worker");

// ─── Hono App ───────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors());

// ─── Health Check ───────────────────────────────────────────────────────────

app.get("/api/health", (c) => {
  return c.json({ status: "ok", version: "0.1.0" });
});

// ─── Workspace API ──────────────────────────────────────────────────────────

// Get or create workspace DO stub
type WorkspaceStub = DurableObjectStub<InstanceType<typeof WorkspaceDO>>;
function getWorkspaceStub(env: Env, userId: string = "default"): WorkspaceStub {
  const id = env.WORKSPACE.idFromName(`workspace:${userId}`);
  return env.WORKSPACE.get(id) as WorkspaceStub;
}

// ─── Artifact Storage ────────────────────────────────────────────────────────
// Deploy artifacts normally live in R2. When the account hasn't enabled R2 yet
// (free-tier opt-in), fall back to KV so the demo still works end-to-end.

async function storeArtifact(
  env: Env,
  deployId: string,
  path: string,
  content: string,
  contentType: string,
): Promise<void> {
  if (env.ARTIFACTS) {
    await env.ARTIFACTS.put(`deploys/${deployId}${path}`, content, {
      httpMetadata: { contentType },
    });
  } else {
    await env.APPROVALS.put(
      `artifact:${deployId}${path}`,
      JSON.stringify({ content, contentType }),
      { expirationTtl: 86400 * 7 },
    );
  }
}

async function getArtifact(
  env: Env,
  deployId: string,
  path: string,
): Promise<{ content: string; contentType: string } | null> {
  if (env.ARTIFACTS) {
    const object = await env.ARTIFACTS.get(`deploys/${deployId}${path}`);
    if (!object) return null;
    return { content: await object.text(), contentType: object.httpMetadata?.contentType ?? "application/octet-stream" };
  }
  const stored = await env.APPROVALS.get(`artifact:${deployId}${path}`);
  if (!stored) return null;
  const parsed = JSON.parse(stored) as { content: string; contentType: string };
  return { content: parsed.content, contentType: parsed.contentType };
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
  const result = await ws.runAgentLoop(prompt);

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

// ─── Deploy Gatekeeper API ──────────────────────────────────────────────────

// Request deploy
app.post("/api/deploy", async (c) => {
  const body = await c.req.json<{ projectName: string; userId?: string }>();
  const { projectName, userId = "default" } = body;

  if (!projectName) {
    return c.json({ error: "projectName is required" }, 400);
  }

  const ws = getWorkspaceStub(c.env, userId);
  const request = await ws.requestDeploy(projectName);

  logger.info("Deploy requested", { event: "deploy.request", deployId: request.deployId, projectName });

  return c.json(request);
});

// List pending approvals
app.get("/api/approvals/:userId?", async (c) => {
  const userId = c.req.param("userId") || "default";
  const ws = getWorkspaceStub(c.env, userId);
  const deployments = await ws.listDeployments();
  return c.json(deployments);
});

// Approve deploy
app.post("/api/approvals/:deployId/approve", async (c) => {
  const deployId = c.req.param("deployId");
  const data = await c.env.APPROVALS.get(`deploy:${deployId}`);

  if (!data) {
    return c.json({ error: "Deploy not found" }, 404);
  }

  const deploy = JSON.parse(data);
  deploy.status = "approved";
  deploy.approvedAt = Date.now();

  // "Deploy" by packaging files to artifacts storage (R2, or KV on free tier)
  const files = deploy.files as Record<string, string>;
  const projectName = deploy.projectName;

  for (const [path, content] of Object.entries(files)) {
    await storeArtifact(c.env, deployId, path, content, getContentType(path));
  }

  // Create a manifest
  const manifest = {
    deployId,
    projectName,
    files: Object.keys(files),
    deployedAt: Date.now(),
    url: `https://${projectName}.devforge.workers.dev`,
  };

  await storeArtifact(c.env, deployId, "/manifest.json", JSON.stringify(manifest, null, 2), "application/json");

  deploy.status = "deployed";
  deploy.deployedAt = Date.now();
  deploy.deployedUrl = manifest.url;

  await c.env.APPROVALS.put(`deploy:${deployId}`, JSON.stringify(deploy), {
    expirationTtl: 86400 * 7, // 7 days
  });

  logger.info("Deploy approved and executed", { event: "deploy.approved", deployId, url: manifest.url });

  return c.json({ success: true, url: manifest.url });
});

// Reject deploy
app.post("/api/approvals/:deployId/reject", async (c) => {
  const deployId = c.req.param("deployId");
  const data = await c.env.APPROVALS.get(`deploy:${deployId}`);

  if (!data) {
    return c.json({ error: "Deploy not found" }, 404);
  }

  const deploy = JSON.parse(data);
  deploy.status = "rejected";
  deploy.rejectedAt = Date.now();

  await c.env.APPROVALS.put(`deploy:${deployId}`, JSON.stringify(deploy), {
    expirationTtl: 86400,
  });

  logger.info("Deploy rejected", { event: "deploy.rejected", deployId });

  return c.json({ success: true });
});

// Get deployed artifact
app.get("/api/artifacts/:deployId/*", async (c) => {
  const deployId = c.req.param("deployId");
  const path = "/" + c.req.path.replace(`/api/artifacts/${deployId}/`, "");
  const artifact = await getArtifact(c.env, deployId, path);

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

  return c.json({ error: "Not found" }, 404);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function getContentType(path: string): string {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "text/typescript";
  if (path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".md")) return "text/markdown";
  return "text/plain";
}

// ─── Export ─────────────────────────────────────────────────────────────────

export default app;

// Re-export the Durable Object class
export { WorkspaceDO } from "./workspace.js";
