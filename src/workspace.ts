import { Workspace } from "@cloudflare/computer";
import { DurableObject } from "cloudflare:workers";
import type { Env, DirEntry, GrepResult, FileTreeNode, AgentResult, DeployRequest, DeployStatus } from "./types.js";
import { runAgentLoop } from "./agent.js";
import { ensureParentDirs } from "./fs-helpers.js";
import { simulateExec } from "./exec-sim.js";

// ─── Workspace Durable Object ───────────────────────────────────────────────
// Wraps @cloudflare/computer Workspace for virtual filesystem + agent execution.
// Each user workspace is a separate DO instance backed by SQLite storage.

export class WorkspaceDO extends DurableObject<Env> {
  private workspace!: Workspace;

  async initialize(): Promise<void> {
    // Initialize the @cloudflare/computer workspace backed by DO SQLite storage
    this.workspace = new Workspace({
      storage: this.ctx.storage as unknown as ConstructorParameters<typeof Workspace>[0]["storage"],
    });
    await this.workspace.ready();
  }

  private async ensureWorkspace(): Promise<Workspace> {
    if (!this.workspace) {
      await this.initialize();
    }
    return this.workspace;
  }

  // ─── Filesystem Operations ────────────────────────────────────────────────

  async readFile(path: string): Promise<string> {
    const ws = await this.ensureWorkspace();
    return ws.fs.readFile(path, "utf8") as Promise<string>;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const ws = await this.ensureWorkspace();
    await ensureParentDirs(ws, path);
    await ws.fs.writeFile(path, content);
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const ws = await this.ensureWorkspace();
    const entries = await ws.fs.readdir(path);
    return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory }));
  }

  async deleteFile(path: string): Promise<void> {
    const ws = await this.ensureWorkspace();
    await ws.fs.rm(path, { recursive: true });
  }

  async grepFiles(pattern: string, root: string = "/"): Promise<GrepResult[]> {
    const ws = await this.ensureWorkspace();
    const results = await ws.fs.grep(pattern, root);
    return results.map(r => ({ file: r.path, line: r.line, match: r.text }));
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      const ws = await this.ensureWorkspace();
      await ws.fs.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Agent Loop ───────────────────────────────────────────────────────────

  async runAgentLoop(prompt: string): Promise<AgentResult> {
    const ws = await this.ensureWorkspace();
    return runAgentLoop(prompt, ws, this.env);
  }

  // ─── Deploy ───────────────────────────────────────────────────────────────

  async requestDeploy(projectName: string): Promise<DeployRequest> {
    const ws = await this.ensureWorkspace();
    const deployId = crypto.randomUUID();

    // Collect all files from the workspace
    const files = await this.collectAllFiles(ws, "/");

    // Store deploy request in KV
    const request: DeployRequest = {
      deployId,
      projectName,
      status: "pending",
      fileCount: Object.keys(files).length,
      createdAt: Date.now(),
      simulatedUrl: `https://${projectName}.devforge.workers.dev`,
    };

    await this.env.APPROVALS.put(
      `deploy:${deployId}`,
      JSON.stringify({ ...request, files }),
      { expirationTtl: 86400 } // 24h TTL
    );

    return request;
  }

  async getDeployStatus(deployId: string): Promise<DeployStatus> {
    const data = await this.env.APPROVALS.get(`deploy:${deployId}`);
    if (!data) throw new Error(`Deploy ${deployId} not found`);
    return JSON.parse(data);
  }

  async listDeployments(): Promise<DeployStatus[]> {
    const list = await this.env.APPROVALS.list({ prefix: "deploy:" });
    const deployments: DeployStatus[] = [];
    for (const key of list.keys) {
      const data = await this.env.APPROVALS.get(key.name);
      if (data) {
        const deploy = JSON.parse(data);
        // Don't include the full files array in the list
        const { files, ...status } = deploy;
        deployments.push(status);
      }
    }
    return deployments.sort((a, b) => b.createdAt - a.createdAt);
  }

  // ─── File Tree for UI ─────────────────────────────────────────────────────

  async getFileTree(): Promise<FileTreeNode[]> {
    const ws = await this.ensureWorkspace();
    return this.buildFileTree(ws, "/");
  }

  private async buildFileTree(ws: Workspace, path: string): Promise<FileTreeNode[]> {
    const entries = await ws.fs.readdir(path);
    const nodes: FileTreeNode[] = [];

    for (const entry of entries) {
      const fullPath = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
      const node: FileTreeNode = {
        name: entry.name,
        path: fullPath,
        isDirectory: entry.isDirectory,
      };

      if (entry.isDirectory) {
        node.children = await this.buildFileTree(ws, fullPath);
      }

      nodes.push(node);
    }

    return nodes;
  }

  private async collectAllFiles(ws: Workspace, path: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    const entries = await ws.fs.readdir(path);

    for (const entry of entries) {
      const fullPath = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
      if (entry.isDirectory) {
        Object.assign(files, await this.collectAllFiles(ws, fullPath));
      } else {
        try {
          files[fullPath] = await ws.fs.readFile(fullPath, "utf8") as string;
        } catch {
          // Skip binary files
        }
      }
    }

    return files;
  }
}
