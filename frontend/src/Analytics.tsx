import { useState, useEffect } from "react";

interface Run {
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

interface Rollup {
  runs: number;
  iterations: number;
  neuronsUsed: number;
  filesWritten: number;
  durationMs: number;
}

interface Snapshot {
  recentRuns: Run[];
  rollups: Record<string, Rollup>;
  totals: Rollup;
  modelBreakdown: Record<string, { runs: number; neuronsUsed: number; avgDurationMs: number }>;
}

export function Analytics() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    load();
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/analytics");
      if (res.ok) setData(await res.json());
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  if (!data) {
    return (
      <div style={{ padding: 20, color: "#444", fontSize: 13 }}>
        {loading ? "Loading analytics..." : "No agent runs recorded yet. Run a task to populate the ledger."}
      </div>
    );
  }

  const { totals, rollups, modelBreakdown, recentRuns } = data;
  const days = Object.keys(rollups);

  return (
    <div style={{ padding: "20px", overflowY: "auto", height: "100%" }}>
      <h2 style={{ fontSize: "14px", color: "#888", textTransform: "uppercase", marginBottom: "16px" }}>
        Agent spend & effort
      </h2>

      {/* Totals */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px", marginBottom: "20px" }}>
        {[
          { label: "Runs", value: totals.runs.toLocaleString() },
          { label: "Neurons spent", value: totals.neuronsUsed.toLocaleString() },
          { label: "Files written", value: totals.filesWritten.toLocaleString() },
          { label: "Avg latency", value: totals.runs ? `${(totals.durationMs / totals.runs / 1000).toFixed(1)}s` : "—" },
        ].map(s => (
          <div key={s.label} style={{ background: "#111", border: "1px solid #333", borderRadius: 8, padding: "16px" }}>
            <div style={{ fontSize: "20px", fontWeight: 600, color: "#e0e0e0" }}>{s.value}</div>
            <div style={{ fontSize: "11px", color: "#666", marginTop: 4 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Daily rollups */}
      {days.length > 0 && (
        <div style={{ marginBottom: "20px" }}>
          <div style={{ fontSize: "12px", color: "#888", marginBottom: "8px" }}>Per day</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {days.sort().reverse().map(day => {
              const r = rollups[day];
              return (
                <div key={day} style={{ display: "flex", justifyContent: "space-between", background: "#111", border: "1px solid #222", borderRadius: 6, padding: "8px 12px", fontSize: "12px" }}>
                  <span style={{ color: "#888" }}>{day}</span>
                  <span style={{ color: "#e0e0e0" }}>{r.runs} runs · {r.neuronsUsed.toLocaleString()} neurons · {r.filesWritten} files</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Model breakdown */}
      {Object.keys(modelBreakdown).length > 0 && (
        <div style={{ marginBottom: "20px" }}>
          <div style={{ fontSize: "12px", color: "#888", marginBottom: "8px" }}>By model</div>
          {Object.entries(modelBreakdown).map(([m, b]) => (
            <div key={m} style={{ display: "flex", justifyContent: "space-between", background: "#111", border: "1px solid #222", borderRadius: 6, padding: "8px 12px", fontSize: "12px" }}>
              <span style={{ color: "#f59e0b" }}>{m}</span>
              <span style={{ color: "#e0e0e0" }}>{b.runs} runs · {b.neuronsUsed.toLocaleString()} neurons · avg {(b.avgDurationMs / 1000).toFixed(1)}s</span>
            </div>
          ))}
        </div>
      )}

      {/* Recent runs */}
      <div>
        <div style={{ fontSize: "12px", color: "#888", marginBottom: "8px" }}>Recent runs</div>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {recentRuns.map(r => (
            <div key={r.runId} style={{ background: "#111", border: "1px solid #222", borderRadius: 6, padding: "10px 12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px" }}>
                <span style={{ color: "#e0e0e0" }}>{r.status} · {r.iterations} iters · {r.neuronsUsed} neurons</span>
                <span style={{ color: "#666" }}>{new Date(r.startedAt).toLocaleTimeString()}</span>
              </div>
              <div style={{ fontSize: "11px", color: "#666", marginTop: 4 }}>
                {r.filesWritten.length} files · {(r.durationMs / 1000).toFixed(1)}s · {r.model || "unknown"}
              </div>
            </div>
          ))}
          {recentRuns.length === 0 && <div style={{ fontSize: 12, color: "#444" }}>No runs yet.</div>}
        </div>
      </div>
    </div>
  );
}
