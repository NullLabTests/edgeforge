// ─── Gadget D1 provisioner ───────────────────────────────────────────────────
// Grants each deployed gadget REAL state: a private D1 database bound to it as
// `GADGET_DB`. D1's free tier (5M reads / 100K writes / 5GB per day) needs no
// card, so this stays on the free plan. Provisioning and binding happen inside
// the Gatekeeper at promote time; every step is best-effort and degrades to
// "archive keep-alive state" when the account has no credentials.

import type { Env, GadgetD1 } from "./types.js";

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "gadget"
  );
}

function accountEnv(env: Env): { accountId: string; token: string } | null {
  if (!env.CF_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) return null;
  return { accountId: env.CF_ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN };
}

/** Find (or create) a dedicated D1 database for the gadget. Never throws. */
export async function provisionGadgetD1(env: Env, projectName: string): Promise<GadgetD1 | null> {
  const creds = accountEnv(env);
  if (!creds) return null;

  const dbName = `gadget-${slugify(projectName)}`;
  const headers = { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" };
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(creds.accountId)}/d1/database`;

  try {
    // Reuse an existing database with the same name so re-deploys keep state.
    const listRes = await fetch(`${base}?name=${encodeURIComponent(dbName)}`, { headers });
    if (listRes.ok) {
      const list = (await listRes.json()) as { result?: Array<{ uuid: string; name: string }> };
      const existing = list.result?.find((d) => d.name === dbName);
      if (existing) return { databaseId: existing.uuid, databaseName: existing.name };
    }
  } catch {
    // fall through to create
  }

  try {
    const createRes = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: dbName }),
    });
    if (!createRes.ok) return null;
    const create = (await createRes.json()) as { result?: { uuid?: string; name?: string } };
    if (!create.result?.uuid) return null;
    return { databaseId: create.result.uuid, databaseName: create.result.name || dbName };
  } catch {
    return null;
  }
}

/** Bind the D1 database to a live script as `GADGET_DB`. Never throws. */
export async function bindGadgetD1(env: Env, scriptName: string, d1: GadgetD1): Promise<boolean> {
  const creds = accountEnv(env);
  if (!creds) return false;

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(creds.accountId)}/workers/scripts/${encodeURIComponent(scriptName)}/settings`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          bindings: [{ name: "GADGET_DB", type: "d1", id: d1.databaseId }],
        }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}