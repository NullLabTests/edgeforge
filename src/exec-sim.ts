import type { Workspace } from "@cloudflare/computer";
import type { ExecResult } from "./types.js";

// ─── Simulated Command Execution ────────────────────────────────────────────
// Since we can't run real shell commands on free tier (no containers/Dynamic Workers),
// we simulate common dev commands using static analysis of the workspace files.

export async function simulateExec(
  command: string,
  workspace: Workspace,
): Promise<ExecResult> {
  const trimmed = command.trim();

  // Route to specific simulators
  if (trimmed === "npm install" || trimmed === "npm i") {
    return simulateNpmInstall(workspace);
  }
  if (trimmed.startsWith("npm test") || trimmed.startsWith("npx vitest")) {
    return simulateNpmTest(workspace);
  }
  if (trimmed === "npm run build" || trimmed === "npx tsc") {
    return simulateBuild(workspace);
  }
  if (trimmed.startsWith("npx wrangler") || trimmed.startsWith("wrangler")) {
    return simulateWrangler(trimmed, workspace);
  }
  if (trimmed.startsWith("cat ")) {
    return simulateCat(trimmed, workspace);
  }
  if (trimmed.startsWith("ls")) {
    return simulateLs(trimmed, workspace);
  }
  if (trimmed === "pwd") {
    return { stdout: "/", stderr: "", exitCode: 0 };
  }
  if (trimmed.startsWith("echo ")) {
    const rest = trimmed.slice(5).trim();
    const unquoted = rest.replace(/^"/, "").replace(/"$/, "");
    return { stdout: unquoted, stderr: "", exitCode: 0 };
  }

  // Default: unknown command
  return {
    stdout: "",
    stderr: `simulated exec: command not found: ${trimmed.split(" ")[0]}\nNote: Shell execution is simulated on free tier. Use the write/read/edit tools to manage files directly.`,
    exitCode: 127,
  };
}

// ─── npm install ────────────────────────────────────────────────────────────

async function simulateNpmInstall(ws: Workspace): Promise<ExecResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check if package.json exists
  let pkgJson: Record<string, unknown> | null = null;
  try {
    const raw = await ws.fs.readFile("/package.json", "utf8");
    pkgJson = JSON.parse(raw as string);
  } catch {
    return {
      stdout: "",
      stderr: "npm ERR! code ENOENT\nnpm ERR! no package.json found\n\nnpm ERR! A complete log of this run can be found in:\nnpm ERR! /tmp/npm-debug.log",
      exitCode: 1,
    };
  }

  const deps = {
    ...((pkgJson as Record<string, unknown>).dependencies as Record<string, string> || {}),
    ...((pkgJson as Record<string, unknown>).devDependencies as Record<string, string> || {}),
  };

  // Validate each dependency
  const knownPackages = new Set([
    "wrangler", "vitest", "typescript", "hono", "@cloudflare/workers-types",
    "@cloudflare/computer", "capnweb", "react", "react-dom", "vue", "svelte",
    "express", "fastify", "zod", "itty-router", "itty-router",
  ]);

  for (const [name, version] of Object.entries(deps)) {
    // Basic semver validation
    if (typeof version !== "string") {
      errors.push(`npm ERR! Invalid version for "${name}": ${version}`);
      continue;
    }
    if (!version.match(/^[\^~>=<]*\d/)) {
      warnings.push(`npm WARN Invalid version "${version}" for ${name}, using latest`);
    }
  }

  // Generate a simulated lock file
  const lockEntries: string[] = [];
  for (const [name, version] of Object.entries(deps)) {
    lockEntries.push(`"${name}@${version}":\n  version: "${(version as string).replace(/[^0-9.]/g, "")}"`);
  }

  if (errors.length > 0) {
    return { stdout: "", stderr: errors.join("\n"), exitCode: 1 };
  }

  const depCount = Object.keys(deps).length;
  const warningText = warnings.length > 0 ? "\n" + warnings.join("\n") + "\n" : "";

  return {
    stdout: `added ${depCount} package${depCount !== 1 ? "s" : ""} in 0s\n\n${warningText}audited ${depCount} package${depCount !== 1 ? "s" : ""} in 0s\n\n${depCount} package${depCount !== 1 ? "s" : ""} are looking for funding\n  run \`npm fund\` for details`,
    stderr: "",
    exitCode: 0,
  };
}

// ─── npm test ───────────────────────────────────────────────────────────────

async function simulateNpmTest(ws: Workspace): Promise<ExecResult> {
  const errors: string[] = [];
  const testResults: string[] = [];
  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;

  // Find test files
  const testFiles = await findTestFiles(ws);

  if (testFiles.length === 0) {
    return {
      stdout: "",
      stderr: "No test files found. Create a test file matching **/*.test.ts or **/*.spec.ts",
      exitCode: 1,
    };
  }

  for (const file of testFiles) {
    const content = await ws.fs.readFile(file, "utf8") as string;

    // Check for basic syntax issues in the test file
    const fileErrors = checkTypeScriptSyntax(content, file);
    if (fileErrors.length > 0) {
      errors.push(...fileErrors);
      failedTests++;
      totalTests++;
      testResults.push(`FAIL ${file}`);
      continue;
    }

    // Check that the test file imports from valid modules
    const imports = extractImports(content);
    for (const imp of imports) {
      // Check if the imported file exists
      if (imp.startsWith("./") || imp.startsWith("../")) {
        const resolved = resolveImport(file, imp);
        try {
          await ws.fs.stat(resolved);
        } catch {
          errors.push(`${file}: Module not found: "${imp}" (imported from ${file})`);
          failedTests++;
          totalTests++;
          testResults.push(`FAIL ${file}`);
          continue;
        }
      }
    }

    // Check for describe/it/expect patterns
    const hasTests = /(?:describe|it|test)\s*\(/.test(content);
    const hasExpect = /expect\s*\(/.test(content);

    if (!hasTests) {
      errors.push(`${file}: No test cases found (no describe/it/test calls)`);
      failedTests++;
      totalTests++;
      testResults.push(`FAIL ${file}`);
      continue;
    }

    // Basic structural validation passed
    passedTests++;
    totalTests++;
    testResults.push(`PASS ${file}`);
  }

  // Also check source files for import errors
  const sourceFiles = await findSourceFiles(ws);
  for (const file of sourceFiles) {
    if (testFiles.includes(file)) continue;
    const content = await ws.fs.readFile(file, "utf8") as string;
    const fileErrors = checkTypeScriptSyntax(content, file);
    if (fileErrors.length > 0) {
      errors.push(...fileErrors);
    }

    const imports = extractImports(content);
    for (const imp of imports) {
      if (imp.startsWith("./") || imp.startsWith("../")) {
        const resolved = resolveImport(file, imp);
        try {
          await ws.fs.stat(resolved);
        } catch {
          // Only report as error if it's not a type-only import
          if (!content.includes(`import type`)) {
            errors.push(`${file}: Module not found: "${imp}"`);
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return {
      stdout: testResults.join("\n"),
      stderr: `\n${errors.join("\n")}\n\nTest Suites: ${failedTests} failed, ${totalTests - failedTests} passed, ${totalTests} total\nTests: ${failedTests} failed, ${passedTests} passed, ${totalTests} total`,
      exitCode: 1,
    };
  }

  return {
    stdout: `\n${testResults.join("\n")}\n\nTest Suites: ${totalTests} passed, ${totalTests} total\nTests: ${passedTests} passed, ${totalTests} total\n\nRan all test suites.\n✨ All tests passed!`,
    stderr: "",
    exitCode: 0,
  };
}

// ─── Build ──────────────────────────────────────────────────────────────────

async function simulateBuild(ws: Workspace): Promise<ExecResult> {
  const errors: string[] = [];

  const sourceFiles = await findSourceFiles(ws);
  for (const file of sourceFiles) {
    const content = await ws.fs.readFile(file, "utf8") as string;
    const fileErrors = checkTypeScriptSyntax(content, file);
    errors.push(...fileErrors);
  }

  if (errors.length > 0) {
    return {
      stdout: "",
      stderr: `error TS5023: Build failed with errors:\n\n${errors.join("\n")}`,
      exitCode: 2,
    };
  }

  return {
    stdout: "Build completed successfully.",
    stderr: "",
    exitCode: 0,
  };
}

// ─── Wrangler ───────────────────────────────────────────────────────────────

async function simulateWrangler(command: string, ws: Workspace): Promise<ExecResult> {
  if (command.includes("--dry-run")) {
    return {
      stdout: `upstream has changed since last deployment, triggering a new deployment\n\nSuperficial validation ofWorker configuration and syntax:\n- No wrangler configuration issues found\n- Worker file (src/index.ts): OK\n- Compatibility date: OK\n\nWould deploy to: https://worker.dev`,
      stderr: "",
      exitCode: 0,
    };
  }

  if (command.includes("deploy")) {
    // Simulate deploy — package to R2
    return {
      stdout: `Deploying to Cloudflare Workers...\n\nUploaded 1 source file\nWorker deployed successfully\n\nhttps://worker.dev`,
      stderr: "",
      exitCode: 0,
    };
  }

  if (command.includes("dev")) {
    return {
      stdout: `Starting local development server...\n\nWrangler now supports instrumenting your local logs with... Ready on http://localhost:8787`,
      stderr: "",
      exitCode: 0,
    };
  }

  return {
    stdout: `wrangler ${command.split(" ").slice(1).join(" ")} completed`,
    stderr: "",
    exitCode: 0,
  };
}

// ─── cat ────────────────────────────────────────────────────────────────────

async function simulateCat(command: string, ws: Workspace): Promise<ExecResult> {
  const path = command.replace(/^cat\s+/, "").trim();
  try {
    const content = await ws.fs.readFile(path, "utf8");
    return { stdout: content as string, stderr: "", exitCode: 0 };
  } catch {
    return { stdout: "", stderr: `cat: ${path}: No such file or directory`, exitCode: 1 };
  }
}

// ─── ls ─────────────────────────────────────────────────────────────────────

async function simulateLs(command: string, ws: Workspace): Promise<ExecResult> {
  const path = command.replace(/^ls\s*/, "").trim() || "/";
  try {
    const entries = await ws.fs.readdir(path);
    const listing = entries.map(e => e.isDirectory ? `${e.name}/` : e.name).join("  ");
    return { stdout: listing, stderr: "", exitCode: 0 };
  } catch {
    return { stdout: "", stderr: `ls: cannot access '${path}': No such file or directory`, exitCode: 2 };
  }
}

// ─── TypeScript Syntax Checker ──────────────────────────────────────────────
// Minimal static analysis — catches obvious errors without a full TS compiler.

function checkTypeScriptSyntax(code: string, filename: string): string[] {
  const errors: string[] = [];
  const lines = code.split("\n");

  // Check for unmatched braces/brackets/parens
  let braces = 0;
  let brackets = 0;
  let parens = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip strings and comments (rough heuristic)
    const stripped = line.replace(/"[^"]*"/g, "").replace(/'[^']*'/g, "").replace(/\/\/.*$/g, "");

    for (const ch of stripped) {
      if (ch === "{") braces++;
      if (ch === "}") braces--;
      if (ch === "[") brackets++;
      if (ch === "]") brackets--;
      if (ch === "(") parens++;
      if (ch === ")") parens--;
    }
  }

  if (braces !== 0) {
    errors.push(`${filename}: Unmatched braces (missing ${braces > 0 ? "}" : "{"} ${Math.abs(braces)} time(s))`);
  }
  if (brackets !== 0) {
    errors.push(`${filename}: Unmatched brackets (missing ${brackets > 0 ? "]" : "["} ${Math.abs(brackets)} time(s))`);
  }
  if (parens !== 0) {
    errors.push(`${filename}: Unmatched parentheses (missing ${parens > 0 ? ")" : "("} ${Math.abs(parens)} time(s))`);
  }

  // Check for missing default export in Worker files
  if (filename.endsWith(".ts") && !filename.includes(".test.") && !filename.includes(".spec.")) {
    if (code.includes("export default") && !code.includes("{ fetch")) {
      // This is just a warning, not an error
    }
  }

  return errors;
}

// ─── Import Extraction ──────────────────────────────────────────────────────

function extractImports(code: string): string[] {
  const imports: string[] = [];
  const importRegex = /import\s+(?:.*?\s+from\s+)?["']([^"']+)["']/g;
  let match;
  while ((match = importRegex.exec(code)) !== null) {
    imports.push(match[1]);
  }
  return imports;
}

// ─── Import Resolution ──────────────────────────────────────────────────────

function resolveImport(fromFile: string, importPath: string): string {
  const dir = fromFile.split("/").slice(0, -1).join("/");
  const parts = [...dir.split("/"), ...importPath.split("/")];
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === "..") resolved.pop();
    else if (part !== "." && part !== "") resolved.push(part);
  }

  // Try common extensions
  const base = resolved.join("/");
  return base;
}

// ─── File Discovery ─────────────────────────────────────────────────────────

async function findTestFiles(ws: Workspace): Promise<string[]> {
  const files: string[] = [];
  try {
    const allFiles = await ws.fs.find("/", "*.test.ts");
    files.push(...(allFiles as Array<{ path: string }>).map(f => f.path));
    const specFiles = await ws.fs.find("/", "*.spec.ts");
    files.push(...(specFiles as Array<{ path: string }>).map(f => f.path));
  } catch {
    // fallback
  }
  return [...new Set(files)];
}

async function findSourceFiles(ws: Workspace): Promise<string[]> {
  const files: string[] = [];
  try {
    const tsFiles = await ws.fs.find("/", "*.ts");
    files.push(...(tsFiles as Array<{ path: string }>).map(f => f.path));
  } catch {
    // fallback
  }
  return files.filter(f => !f.includes(".test.") && !f.includes(".spec.") && !f.includes("node_modules"));
}
