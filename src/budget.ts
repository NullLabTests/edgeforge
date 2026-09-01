// ─── Neuron Budget Tracker ─────────────────────────────────────────────────
// Workers AI free tier grants 10,000 neurons/day. This module keeps a running
// daily count in KV so the agent never blows through the free allowance in a
// single marathon task — and so the demo never surprises the demoer with an
// overage charge. The count rolls over at midnight UTC.

const DAILY_NEURON_LIMIT = 10_000;
const SAFETY_RESERVE = 500;

export interface NeuronBudget {
  used: number;
  remaining: number;
  limit: number;
  resetKey: string;
}

function dailyKey(now: Date): string {
  return `budget:${now.toISOString().slice(0, 10)}`;
}

export async function getNeuronsUsedToday(kv: KVNamespace): Promise<number> {
  const stored = await kv.get(dailyKey(new Date()));
  const parsed = stored ? parseInt(stored, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export async function addNeuronsUsedToday(kv: KVNamespace, amount: number): Promise<number> {
  const key = dailyKey(new Date());
  const current = await getNeuronsUsedToday(kv);
  const next = current + Math.max(0, Math.round(amount));
  // expire at end of the day + an hour buffer so the next rollover is clean
  await kv.put(key, String(next), { expirationTtl: 86400 + 3600 });
  return next;
}

export async function getNeuronBudget(kv: KVNamespace): Promise<NeuronBudget> {
  const used = await getNeuronsUsedToday(kv);
  const remaining = Math.max(0, DAILY_NEURON_LIMIT - SAFETY_RESERVE - used);
  return { used, remaining, limit: DAILY_NEURON_LIMIT, resetKey: dailyKey(new Date()) };
}

export function estimateTaskNeurons(maxIterations: number, tokensPerIteration = 1200): number {
  // coarse planning figure: ~1,542 neurons/M input + ~10,158/M output for Granite micro
  const inputTokens = tokensPerIteration * 0.7;
  const outputTokens = tokensPerIteration * 0.3;
  const perCall = (inputTokens * 1542 + outputTokens * 10158) / 1_000_000;
  return Math.ceil(perCall * maxIterations);
}

export async function canRunTask(kv: KVNamespace, maxIterations: number): Promise<boolean> {
  const budget = await getNeuronBudget(kv);
  return budget.remaining >= estimateTaskNeurons(maxIterations);
}