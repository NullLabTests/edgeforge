import { describe, it, expect } from "vitest";
import { recordAgentRun, getAnalytics, getRecentRuns } from "../src/analytics.js";

class MemoryKV {
  store = new Map<string, string>();
  async get(key: string) { return this.store.get(key) ?? null; }
  async put(key: string, value: string) { this.store.set(key, value); }
}

function makeKV(): KVNamespace {
  return new MemoryKV() as unknown as KVNamespace;
}

describe("analytics", () => {
  it("records runs and exposes rollups + totals", async () => {
    const kv = makeKV();

    await recordAgentRun(kv, {
      userId: "a", model: "granite", status: "complete", promptLength: 10,
      iterations: 3, neuronsUsed: 45, filesWritten: ["/src/index.js"],
      durationMs: 5000, startedAt: Date.now(),
    });
    await recordAgentRun(kv, {
      userId: "a", model: "qwen", status: "complete", promptLength: 20,
      iterations: 2, neuronsUsed: 60, filesWritten: ["/a.js", "/b.js"],
      durationMs: 8000, startedAt: Date.now(),
    });

    const snap = await getAnalytics(kv, 7);
    expect(snap.recentRuns.length).toBe(2);
    expect(snap.totals.runs).toBe(2);
    expect(snap.totals.neuronsUsed).toBe(105);
    expect(snap.totals.filesWritten).toBe(3);
    expect(snap.modelBreakdown.granite.runs).toBe(1);
    expect(snap.modelBreakdown.qwen.runs).toBe(1);
    expect(snap.recentRuns[0].neuronsUsed).toBe(60); // newest first
  });

  it("caps the recent ring and returns empty when nothing recorded", async () => {
    const kv = makeKV();
    expect(await getRecentRuns(kv)).toEqual([]);

    for (let i = 0; i < 60; i++) {
      await recordAgentRun(kv, {
        userId: "a", status: "complete", promptLength: 1,
        iterations: 1, neuronsUsed: 1, filesWritten: [], durationMs: 10,
      });
    }
    const runs = await getRecentRuns(kv);
    expect(runs.length).toBe(50);
  });
});
