import { useState, useEffect } from "react";

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

interface FileTreeProps {
  refresh: number;
}

export function FileTree({ refresh }: FileTreeProps) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");

  useEffect(() => {
    loadTree();
  }, [refresh]);

  const loadTree = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/files");
      const data = await res.json();
      setTree(data);
    } catch {
      // Empty tree
    } finally {
      setLoading(false);
    }
  };

  const openFile = async (path: string) => {
    setSelectedFile(path);
    try {
      const res = await fetch(`/api/file${path}`);
      const data = await res.json();
      setFileContent(data.content || "");
    } catch {
      setFileContent("Error reading file");
    }
  };

  return (
    <div style={{ display: "flex", height: "100%" }}>
      {/* File tree panel */}
      <div style={{
        width: "300px",
        borderRight: "1px solid #333",
        overflowY: "auto",
        padding: "12px",
        background: "#0d0d0d",
      }}>
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "12px",
        }}>
          <span style={{ fontSize: "12px", color: "#666", textTransform: "uppercase" }}>
            Files
          </span>
          <button
            onClick={loadTree}
            style={{
              background: "none",
              border: "none",
              color: "#666",
              cursor: "pointer",
              fontSize: "11px",
            }}
          >
            ↻
          </button>
        </div>

        {loading && <div style={{ color: "#555", fontSize: "12px" }}>Loading...</div>}

        {!loading && tree.length === 0 && (
          <div style={{ color: "#444", fontSize: "12px", textAlign: "center", padding: "20px" }}>
            No files yet. Start a chat to generate code.
          </div>
        )}

        {tree.map(node => (
          <TreeNode key={node.path} node={node} onSelect={openFile} selectedPath={selectedFile} />
        ))}
      </div>

      {/* File content panel */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px", background: "#0a0a0a" }}>
        {selectedFile ? (
          <>
            <div style={{
              fontSize: "12px",
              color: "#666",
              marginBottom: "12px",
              fontFamily: "monospace",
            }}>
              {selectedFile}
            </div>
            <pre style={{
              fontSize: "13px",
              lineHeight: "1.5",
              fontFamily: "monospace",
              color: "#d4d4d4",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}>
              {fileContent}
            </pre>
          </>
        ) : (
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            color: "#444",
            fontSize: "13px",
          }}>
            Select a file to view its contents
          </div>
        )}
      </div>
    </div>
  );
}

function TreeNode({
  node,
  onSelect,
  selectedPath,
  depth = 0,
}: {
  node: FileNode;
  onSelect: (path: string) => void;
  selectedPath: string | null;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(depth < 2);

  if (node.isDirectory) {
    return (
      <div>
        <div
          onClick={() => setExpanded(!expanded)}
          style={{
            padding: "4px 8px",
            paddingLeft: `${12 + depth * 16}px`,
            cursor: "pointer",
            fontSize: "12px",
            color: "#888",
            display: "flex",
            alignItems: "center",
            gap: "4px",
          }}
        >
          <span style={{ fontSize: "10px", width: "12px" }}>
            {expanded ? "▼" : "▶"}
          </span>
          <span>📁</span>
          <span>{node.name}</span>
        </div>
        {expanded && node.children?.map(child => (
          <TreeNode
            key={child.path}
            node={child}
            onSelect={onSelect}
            selectedPath={selectedPath}
            depth={depth + 1}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      onClick={() => onSelect(node.path)}
      style={{
        padding: "4px 8px",
        paddingLeft: `${12 + depth * 16}px`,
        cursor: "pointer",
        fontSize: "12px",
        color: selectedPath === node.path ? "#f97316" : "#aaa",
        background: selectedPath === node.path ? "#1a1a2e" : "transparent",
        borderRadius: "4px",
        display: "flex",
        alignItems: "center",
        gap: "4px",
      }}
    >
      <span style={{ width: "12px" }} />
      <span>{getFileIcon(node.name)}</span>
      <span>{node.name}</span>
    </div>
  );
}

function getFileIcon(name: string): string {
  if (name.endsWith(".ts") || name.endsWith(".tsx")) return "📘";
  if (name.endsWith(".js") || name.endsWith(".jsx")) return "📙";
  if (name.endsWith(".json")) return "📋";
  if (name.endsWith(".md")) return "📝";
  if (name.endsWith(".html")) return "🌐";
  if (name.endsWith(".css")) return "🎨";
  if (name.endsWith(".toml")) return "⚙️";
  return "📄";
}
