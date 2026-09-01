import { useState, useEffect } from "react";

interface Deployment {
  deployId: string;
  projectName: string;
  status: "pending" | "approved" | "rejected" | "deployed" | "failed";
  fileCount: number;
  createdAt: number;
  simulatedUrl: string;
  deployedUrl?: string;
}

export function ApprovalQueue() {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadDeployments();
    const interval = setInterval(loadDeployments, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadDeployments = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/approvals");
      const data = await res.json();
      setDeployments(data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  const approve = async (deployId: string) => {
    try {
      await fetch(`/api/approvals/${deployId}/approve`, { method: "POST" });
      loadDeployments();
    } catch (err) {
      alert(`Failed to approve: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  };

  const reject = async (deployId: string) => {
    try {
      await fetch(`/api/approvals/${deployId}/reject`, { method: "POST" });
      loadDeployments();
    } catch (err) {
      alert(`Failed to reject: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  };

  return (
    <div style={{ padding: "20px", overflowY: "auto", height: "100%" }}>
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: "16px",
      }}>
        <h2 style={{ fontSize: "14px", color: "#888", textTransform: "uppercase" }}>
          Deploy Approvals
        </h2>
        <button
          onClick={loadDeployments}
          style={{
            background: "none",
            border: "1px solid #333",
            color: "#888",
            padding: "4px 12px",
            borderRadius: "4px",
            cursor: "pointer",
            fontSize: "11px",
          }}
        >
          Refresh
        </button>
      </div>

      {deployments.length === 0 && (
        <div style={{
          textAlign: "center",
          color: "#444",
          padding: "40px",
          fontSize: "13px",
        }}>
          No deployments yet. Ask the agent to build something and deploy it.
        </div>
      )}

      {deployments.map(deploy => (
        <div
          key={deploy.deployId}
          style={{
            padding: "16px",
            background: "#111",
            border: "1px solid #333",
            borderRadius: "8px",
            marginBottom: "12px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: "14px", fontWeight: 600, color: "#e0e0e0" }}>
                {deploy.projectName}
              </div>
              <div style={{ fontSize: "11px", color: "#666", marginTop: "4px" }}>
                {deploy.fileCount} files · {new Date(deploy.createdAt).toLocaleString()}
              </div>
            </div>
            <StatusBadge status={deploy.status} />
          </div>

          {deploy.deployedUrl && (
            <div style={{
              marginTop: "8px",
              padding: "8px 12px",
              background: "#0a2e0a",
              border: "1px solid #1a4a1a",
              borderRadius: "4px",
              fontSize: "12px",
              color: "#4ade80",
            }}>
              Live at: <a href={deploy.deployedUrl} target="_blank" rel="noopener" style={{ color: "#4ade80" }}>
                {deploy.deployedUrl}
              </a>
            </div>
          )}

          {deploy.status === "pending" && (
            <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
              <button
                onClick={() => approve(deploy.deployId)}
                style={{
                  flex: 1,
                  padding: "8px 16px",
                  background: "#166534",
                  border: "1px solid #22c55e",
                  borderRadius: "4px",
                  color: "#4ade80",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Approve Deploy
              </button>
              <button
                onClick={() => reject(deploy.deployId)}
                style={{
                  flex: 1,
                  padding: "8px 16px",
                  background: "#450a0a",
                  border: "1px solid #dc2626",
                  borderRadius: "4px",
                  color: "#fca5a5",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                Reject
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; border: string; text: string }> = {
    pending: { bg: "#451a03", border: "#92400e", text: "#fbbf24" },
    approved: { bg: "#052e16", border: "#166534", text: "#4ade80" },
    rejected: { bg: "#450a0a", border: "#991b1b", text: "#fca5a5" },
    deployed: { bg: "#052e16", border: "#166534", text: "#4ade80" },
    failed: { bg: "#450a0a", border: "#991b1b", text: "#fca5a5" },
  };

  const c = colors[status] || colors.pending;

  return (
    <span style={{
      padding: "2px 8px",
      borderRadius: "12px",
      fontSize: "11px",
      fontWeight: 600,
      textTransform: "uppercase",
      background: c.bg,
      border: `1px solid ${c.border}`,
      color: c.text,
    }}>
      {status}
    </span>
  );
}
