import { useState, useRef, useEffect } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

interface AgentResult {
  status: string;
  summary: string;
  iterations: number;
  filesWritten: string[];
  neuronsUsed: number;
}

interface ChatProps {
  onResult: (result: AgentResult) => void;
}

export function Chat({ onResult }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const prompt = input.trim();
    setInput("");
    setLoading(true);

    // Add user message
    setMessages(prev => [...prev, {
      role: "user",
      content: prompt,
      timestamp: Date.now(),
    }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });

      const result: AgentResult = await res.json();

      // Add assistant message
      setMessages(prev => [...prev, {
        role: "assistant",
        content: formatResult(result),
        timestamp: Date.now(),
      }]);

      onResult(result);
    } catch (error) {
      setMessages(prev => [...prev, {
        role: "assistant",
        content: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        timestamp: Date.now(),
      }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Messages */}
      <div style={{
        flex: 1,
        overflowY: "auto",
        padding: "20px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}>
        {messages.length === 0 && (
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            color: "#555",
            flexDirection: "column",
            gap: "12px",
          }}>
            <div style={{ fontSize: "32px", color: "#f97316" }}>⚡</div>
            <div style={{ fontSize: "14px" }}>What do you want to build?</div>
            <div style={{ fontSize: "12px", color: "#444" }}>
              "Build me a REST API for a todo app"
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              padding: "12px 16px",
              borderRadius: "8px",
              background: msg.role === "user" ? "#1a1a2e" : "#111",
              border: `1px solid ${msg.role === "user" ? "#333" : "#222"}`,
              maxWidth: "80%",
              alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
            }}
          >
            <div style={{
              fontSize: "10px",
              color: "#666",
              marginBottom: "4px",
              textTransform: "uppercase",
            }}>
              {msg.role === "user" ? "You" : "DevForge"}
            </div>
            <div style={{
              fontSize: "13px",
              lineHeight: "1.5",
              whiteSpace: "pre-wrap",
              fontFamily: msg.role === "assistant" ? "monospace" : "inherit",
            }}>
              {msg.content}
            </div>
          </div>
        ))}

        {loading && (
          <div style={{
            padding: "12px 16px",
            borderRadius: "8px",
            background: "#111",
            border: "1px solid #222",
            alignSelf: "flex-start",
          }}>
            <div style={{ fontSize: "10px", color: "#666", textTransform: "uppercase", marginBottom: "4px" }}>
              DevForge
            </div>
            <div style={{ fontSize: "13px", color: "#f97316" }}>
              Working<span style={{ animation: "pulse 1.5s infinite" }}>...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        style={{
          padding: "16px 20px",
          borderTop: "1px solid #333",
          background: "#111",
          display: "flex",
          gap: "12px",
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Describe what you want to build..."
          disabled={loading}
          style={{
            flex: 1,
            padding: "10px 14px",
            background: "#1a1a1a",
            border: "1px solid #333",
            borderRadius: "6px",
            color: "#e0e0e0",
            fontSize: "13px",
            outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          style={{
            padding: "10px 20px",
            background: loading ? "#333" : "#f97316",
            border: "none",
            borderRadius: "6px",
            color: loading ? "#666" : "#000",
            fontSize: "13px",
            fontWeight: 600,
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Building..." : "Build"}
        </button>
      </form>
    </div>
  );
}

function formatResult(result: AgentResult): string {
  const parts: string[] = [];

  if (result.status === "complete") {
    parts.push("Done! Here's what I built:\n");
  } else if (result.status === "max_iterations") {
    parts.push("Reached iteration limit. Here's progress so far:\n");
  } else if (result.status === "budget_exhausted") {
    parts.push("Daily AI budget exhausted. Resets at midnight UTC.\n");
  } else {
    parts.push(`Status: ${result.status}\n`);
  }

  if (result.filesWritten.length > 0) {
    parts.push(`Files created (${result.filesWritten.length}):`);
    result.filesWritten.forEach(f => parts.push(`  ${f}`));
    parts.push("");
  }

  parts.push(`Iterations: ${result.iterations}`);
  parts.push(`Neurons used: ${result.neuronsUsed}`);

  if (result.summary) {
    parts.push(`\n${result.summary}`);
  }

  return parts.join("\n");
}
