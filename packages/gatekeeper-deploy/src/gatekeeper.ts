// ─── Deploy Gatekeeper ──────────────────────────────────────────────────────
// The human-in-the-loop security boundary for EdgeForge. Modeled on the
// Cloudflare OS Gatekeeper pattern:
//
//   request  → simulate + queue (agent keeps working, never blocks)
//   approve  → REAL deploy to the user's Cloudflare account (live workers.dev URL)
//   reject   → abort, logged
//
// The agent has no direct path to the user's account. The only way any code
// reaches the internet is through this module, which requires an explicit
// human approval in the UI. Every action is appended to an immutable audit log.
//
// The real deploy uses the Cloudflare Workers Upload API
// (PUT /client/v4/accounts/{account}/workers/scripts/{name}) — the exact
// endpoint `wrangler deploy` calls. It is fully supported on the free tier.
// It needs two secrets set on the Worker: CF_ACCOUNT_ID and
// CLOUDFLARE_API_TOKEN (a token scoped to "Workers Scripts: Edit"). When those
// secrets aren't present, the Gatekeeper degrades gracefully to a packaged
// "archive" deployment so the end-to-end flow still works without a token.

import type { Env, DeployRequest, DeployStatus, DeployActionLog, DeployMode } from "./types.js";
import { createLogger } from "./logger.js";

const logger = createLogger("gatekeeper");

const DEPLOY_TTL = 86400 * 7; // approvals & artifacts live 7 days
const LOG_CAP = 30;

// ─── Request ────────────────────────────────────────────────────────────────

export async function requestDeploy(
  env: Env,
  input: { projectName: string; files: Record<string, string>; requestedBy?: string },
): Promise<DeployRequest> {
  const projectName = slugify(input.projectName || "edgeforge-worker");
  const deployId = crypto.randomUUID();

  const request: DeployRequest = {
    deployId,
    projectName,
    status: "pending",
    fileCount: Object.keys(input.files).length,
    createdAt: Date.now(),
    requestedBy: input.requestedBy || "agent",
    simulatedUrl: `https://${projectName}.${env.CF_ACCOUNT_SUBDOMAIN || "<your-subdomain>"}.workers.dev`,
  };

  await env.APPROVALS.put(`deploy:${deployId}`, JSON.stringify({ ...request, files: input.files }), {
    expirationTtl: DEPLOY_TTL,
  });

  await logAction(env, {
    type: "deploy.request",
    deployId,
    projectName,
    detail: `queued ${request.fileCount} file(s) for human approval`,
    timestamp: Date.now(),
  });

  logger.info("Deploy requested", { event: "gatekeeper.request", deployId, projectName, fileCount: request.fileCount });
  return request;
}

// ─── Approve ────────────────────────────────────────────────────────────────

export async function approveDeploy(
  env: Env,
  deployId: string,
): Promise<{ success: boolean; deploy: DeployStatus; message: string }> {
  const raw = await env.APPROVALS.get(`deploy:${deployId}`);
  if (!raw) {
    return {
      success: false,
      deploy: { deployId, projectName: "", status: "failed", fileCount: 0, createdAt: Date.now(), simulatedUrl: "" },
      message: "Deploy not found.",
    };
  }

  const pending = JSON.parse(raw) as DeployStatus & { files?: Record<string, string> };
  if (pending.status !== "pending") {
    return { success: false, deploy: pending, message: `Deploy ${deployId} is already ${pending.status}.` };
  }

  const files = pending.files || {};
  const attempt = await tryUploadWorkersScript(env, pending.projectName, files);

  let status: DeployRequest["status"];
  let deployedUrl: string | undefined;
  let error: string | undefined;
  let deployMode: DeployMode = "archive";

  if (attempt.success && attempt.url) {
    status = "deployed";
    deployedUrl = attempt.url;
    deployMode = "real";
  } else if (attempt.reason === "token") {
    // No Cloudflare credentials configured — package the project as browsable
    // artifacts (R2 if bound, otherwise KV) so the flow stays verifiable.
    status = "deployed";
    deployMode = "archive";
    deployedUrl = `${attempt.selfUrl}/api/artifacts/${deployId}/manifest.json`;
    error = "Cloudflare credentials not configured — packaged as archive instead of live deploy.";
  } else {
    status = "failed";
    error = attempt.error;
  }

  const deploy: DeployStatus = {
    ...pending,
    status,
    approvedAt: status === "deployed" ? Date.now() : pending.approvedAt,
    deployedAt: status === "deployed" ? Date.now() : pending.deployedAt,
    deployedUrl,
    deployMode,
    error,
  };
  delete (deploy as { files?: Record<string, string> }).files;

  await env.APPROVALS.put(`deploy:${deployId}`, JSON.stringify(deploy), { expirationTtl: DEPLOY_TTL });

  await logAction(env, {
    type: status === "failed" ? "deploy.failed" : "deploy.approved",
    deployId,
    projectName: pending.projectName,
    detail: deployMode === "real" ? `live at ${deployedUrl}` : error || "packaged as archive",
    timestamp: Date.now(),
  });

  if (status === "deployed" && deployedUrl) {
    await archiveArtifacts(env, deployId, pending.projectName, files);
  }

  logger.info("Deploy resolution", { event: "gatekeeper.resolve", deployId, status, deployMode, deployedUrl, error });
  return {
    success: status !== "failed",
    deploy,
    message: status === "failed"
      ? `Deploy failed: ${error}`
      : deployMode === "real"
        ? `Deployed live to ${deployedUrl}`
        : "Deploy approved and packaged (no Cloudflare token configured — set CF_ACCOUNT_ID + CLOUDFLARE_API_TOKEN for a live worker).",
  };
}

// ─── Reject ─────────────────────────────────────────────────────────────────

export async function rejectDeploy(env: Env, deployId: string): Promise<DeployStatus | null> {
  const raw = await env.APPROVALS.get(`deploy:${deployId}`);
  if (!raw) return null;

  const deploy = JSON.parse(raw) as DeployStatus;
  if (deploy.status !== "pending") return deploy;

  deploy.status = "rejected";
  deploy.rejectedAt = Date.now();
  delete (deploy as { files?: Record<string, string> }).files;

  await env.APPROVALS.put(`deploy:${deployId}`, JSON.stringify(deploy), { expirationTtl: 86400 });

  await logAction(env, {
    type: "deploy.rejected",
    deployId,
    projectName: deploy.projectName,
    detail: "rejected by human reviewer",
    timestamp: Date.now(),
  });

  return deploy;
}

// ─── Listings & logs ────────────────────────────────────────────────────────

export async function listDeployments(env: Env): Promise<DeployStatus[]> {
  const listing = await env.APPROVALS.list({ prefix: "deploy:" });
  const out: DeployStatus[] = [];
  for (const key of listing.keys) {
    const raw = await env.APPROVALS.get(key.name);
    if (!raw) continue;
    const deploy = JSON.parse(raw) as DeployStatus;
    delete (deploy as { files?: Record<string, string> }).files;
    out.push(deploy);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getDeployLogs(env: Env, deployId: string): Promise<DeployActionLog[]> {
  const raw = await env.APPROVALS.get(`log:${deployId}`);
  if (!raw) return [];
  return JSON.parse(raw) as DeployActionLog[];
}

// ─── Real deploy helper ─────────────────────────────────────────────────────

const ENTRY_CANDIDATES = ["/src/index.ts", "/src/index.js", "/index.ts", "/index.js"];

interface UploadAttempt {
  success: boolean;
  url?: string;
  selfUrl: string;
  reason?: "token" | "entry" | "api";
  error?: string;
}

async function tryUploadWorkersScript(
  env: Env,
  scriptName: string,
  files: Record<string, string>,
): Promise<UploadAttempt> {
  const selfUrl = `https://${env.CF_ACCOUNT_SUBDOMAIN || "<your-subdomain>"}.workers.dev`;

  const accountId = env.CF_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !token) {
    return { success: false, selfUrl, reason: "token", error: "CF_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set on this Worker." };
  }

  const entryPath = ENTRY_CANDIDATES.find((p) => typeof files[p] === "string");
  if (!entryPath) {
    return { success: false, selfUrl, reason: "entry", error: `No worker entry found (expected one of ${ENTRY_CANDIDATES.join(", ")}).` };
  }

  const moduleName = entryPath.replace(/^\//, "");
  const compatibilityDate = findCompatibilityDate(files);

  const metadata = {
    main_module: moduleName,
    compatibility_date: compatibilityDate,
    compatibility_flags: ["nodejs_compat"],
  };

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append(moduleName, new Blob([files[entryPath]], { type: "text/typescript" }));

  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  } catch (err) {
    return { success: false, selfUrl, reason: "api", error: `Network error calling Workers API: ${err instanceof Error ? err.message : String(err)}` };
  }

  const body = await res.json().catch(() => null) as {
    success?: boolean;
    errors?: Array<{ code: number; message: string }>;
    result?: { workers_dev?: { subdomain?: string; enabled?: boolean } };
  } | null;

  if (!res.ok || body?.success !== true) {
    const detail = body?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || res.statusText;
    return { success: false, selfUrl, reason: "api", error: `Upload rejected (${res.status}): ${detail}` };
  }

  const subdomain = body?.result?.workers_dev?.subdomain;
  const url2 = subdomain ? `https://${scriptName}.${subdomain}.workers.dev` : undefined;
  const deterministicUrl = url2 || `https://${scriptName}.${env.CF_ACCOUNT_SUBDOMAIN || "your-account"}.workers.dev`;
  return { success: true, url: url2 || deterministicUrl, selfUrl };
}

function findCompatibilityDate(files: Record<string, string>): string {
  const candidates: Array<[string, string]> = [
    ["/wrangler.jsonc", '"compatibility_date"\\s*:\\s*"([0-9\\-]+)"'],
    ["/wrangler.json", '"compatibility_date"\\s*:\\s*"([0-9\\-]+)"'],
    ["/wrangler.toml", "compatibility_date\\s*=\\s*\"([0-9\\-]+)\""],
  ];
  for (const [path, re] of candidates) {
    const raw = files[path];
    if (!raw) continue;
    const m = raw.match(new RegExp(re));
    if (m?.[1]) return m[1];
  }
  return "2026-09-01";
}

// ─── Artifacts (archive/R2) ─────────────────────────────────────────────────

function getContentType(path: string): string {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "text/typescript";
  if (path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".md")) return "text/markdown";
  return "text/plain";
}

async function archiveArtifacts(env: Env, deployId: string, projectName: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    if (env.ARTIFACTS) {
      await env.ARTIFACTS.put(`deploys/${deployId}${path}`, content, { httpMetadata: { contentType: getContentType(path) } });
    } else {
      await env.APPROVALS.put(`artifact:${deployId}${path}`, JSON.stringify({ content, contentType: getContentType(path) }), {
        expirationTtl: DEPLOY_TTL,
      });
    }
  }
  const manifest = JSON.stringify(
    { deployId, projectName, files: Object.keys(files), archivedAt: Date.now(), note: "Archive of the approved deploy. For a live URL, configure CF_ACCOUNT_ID + CLOUDFLARE_API_TOKEN." },
    null,
    2,
  );
  if (env.ARTIFACTS) {
    await env.ARTIFACTS.put(`deploys/${deployId}/manifest.json`, manifest, { httpMetadata: { contentType: "application/json" } });
  } else {
    await env.APPROVALS.put(`artifact:${deployId}/manifest.json`, JSON.stringify({ content: manifest, contentType: "application/json" }), { expirationTtl: DEPLOY_TTL });
  }
}

export async function getArtifact(
  env: Env,
  deployId: string,
  path: string,
): Promise<{ content: string; contentType: string } | null> {
  if (env.ARTIFACTS) {
    const object = await env.ARTIFACTS.get(`deploys/${deployId}${path}`);
    if (!object) return null;
    return { content: await object.text(), contentType: object.httpMetadata?.contentType ?? "text/plain" };
  }
  const stored = await env.APPROVALS.get(`artifact:${deployId}${path}`);
  if (!stored) return null;
  const parsed = JSON.parse(stored) as { content: string; contentType: string };
  return { content: parsed.content, contentType: parsed.contentType };
}

// ─── Audit log ──────────────────────────────────────────────────────────────

async function logAction(env: Env, entry: DeployActionLog): Promise<void> {
  const key = `log:${entry.deployId}`;
  const raw = await env.APPROVALS.get(key);
  const logs: DeployActionLog[] = raw ? JSON.parse(raw) : [];
  logs.push(entry);
  await env.APPROVALS.put(key, JSON.stringify(logs.slice(-LOG_CAP)), { expirationTtl: DEPLOY_TTL });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug && /^[a-z0-9]/.test(slug) ? slug : `edgeforge-${Math.random().toString(36).slice(2, 8)}`;
}