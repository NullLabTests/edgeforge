// ─── Environment Bindings ───────────────────────────────────────────────────
export interface Env {
  WORKSPACE: DurableObjectNamespace;
  AI: Ai;
  ARTIFACTS?: R2Bucket;
  APPROVALS: KVNamespace;
  ASSETS: { fetch: (req: Request) => Promise<Response> };
}

// ─── Workspace DO RPC interface ─────────────────────────────────────────────
export interface WorkspaceRpc {
  // Filesystem operations
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  deleteFile(path: string): Promise<void>;
  grepFiles(pattern: string, root?: string): Promise<GrepResult[]>;
  fileExists(path: string): Promise<boolean>;

  // Agent loop
  runAgentLoop(prompt: string): Promise<AgentResult>;

  // Deploy
  requestDeploy(projectName: string): Promise<DeployRequest>;
  getDeployStatus(deployId: string): Promise<DeployStatus>;
  listDeployments(): Promise<DeployStatus[]>;

  // File tree for UI
  getFileTree(): Promise<FileTreeNode[]>;
}

// ─── Filesystem Types ───────────────────────────────────────────────────────
export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface GrepResult {
  file: string;
  line: number;
  match: string;
}

export interface FileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileTreeNode[];
}

// ─── Agent Types ────────────────────────────────────────────────────────────
export interface AgentResult {
  status: "complete" | "max_iterations" | "budget_exhausted" | "error";
  summary: string;
  iterations: number;
  filesWritten: string[];
  testResults?: TestResult[];
  neuronsUsed: number;
}

export interface TestResult {
  file: string;
  passed: boolean;
  errors: string[];
}

// ─── Tool Types ─────────────────────────────────────────────────────────────
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

// ─── Deploy Types ───────────────────────────────────────────────────────────
export interface DeployRequest {
  deployId: string;
  projectName: string;
  status: "pending" | "approved" | "rejected" | "deployed" | "failed";
  fileCount: number;
  createdAt: number;
  simulatedUrl: string;
}

export interface DeployStatus extends DeployRequest {
  approvedAt?: number;
  deployedAt?: number;
  deployedUrl?: string;
  error?: string;
}

// ─── Exec Simulation Types ──────────────────────────────────────────────────
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
