import { describe, it, expect } from "vitest";
import { getNeuronBudget, addNeuronsUsedToday, canRunTask, estimateTaskNeurons, rolloverBudget, getBudgetHistory } from "../src/budget.js";

class MemoryKV {
  store = new Map<string, string>();
  async get(key: string) { return this.store.get(key) ?? null; }
  async put(key: string, value: string) { this.store.set(key, value); }
  async delete(key: string) { this.store.delete(key); }
  async list({ prefix = "" }: { prefix?: string } = {}) {
    return { keys: [...this.store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
  }
}

describe("neuron budget", () => {
  it("starts at zero used", async () => {
    const kv = new MemoryKV() as unknown as KVNamespace;
    const budget = await getNeuronBudget(kv);
    expect(budget.used).toBe(0);
    expect(budget.remaining).toBe(9500); // 10,000 minus 500 reserve
    expect(budget.limit).toBe(10_000);
  });

  it("accumulates usage across calls", async () => {
    const kv = new MemoryKV() as unknown as KVNamespace;
    await addNeuronsUsedToday(kv, 340);
    await addNeuronsUsedToday(kv, 120);
    const budget = await getNeuronBudget(kv);
    expect(budget.used).toBe(460);
    expect(budget.remaining).toBe(9500 - 460);
  });

  it("ignores negative amounts and Non-zero math stays sane", async () => {
    const kv = new MemoryKV() as unknown as KVNamespace;
    const before = await getNeuronBudget(kv);
    await addNeuronsUsedToday(kv, -50);
    const after = await getNeuronBudget(kv);
    expect(after.used).toBe(before.used);
  });

  it("canRunTask is true with a fresh budget", async () => {
    const kv = new MemoryKV() as unknown as KVNamespace;
    expect(await canRunTask(kv, 20)).toBe(true);
  });

  it("canRunTask is false when the daily budget is exhausted", async () => {
    const kv = new MemoryKV() as unknown as KVNamespace;
    await addNeuronsUsedToday(kv, 9600);
    expect(await canRunTask(kv, 20)).toBe(false);
  });

  it("estimateTaskNeurons is positive and proportional", async () => {
    const small = estimateTaskNeurons(5);
    const large = estimateTaskNeurons(20);
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
  });
});

describe("daily rollover", () => {
  it("archives past days and clears them, keeping today's counter", async () => {
    const kv = new MemoryKV() as unknown as KVNamespace;
    const yesterday = new Date("2026-09-01T01:00:00Z");
    const today = new Date("2026-09-02T01:00:00Z");

    // simulate usage from a previous write
    await kv.put("budget:2026-09-01", "4200");
    await kv.put("budget:2026-09-02", "150");

    const history = await rolloverBudget(kv, today);
    expect(history).toContainEqual({ date: "2026-09-01", used: 4200, limit: 10_000 });
    expect(await getBudgetHistory(kv)).toHaveLength(1);
    expect(await kv.get("budget:2026-09-01")).toBeNull();
    expect(await kv.get("budget:2026-09-02")).toBe("150");
  });

  it("does not touch history when nothing is stale", async () => {
    const kv = new MemoryKV() as unknown as KVNamespace;
    await kv.put("budget:2026-09-02", "10");
    const history = await rolloverBudget(kv, new Date("2026-09-02T23:00:00Z"));
    expect(history).toHaveLength(0);
  });

  it("accumulates across multiple rollovers and dedupes dates", async () => {
    const kv = new MemoryKV() as unknown as KVNamespace;
    await kv.put("budget:2026-08-31", "100");
    await rolloverBudget(kv, new Date("2026-09-01T00:30:00Z"));
    await kv.put("budget:2026-09-01", "200");
    const history = await rolloverBudget(kv, new Date("2026-09-02T00:30:00Z"));
    expect(history).toEqual([
      { date: "2026-08-31", used: 100, limit: 10_000 },
      { date: "2026-09-01", used: 200, limit: 10_000 },
    ]);
  });
});