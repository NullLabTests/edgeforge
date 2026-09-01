// ─── Environment Bindings ───────────────────────────────────────────────────
export interface Env {
  WORKSPACE: DurableObjectNamespace;
  AI: Ai;
  ARTIFACTS?: R2Bucket;
  APPROVALS: KVNamespace;
  BUDGET: KVNamespace;
  ASSETS: { fetch: (req: Request) => Promise<Response> };

  // Optional secrets that enable REAL deploys to the account's free tier.
  // Without them the Gatekeeper packages an archive instead (see gatekeeper.ts).
  CF_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CF_ACCOUNT_SUBDOMAIN?: string;

  // Optional model override for the agent's tool-calling loop.
  // Defaults to @cf/ibm-granite/granite-4.0-h-micro (see agent.ts).
  // Verified-compatible alternative: @cf/qwen/qwen3-30b-a3b-fp8.
  MODEL?: string;
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
  budget?: { remaining: number; used: number; limit: number };
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
export type DeployStatusValue = "pending" | "approved" | "rejected" | "deployed" | "failed";
export type DeployMode = "real" | "archive";

export interface DeployRequest {
  deployId: string;
  projectName: string;
  status: DeployStatusValue;
  fileCount: number;
  createdAt: number;
  requestedBy?: string;
  simulatedUrl: string;
}

export interface DeployStatus extends DeployRequest {
  approvedAt?: number;
  deployedAt?: number;
  deployedUrl?: string;
  deployMode?: DeployMode;
  rejectedAt?: number;
  error?: string;
}

export interface DeployActionLog {
  type: string;
  deployId: string;
  projectName?: string;
  detail?: string;
  timestamp: number;
}

// ─── Exec Simulation Types ──────────────────────────────────────────────────
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}