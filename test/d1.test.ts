import { describe, it, expect, vi } from "vitest";
import { provisionGadgetD1, bindGadgetD1 } from "../src/d1.js";

function makeEnv(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    CF_ACCOUNT_ID: "acct",
    CLOUDFLARE_API_TOKEN: "token",
    ...overrides,
  };
}

describe("provisionGadgetD1", () => {
  it("returns null without credentials", async () => {
    expect(await provisionGadgetD1({} as never, "todo")).toBeNull();
  });

  it("reuses an existing database by name", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ success: true, result: [{ uuid: "existing-1", name: "gadget-todo" }] }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const db = await provisionGadgetD1(makeEnv(), "todo");
      expect(db).toEqual({ databaseId: "existing-1", databaseName: "gadget-todo" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("creates a new database when none exists", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { name?: string };
      return new Response(
        JSON.stringify({ success: true, result: { uuid: "fresh-9", name: body.name || "gadget" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const db = await provisionGadgetD1(makeEnv(), "Hello World!");
      expect(db).toEqual({ databaseId: "fresh-9", databaseName: "gadget-hello-world" });
      // list first, then create
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("tolerates API failures and returns null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    try {
      expect(await provisionGadgetD1(makeEnv(), "todo")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("bindGadgetD1", () => {
  it("PATCHes the g1 binding onto the script", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const ok = await bindGadgetD1(makeEnv(), "todo-prod", { databaseId: "db-1", databaseName: "gadget-todo" });
      expect(ok).toBe(true);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/workers/scripts/todo-prod/settings");
      expect(init.method).toBe("PATCH");
      const body = JSON.parse(String(init.body)) as { bindings: Array<{ name: string; type: string; id: string }> };
      expect(body.bindings).toEqual([{ name: "GADGET_DB", type: "d1", id: "db-1" }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("is false without credentials or on failure", async () => {
    expect(await bindGadgetD1({} as never, "todo", { databaseId: "db-1", databaseName: "gadget" })).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    try {
      expect(await bindGadgetD1(makeEnv(), "todo-prod", { databaseId: "db-1", databaseName: "gadget" })).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});