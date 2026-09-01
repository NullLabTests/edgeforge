import { describe, it, expect } from "vitest";
import { getNeuronBudget, addNeuronsUsedToday, canRunTask, estimateTaskNeurons } from "../src/budget.js";

class MemoryKV {
  store = new Map<string, string>();
  async get(key: string) { return this.store.get(key) ?? null; }
  async put(key: string, value: string) { this.store.set(key, value); }
  async list() { return { keys: [] }; }
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