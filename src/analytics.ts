// ─── Agent Analytics / Spend Ledger ────────────────────────────────────────
// Records one entry per agent run so the demo can show real, auditable cost and
// effort data: neurons burned, iterations, files written, duration, and model.
// Stored as a small recent-window ring in KV with a running daily rollup.

const RUN_KEY_PREFIX = "run:";
const DAILY_KEY_PREFIX = "run-daily:";
const RUN_WINDOW_TTL = 86400 * 7; // keep recent run detail for 7 days
const MAX_RUNS = 50;

export interface AgentRun {
  runId: string;
  userId: string;
  model?: string;
  status: string;
  promptLength: number;
  iterations: number;
  neuronsUsed: number;
  filesWritten: string[];
  durationMs: number;
  startedAt: number;
}

export interface DailyRollup {
  runs: number;
  iterations: number;
  neuronsUsed: number;
  filesWritten: number;
  durationMs: number;
}

function dateTag(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export async function recordAgentRun(
  kv: KVNamespace,
  run: Omit<AgentRun, "runId" | "startedAt"> & { startedAt?: number },
): Promise<AgentRun> {
  const startedAt = run.startedAt ?? Date.now() - run.durationMs;
  const entry: AgentRun = {
    ...run,
    runId: crypto.randomUUID(),
    startedAt,
  };

  // Append to the recent-runs ring (newest first), capped at MAX_RUNS.
  const ringKey = `${RUN_KEY_PREFIX}recent`;
  const existing = JSON.parse((await kv.get(ringKey)) || "[]") as AgentRun[];
  existing.unshift(entry);
  const trimmed = existing.slice(0, MAX_RUNS);
  await kv.put(ringKey, JSON.stringify(trimmed), { expirationTtl: RUN_WINDOW_TTL });

  // Increment the daily rollup for the day the run STARTED.
  const dayKey = `${DAILY_KEY_PREFIX}${dateTag(startedAt)}`;
  const daily = await kv.get(dayKey);
  const acc: DailyRollup = daily
    ? (JSON.parse(daily) as DailyRollup)
    : { runs: 0, iterations: 0, neuronsUsed: 0, filesWritten: 0, durationMs: 0 };
  acc.runs += 1;
  acc.iterations += entry.iterations;
  acc.neuronsUsed += entry.neuronsUsed;
  acc.filesWritten += entry.filesWritten.length;
  acc.durationMs += entry.durationMs;
  await kv.put(dayKey, JSON.stringify(acc), { expirationTtl: 86400 * 8 });

  return entry;
}

export async function getRecentRuns(kv: KVNamespace): Promise<AgentRun[]> {
  const raw = await kv.get(`${RUN_KEY_PREFIX}recent`);
  if (!raw) return [];
  const runs = JSON.parse(raw) as AgentRun[];
  // Strip file lists on read to keep the payload small unless requested.
  return runs;
}

export async function getRunRollups(kv: KVNamespace, days: number): Promise<Record<string, DailyRollup>> {
  const out: Record<string, DailyRollup> = {};
  const now = Date.now();
  for (let d = days - 1; d >= 0; d--) {
    const t = now - d * 86400_000;
    const day = dateTag(t);
    const raw = await kv.get(`${DAILY_KEY_PREFIX}${day}`);
    if (raw) out[day] = JSON.parse(raw) as DailyRollup;
  }
  return out;
}

export interface AnalyticsSnapshot {
  recentRuns: AgentRun[];
  rollups: Record<string, DailyRollup>;
  totals: DailyRollup;
  modelBreakdown: Record<string, { runs: number; neuronsUsed: number; avgDurationMs: number }>;
}

export async function getAnalytics(kv: KVNamespace, days = 7): Promise<AnalyticsSnapshot> {
  const recentRuns = await getRecentRuns(kv);
  const rollups = await getRunRollups(kv, days);

  const totals: DailyRollup = { runs: 0, iterations: 0, neuronsUsed: 0, filesWritten: 0, durationMs: 0 };
  const modelBreakdown: AnalyticsSnapshot["modelBreakdown"] = {};

  for (const run of recentRuns) {
    totals.runs += 1;
    totals.iterations += run.iterations;
    totals.neuronsUsed += run.neuronsUsed;
    totals.filesWritten += run.filesWritten.length;
    totals.durationMs += run.durationMs;

    const m = run.model || "unknown";
    const b = modelBreakdown[m] || { runs: 0, neuronsUsed: 0, avgDurationMs: 0 };
    b.runs += 1;
    b.neuronsUsed += run.neuronsUsed;
    b.avgDurationMs = Math.round((b.avgDurationMs * (b.runs - 1) + run.durationMs) / b.runs);
    modelBreakdown[m] = b;
  }

  return { recentRuns, rollups, totals, modelBreakdown };
}
