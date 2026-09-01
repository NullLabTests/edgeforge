import { describe, it, expect } from "vitest";
import { simulateExec } from "../src/exec-sim.js";
import type { Workspace } from "@cloudflare/computer";

// Minimal in-memory fake workspace for testing the exec simulator
function createFakeWorkspace(files: Record<string, string>): Workspace {
  const store = new Map<string, string>(Object.entries(files));
  return {
    fs: {
      readFile: async (path: string) => {
        if (!store.has(path)) throw new Error(`${path}: not found`);
        return store.get(path)!;
      },
      writeFile: async (path: string, content: string) => { store.set(path, content); },
      readdir: async () => [] ,
      find: async (_dir: string, pattern?: string) =>
        [...store.keys()]
          .filter(p => p.endsWith(".ts"))
          .filter(p => !pattern || p.endsWith(pattern.replace("*", "")))
          .map(p => ({ path: p, type: "file" as const })),
      grep: async () => [] ,
      stat: async () => { throw new Error("not found"); },
      mkdir: async () => {},
      rm: async () => {},
    } as unknown as Workspace["fs"],
  } as Workspace;
}

describe("simulateExec", () => {
  it("returns ENOENT when no package.json", async () => {
    const ws = createFakeWorkspace({});
    const result = await simulateExec("npm install", ws);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("package.json");
  });

  it("npm install succeeds with a package.json", async () => {
    const ws = createFakeWorkspace({
      "/package.json": JSON.stringify({ name: "test", devDependencies: { vitest: "^3.0.0" } }),
    });
    const result = await simulateExec("npm install", ws);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("added 1 package");
  });

  it("npm test fails with no test files", async () => {
    const ws = createFakeWorkspace({
      "/package.json": JSON.stringify({ name: "test" }),
      "/src/index.ts": "export default {}",
    });
    const result = await simulateExec("npm test", ws);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No test files found");
  });

  it("npm test passes with valid test + source", async () => {
    const ws = createFakeWorkspace({
      "/package.json": JSON.stringify({ name: "test" }),
      "/src/index.ts": "export function add(a: number, b: number) { return a + b; }",
      "/test/index.test.ts": "import { describe, it, expect } from 'vitest';\ndescribe('x', () => { it('adds', () => expect(true).toBe(true)); });",
    });
    const result = await simulateExec("npm test", ws);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("All tests passed");
  });

  it("npm test fails on unmatched braces", async () => {
    const ws = createFakeWorkspace({
      "/package.json": JSON.stringify({ name: "test" }),
      "/src/index.ts": "export function broken() {",
      "/test/index.test.ts": "import { describe, it, expect } from 'vitest';\ndescribe('x', () => it('t', () => expect(true).toBe(true)));",
    });
    const result = await simulateExec("npm test", ws);
    expect(result.exitCode).toBe(1);
  });

  it("reports unknown commands on free tier", async () => {
    const ws = createFakeWorkspace({});
    const result = await simulateExec("docker build .", ws);
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("simulated");
  });

  it("wrangler --dry-run succeeds", async () => {
    const ws = createFakeWorkspace({ "/package.json": "{}" });
    const result = await simulateExec("npx wrangler deploy --dry-run", ws);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Would deploy to");
  });
});
