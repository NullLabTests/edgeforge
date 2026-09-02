import { useState, useEffect } from "react";

interface Deployment {
  deployId: string;
  projectName: string;
  status: "pending" | "approved" | "rejected" | "deployed" | "failed";
  fileCount: number;
  createdAt: number;
  simulatedUrl: string;
  deployedUrl?: string;
  deployMode?: "real" | "archive";
  error?: string;
}

interface ReviewFile {
  path: string;
  content: string;
  bytes: number;
  isEntry: boolean;
  verified: boolean;
  issues: string[];
}

interface Review {
  deployId: string;
  projectName: string;
  files: ReviewFile[];
  totalBytes: number;
  passes: number;
  fails: number;
}

function ReviewPanel({ deploy }: { deploy: Deployment }) {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (!review) {
      setLoading(true);
      try {
        const res = await fetch(`/api/approvals/${deploy.deployId}/files`);
        if (res.ok) setReview(await res.json());
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div style={{ marginTop: "12px" }}>
      <button
        onClick={toggle}
        style={{
          background: "none",
          border: "1px solid #333",
          borderRadius: 4,
          color: "#888",
          padding: "6px 12px",
          fontSize: "11px",
          cursor: "pointer",
        }}
      >
        {open ? "Hide" : "Review"} generated code
      </button>

      {open && (
        <div style={{ marginTop: "8px", fontSize: "12px" }}>
          {loading && <div style={{ color: "#666" }}>Loading files...</div>}
          {review && (
            <>
              <div style={{ color: "#888", marginBottom: "6px", fontSize: "11px" }}>
                {review.files.length} files · {review.totalBytes} bytes · code review verification: {" "}
                <span style={{ color: "#4ade80" }}>{review.passes} pass</span>
                {review.fails > 0 && <span style={{ color: "#fca5a5" }}> · {review.fails} issue</span>}
              </div>
              {review.files.map(f => (
                <div key={f.path} style={{
                  background: "#0d0d0d",
                  border: "1px solid #222",
                  borderRadius: 6,
                  marginBottom: "8px",
                  overflow: "hidden",
                }}>
                  <div style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "6px 10px",
                    fontSize: "11px",
                    fontFamily: "monospace",
                    color: f.isEntry ? "#f59e0b" : "#666",
                  }}>
                    <span>{f.path}{f.isEntry ? "  (entry)" : ""}</span>
                    {f.verified
                      ? <span style={{ color: "#4ade80" }}>✓ verified</span>
                      : <span style={{ color: "#fca5a5" }}>⚠ {f.issues.join(", ")}</span>}
                  </div>
                  <pre style={{
                    margin: 0,
                    padding: "8px 10px",
                    fontSize: "11px",
                    lineHeight: 1.4,
                    color: "#9ca3af",
                    whiteSpace: "pre",
                    overflowX: "auto",
                    borderTop: "1px solid #1a1a1a",
                    maxHeight: 200,
                    overflowY: "auto",
                  }}>{f.content}</pre>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
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
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
            <div>
              <div style={{ fontSize: "14px", fontWeight: 600, color: "#e0e0e0" }}>
                {deploy.projectName}
              </div>
              <div style={{ fontSize: "11px", color: "#666", marginTop: "4px" }}>
                {deploy.fileCount} files · {new Date(deploy.createdAt).toLocaleString()}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              {deploy.deployMode && (
                <ModeBadge mode={deploy.deployMode} />
              )}
              <StatusBadge status={deploy.status} />
            </div>
          </div>

          {deploy.error && (
            <div style={{
              marginTop: "8px",
              padding: "8px 12px",
              background: "#2a0a0a",
              border: "1px solid #7f1d1d",
              borderRadius: "4px",
              fontSize: "11px",
              color: "#fca5a5",
            }}>
              {deploy.error}
            </div>
          )}

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
            <div>
              <ReviewPanel deploy={deploy} />
              <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
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

function ModeBadge({ mode }: { mode: "real" | "archive" }) {
  const real = mode === "real";
  return (
    <span style={{
      padding: "2px 8px",
      borderRadius: "12px",
      fontSize: "11px",
      fontWeight: 600,
      background: real ? "#052e16" : "#111827",
      border: `1px solid ${real ? "#16a34a" : "#4b5563"}`,
      color: real ? "#4ade80" : "#9ca3af",
    }}>
      {real ? "Live" : "Archive"}
    </span>
  );
}
