import { useState, useCallback, useEffect } from "react";
import { Chat } from "./Chat.js";
import { FileTree } from "./FileTree.js";
import { ApprovalQueue } from "./ApprovalQueue.js";

interface AgentResult {
  status: string;
  summary: string;
  iterations: number;
  filesWritten: string[];
  neuronsUsed: number;
  budget?: { remaining: number; used: number; limit: number };
}

interface BudgetInfo {
  used: number;
  remaining: number;
  limit: number;
}

function useBudget() {
  const [budget, setBudget] = useState<BudgetInfo | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/budget");
      if (res.ok) setBudget(await res.json());
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);

  return { budget, refresh: load };
}

function BudgetMeter({ budget }: { budget: BudgetInfo | null }) {
  if (!budget) return null;
  const pct = Math.min(100, (budget.used / budget.limit) * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <div style={{ fontSize: "11px", color: "#888" }}>
        {budget.used.toLocaleString()} / {budget.limit.toLocaleString()} neurons today
      </div>
      <div style={{
        width: 80,
        height: 6,
        borderRadius: 3,
        background: "#222",
        overflow: "hidden",
      }}>
        <div style={{
          width: `${pct}%`,
          height: "100%",
          background: pct > 85 ? "#dc2626" : pct > 60 ? "#f59e0b" : "#22c55e",
          transition: "width 0.4s",
        }} />
      </div>
    </div>
  );
}

export default function App() {
  const [fileTreeRefresh, setFileTreeRefresh] = useState(0);
  const [lastResult, setLastResult] = useState<AgentResult | null>(null);
  const [activeTab, setActiveTab] = useState<"chat" | "files" | "approvals">("chat");
  const { budget } = useBudget();

  const handleAgentResult = useCallback((result: AgentResult) => {
    setLastResult(result);
    setFileTreeRefresh(n => n + 1);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* Header */}
      <header style={{
        padding: "12px 20px",
        background: "#111",
        borderBottom: "1px solid #333",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "16px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <h1 style={{ fontSize: "18px", fontWeight: 600, color: "#f97316" }}>
            EdgeForge
          </h1>
          <span style={{ fontSize: "12px", color: "#666" }}>
            AI dev sandbox at the edge — Cloudflare free tier
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
          {lastResult && (
            <div style={{ fontSize: "12px", color: "#888" }}>
              {lastResult.filesWritten.length} files · {lastResult.iterations} iters · {lastResult.neuronsUsed} neurons
            </div>
          )}
          <BudgetMeter budget={budget} />
        </div>
      </header>

      {/* Tab Bar */}
      <div style={{
        display: "flex",
        background: "#111",
        borderBottom: "1px solid #333",
        padding: "0 20px",
      }}>
        {(["chat", "files", "approvals"] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: "8px 16px",
              background: "none",
              border: "none",
              color: activeTab === tab ? "#f97316" : "#666",
              borderBottom: activeTab === tab ? "2px solid #f97316" : "2px solid transparent",
              cursor: "pointer",
              fontSize: "13px",
              textTransform: "capitalize",
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        {activeTab === "chat" && (
          <Chat onResult={handleAgentResult} />
        )}
        {activeTab === "files" && (
          <FileTree refresh={fileTreeRefresh} />
        )}
        {activeTab === "approvals" && (
          <ApprovalQueue />
        )}
      </div>

      {/* Status Bar */}
      <footer style={{
        padding: "6px 20px",
        background: "#111",
        borderTop: "1px solid #333",
        fontSize: "11px",
        color: "#555",
        display: "flex",
        justifyContent: "space-between",
      }}>
        <span>Workers AI · Granite 4.0 Micro · 10K neurons/day</span>
        <span>@cloudflare/computer filesystem · Durable Objects (SQLite) · Gatekeeper approvals</span>
      </footer>
    </div>
  );
}