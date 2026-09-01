import { useState, useCallback } from "react";
import { Chat } from "./Chat.js";
import { FileTree } from "./FileTree.js";
import { ApprovalQueue } from "./ApprovalQueue.js";

interface AgentResult {
  status: string;
  summary: string;
  iterations: number;
  filesWritten: string[];
  neuronsUsed: number;
}

export default function App() {
  const [fileTreeRefresh, setFileTreeRefresh] = useState(0);
  const [lastResult, setLastResult] = useState<AgentResult | null>(null);
  const [activeTab, setActiveTab] = useState<"chat" | "files" | "approvals">("chat");

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
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <h1 style={{ fontSize: "18px", fontWeight: 600, color: "#f97316" }}>
            DevForge
          </h1>
          <span style={{ fontSize: "12px", color: "#666" }}>
            AI Development Agent — Free Tier
          </span>
        </div>
        {lastResult && (
          <div style={{ fontSize: "12px", color: "#888" }}>
            {lastResult.filesWritten.length} files · {lastResult.iterations} iterations · {lastResult.neuronsUsed} neurons
          </div>
        )}
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
        <span>Workers AI: Granite 4.0 Micro (free tier)</span>
        <span>@cloudflare/computer filesystem mode</span>
      </footer>
    </div>
  );
}
