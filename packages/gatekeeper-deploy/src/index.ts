import { Hono } from "hono";
import { cors } from "hono/cors";
import * as gatekeeper from "./gatekeeper.js";
import type { Env } from "./types.js";
import { createLogger } from "./logger.js";

const logger = createLogger("gatekeeper-service");

// ─── Standalone Deploy Gatekeeper ───────────────────────────────────────────
// Deployed as its OWN Worker (separate from the EdgeForge platform worker),
// this service is the only thing with credentials to write to the user's
// Cloudflare account. The platform worker talks to it over a service binding,
// or you can call /rpc/* directly. The pattern is identical to how Cloudflare
// OS ships its Gatekeepers.

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors());

app.get("/rpc/health", (c) => c.json({ status: "ok", service: "gatekeeper-deploy" }));

app.post("/rpc/request-deploy", async (c) => {
  const body = await c.req.json<{ projectName: string; files: Record<string, string>; requestedBy?: string }>();
  if (!body.projectName || !body.files) return c.json({ error: "projectName and files are required" }, 400);
  const request = await gatekeeper.requestDeploy(c.env, {
    projectName: body.projectName,
    files: body.files,
    requestedBy: body.requestedBy,
  });
  logger.info("rpc request-deploy", { event: "gatekeeper.rpc.request", deployId: request.deployId });
  return c.json(request);
});

app.post("/rpc/approve-deploy", async (c) => {
  const { deployId } = await c.req.json<{ deployId: string }>();
  if (!deployId) return c.json({ error: "deployId is required" }, 400);
  const result = await gatekeeper.approveDeploy(c.env, deployId);
  return c.json({ success: result.success, message: result.message, deploy: result.deploy });
});

app.post("/rpc/reject-deploy", async (c) => {
  const { deployId } = await c.req.json<{ deployId: string }>();
  if (!deployId) return c.json({ error: "deployId is required" }, 400);
  const deploy = await gatekeeper.rejectDeploy(c.env, deployId);
  return deploy ? c.json({ success: true, deploy }) : c.json({ error: "Deploy not found" }, 404);
});

app.get("/rpc/list", async (c) => c.json(await gatekeeper.listDeployments(c.env)));

app.get("/rpc/logs/:deployId", async (c) => {
  const logs = await gatekeeper.getDeployLogs(c.env, c.req.param("deployId"));
  return c.json(logs);
});

app.get("/rpc/artifacts/:deployId/*", async (c) => {
  const deployId = c.req.param("deployId");
  const path = "/" + c.req.path.replace(`/rpc/artifacts/${deployId}/`, "");
  const artifact = await gatekeeper.getArtifact(c.env, deployId, path);
  if (!artifact) return c.json({ error: "Not found" }, 404);
  return new Response(artifact.content, { headers: { "content-type": artifact.contentType } });
});

export default app;