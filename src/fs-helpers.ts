import type { Workspace } from "@cloudflare/computer";

// ─── Parent Directory Helper ────────────────────────────────────────────────
// @cloudflare/computer's VFS uses absolute paths and does NOT auto-create
// parent directories on writeFile. Ensure every ancestor of `path` exists,
// using absolute mkdir paths. mkdir throwing "exists" is expected and ignored.

export async function ensureParentDirs(ws: Workspace, path: string): Promise<void> {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  let current = "";
  for (const segment of segments) {
    current = `${current}/${segment}`;
    try {
      await ws.fs.mkdir(current);
    } catch {
      // already exists
    }
  }
}