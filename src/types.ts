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
  bootTest?: BootTest;
}

export interface DeployStatus extends DeployRequest {
  approvedAt?: number;
  deployedAt?: number;
  deployedUrl?: string;
  deployMode?: DeployMode;
  rejectedAt?: number;
  error?: string;
  liveCheck?: LiveCheck;
  d1?: GadgetD1;
}

// A REAL pre-approval boot test: the Gatekeeper preview-deploys the exact
// artifact it will promote, then fetches the live preview URL and records the
// actual HTTP result. This replaces "trust the static check" with "we booted
// it on the real platform before you approved it." Runs only when the account
// has Workers credentials configured; otherwise it degrades to the static
// review (reason: "no-token").
export interface BootTest {
  status: "pass" | "fail" | "skipped";
  reason?: "no-token" | "no-entry" | "upload-failed" | "http";
  previewName?: string;
  previewUrl?: string;
  httpStatus?: number;
  latencyMs?: number;
  bodySnippet?: string;
  error?: string;
  checkedAt: number;
}

// Post-promotion proof: the live workers.dev URL was fetched once and answered.
export interface LiveCheck {
  ok: boolean;
  httpStatus?: number;
  latencyMs?: number;
  bodySnippet?: string;
  error?: string;
  checkedAt: number;
}

// Real per-gadget state: a dedicated D1 database, bound to the live Worker
// (binding name GADGET_DB). D1's free tier is no-card, like the rest.
export interface GadgetD1 {
  databaseId: string;
  databaseName: string;
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