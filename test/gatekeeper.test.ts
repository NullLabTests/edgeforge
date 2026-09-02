import { describe, it, expect } from "vitest";
import { requestDeploy, approveDeploy, rejectDeploy, listDeployments, slugify, getDeployReview } from "../src/gatekeeper.js";
import type { Env } from "../src/types.js";

// ─── In-memory KV mock ───────────────────────────────────────────────────────

class MemoryKV {
  store = new Map<string, string>();
  async get(key: string) { return this.store.get(key) ?? null; }
  async put(key: string, value: string) { this.store.set(key, value); }
  async list({ prefix = "" }: { prefix?: string } = {}) {
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix));
    return { keys: keys.map((name) => ({ name })) };
  }
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  const approvvals = new MemoryKV();
  const budget = new MemoryKV();
  return {
    WORKSPACE: {} as DurableObjectNamespace,
    AI: {} as Ai,
    APPROVALS: approvvals as unknown as KVNamespace,
    BUDGET: budget as unknown as KVNamespace,
    ASSETS: {} as Env["ASSETS"],
    ...overrides,
    APPROVALS: (overrides.APPROVALS ?? approvvals) as unknown as KVNamespace,
    BUDGET: (overrides.BUDGET ?? budget) as unknown as KVNamespace,
  };
}

async function kvGet(env: Env, key: string): Promise<string | null> {
  return (env.APPROVALS as unknown as MemoryKV).get(key);
}

const SAMPLE_FILES = {
  "/src/index.ts": `export default { fetch() { return new Response("hello"); } };`,
  "/wrangler.toml": `name = "hello"\ncompatibility_date = "2026-09-01"\n`,
  "/test/index.test.ts": `import { expect } from "vitest"; it("ok", () => expect(true).toBe(true));`,
};

// ─── slugify ─────────────────────────────────────────────────────────────────

describe("slugify", () => {
  it("lowercases and normalizes", () => {
    expect(slugify("My Cool Worker!")).toBe("my-cool-worker");
  });
  it("fallbacks to a random slug when empty", () => {
    expect(slugify("")).toMatch(/^edgeforge-/);
  });
  it("caps length and trims dashes", () => {
    expect(slugify("-----a-----")).toBe("a");
    expect(slugify("a".repeat(500)).length).toBeLessThanOrEqual(40);
  });
});

// ─── requestDeploy ───────────────────────────────────────────────────────────

describe("requestDeploy", () => {
  it("stores a pending deploy with an audit log", async () => {
    const env = makeEnv();
    const request = await requestDeploy(env, { projectName: "todo-api", files: SAMPLE_FILES });

    expect(request.status).toBe("pending");
    expect(request.fileCount).toBe(3);
    expect(request.simulatedUrl).toContain("todo-api");

    const stored = JSON.parse((await kvGet(env, "deploy:" + request.deployId))!);
    expect(stored.files).toBeDefined();
    expect(Object.keys(stored.files).length).toBe(3);

    const logs = JSON.parse((await kvGet(env, "log:" + request.deployId))!);
    expect(logs[0].type).toBe("deploy.request");
  });

  it("sanitizes projectName into a valid script name", async () => {
    const env = makeEnv();
    const request = await requestDeploy(env, { projectName: "My Todo API!!", files: SAMPLE_FILES });
    expect(request.projectName).toBe("my-todo-api");
  });
});

// ─── approveDeploy without credentials → archive mode ────────────────────────

describe("approveDeploy", () => {
  it("packages an archive when Cloudflare credentials are absent", async () => {
    const env = makeEnv();
    const request = await requestDeploy(env, { projectName: "hello-world", files: SAMPLE_FILES });
    const result = await approveDeploy(env, request.deployId);

    expect(result.success).toBe(true);
    expect(result.deploy.status).toBe("deployed");
    expect(result.deploy.deployMode).toBe("archive");
    expect(result.deploy.deployedUrl).toContain(`/api/artifacts/${request.deployId}/manifest.json`);

    const manifest = await kvGet(env, `artifact:${request.deployId}/manifest.json`);
    expect(manifest).toBeTruthy();
    expect(JSON.parse(manifest!).content).toContain("hello-world");
  });

  it("refuses to approve twice", async () => {
    const env = makeEnv();
    const request = await requestDeploy(env, { projectName: "once", files: SAMPLE_FILES });
    await approveDeploy(env, request.deployId);
    const again = await approveDeploy(env, request.deployId);
    expect(again.success).toBe(false);
  });

  it("marks failed when there is no worker entry", async () => {
    const env = makeEnv({ CF_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "token" });
    const request = await requestDeploy(env, { projectName: "no-entry", files: { "/notes.txt": "hi" } });
    const result = await approveDeploy(env, request.deployId);
    expect(result.success).toBe(false);
    expect(result.deploy.status).toBe("failed");
    expect(result.deploy.error).toMatch(/worker entry/i);
  });
});

// ─── rejectDeploy & listDeployments ──────────────────────────────────────────

describe("rejectDeploy & listDeployments", () => {
  it("rejects a pending deploy and logs it", async () => {
    const env = makeEnv();
    const request = await requestDeploy(env, { projectName: "decline", files: SAMPLE_FILES });
    const rejected = await rejectDeploy(env, request.deployId);

    expect(rejected?.status).toBe("rejected");
    expect(rejected?.rejectedAt).toBeTypeOf("number");

    const logs = JSON.parse((await kvGet(env, "log:" + request.deployId))!);
    expect(logs.some((l: { type: string }) => l.type === "deploy.rejected")).toBe(true);
  });

  it("lists deployments newest first without file payloads", async () => {
    const env = makeEnv();
    const a = await requestDeploy(env, { projectName: "first", files: SAMPLE_FILES });
    const b = await requestDeploy(env, { projectName: "second", files: SAMPLE_FILES });

    // Make b newest by mutating its createdAt
    const rawB = JSON.parse((await kvGet(env, "deploy:" + b.deployId))!);
    rawB.createdAt = Date.now() + 1000;
    (env.APPROVALS as unknown as MemoryKV).store.set("deploy:" + b.deployId, JSON.stringify(rawB));

    const list = await listDeployments(env);
    expect(list.map((d) => d.deployId)).toEqual([b.deployId, a.deployId]);
    expect((list[0] as Record<string, unknown>).files).toBeUndefined();
  });

  it("round-trips through archive artifacts", async () => {
    const env = makeEnv();
    const request = await requestDeploy(env, { projectName: "roundtrip", files: SAMPLE_FILES });
    const result = await approveDeploy(env, request.deployId);
    const dir = result.deploy.deployedUrl!.split("/api/artifacts/")[1]!.split("/")[0];
    const src = await kvGet(env, `artifact:${dir}/src/index.ts`);
    expect(src).toBeDefined();
    expect(JSON.parse(src!).content).toContain('"hello"');
  });
});

// ─── getDeployReview ─────────────────────────────────────────────────────────

describe("getDeployReview", () => {
  it("returns per-file content with verification and flags a broken entry", async () => {
    const env = makeEnv();
    const files = {
      "/src/index.js": `export default { async fetch() { return new Response("hi"); } };`,
      "/notes.txt": "unbalanced {{ braces",
    };
    const request = await requestDeploy(env, { projectName: "review", files });
    const review = await getDeployReview(env, request.deployId);

    expect(review).not.toBeNull();
    expect(review!.files.length).toBe(2);
    const entry = review!.files.find((f) => f.path === "/src/index.js");
    expect(entry?.isEntry).toBe(true);
    expect(entry?.verified).toBe(true);
    expect(review!.passes).toBe(1);
    expect(review!.fails).toBe(1);
  });

  it("returns null for a nonexistent deploy", async () => {
    const env = makeEnv();
    expect(await getDeployReview(env, "nope")).toBeNull();
  });
});