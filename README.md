# DevForge — AI Development Agent on Cloudflare

DevForge is an AI agent that builds Cloudflare Workers projects from natural-language
prompts, running **entirely on the Cloudflare free tier** — no paid plan, no credit card,
no virtual machines.

The user describes what they want; the agent plans, writes a durable virtual filesystem,
runs a static-analysis "test" pass, fixes failures, and requests a deployment that a human
reviews and approves.

## The flow

1. User sends a prompt ("Build me a hello-world Worker").
2. The agent (Workers AI + Granite 4.0 Micro, a few neurons per call) plans the project
   and emits **tool calls**.
3. Tools write files to a **durable virtual filesystem** backed by
   [@cloudflare/computer](https://www.npmjs.com/package/@cloudflare/computer)'s
   filesystem API over SQLite storage inside a Durable Object.
4. The agent runs `npm install` / `npm test` through a **simulated exec engine**
   (static analysis — no containers on the free tier).
5. On failure it reads the errors, edits code, and retries.
6. Once checks pass it requests a deploy, which is queued in KV for human approval.
7. The user approves in the UI.

## What's live

This repository is the code that powers a **production deployment** at
**https://devforge.creatorplntu.workers.dev** on a real Cloudflare account, with the
live agent verified end-to-end:

- **Real workers.dev subdomain** — `creatorplntu.workers.dev`.
- **Real KV namespace** — approvals & artifact fallback storage.
- **Real Durable Object** — `WorkspaceDO` with SQLite storage for the virtual filesystem.
- **Live AI binding** — the agent really calls `@cf/ibm-granite/granite-4.0-h-micro` and
  writes real files; verified: it wrote `src/index.ts` (a correct hello-world Worker) and
  `wrangler.toml`, ran simulated install/test, and queued a deploy across 9 iterations.

## Project layout

```
devforge/
├── src/
│   ├── index.ts         # Hono Worker: chat / file / deploy / approval API + static assets
│   ├── workspace.ts     # WorkspaceDO: @cloudflare/computer virtual FS + agent entry
│   ├── agent.ts         # Agent loop: plan -> write -> test -> fix -> deploy
│   ├── tools.ts         # AI tool definitions + execution (write/read/edit/ls/find/grep/delete/exec/deploy)
│   ├── exec-sim.ts      # Simulated shell: static validation instead of a real shell
│   ├── fs-helpers.ts    # ensureParentDirs (absolute-path parent creation)
│   ├── types.ts         # Shared types + Env bindings
│   └── logger.ts        # Structured logger
├── frontend/            # React + Vite UI (chat, file tree, approval queue)
├── test/                # Vitest unit tests (exec engine)
├── wrangler.toml        # Worker config: DO, AI, KV, assets
└── package.json
```

## Architecture

- **Worker** — a single Hono app serving the JSON API and the built frontend as static
  assets. Exposes `/api/chat`, `/api/files`, `/api/file/*`, `/api/deploy`, `/api/approvals`,
  `/api/approve`.
- **WorkspaceDO** — a Durable Object (SQLite backend) owning one `@cloudflare/computer`
  workspace per user. It hosts `runAgentLoop`, so the agent's file writes survive across
  requests and hibernation.
- **Agent** — a tool-calling loop over Granite. Each turn sends the message transcript plus
  JSON tool definitions; the model returns either text (done) or tool calls (write/read/
  edit/ls/find/grep/delete/exec/deploy).
- **KV** — the approval queue (`deploy:` keys) plus a size-sane artifact fallback in place
  of R2 (`artifact:` keys under `artifact:${deployId}...`).
- **exec-sim** — instead of a real Linux shell, validates file syntax and runs structural
  checks so the "test" step is honest while staying 100% free.

## The Granite schema gotcha

Workers AI's binding for `granite-4.0-h-micro` accepts **only** messages with plain
string `content` — i.e. the standard `role`/`content` pair. It **rejects** transcripts that
round-trip an assistant `tool_calls` message or a `role: "tool"` result, erroring with
`5006: oneOf at '/' not met`. The agent loop therefore flattens each completed tool call
into an ordinary user message quoting the tool name and its output. Multi-turn tool use
still works; the transcript just stays schema-safe.

## Free-tier reality

| Layer | Approach | Free? |
|-------|----------|-------|
| Virtual filesystem | `@cloudflare/computer` filesystem mode (DO SQLite storage) | ✅ |
| Agent model | `@cf/ibm-granite/granite-4.0-h-micro` (a few neurons/call) | ✅ |
| Shell exec | Simulated via static analysis (no containers) | ✅ |
| Approvals storage | KV (1 GB free tier) | ✅ |
| Artifacts | KV fallback (R2 is paid-only to enable on this account) | ✅ |
| Durable Objects | SQLite backend, free tier | ✅ |

A full Linux shell (real `npm install`, real `wrangler deploy` from inside the sandbox)
needs Cloudflare Containers / Dynamic Workers, which are **Workers Paid**. DevForge
deliberately uses the filesystem-only mode and a simulated exec engine to stay free.

## Prerequisites (to run your own instance)

- A Cloudflare account (a free one works — no card required).
- Node.js 20+ and npm.
- Workers AI enabled on the account.
- A KV namespace (approvals). Create one and put its id in `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "APPROVALS"
id = "<your-kv-namespace-id>"
```

- Decide your workers.dev subdomain (or rely on the account one).
- Build the frontend so `frontend/dist` exists before deploying.

## Development

```bash
# backend deps
npm install --legacy-peer-deps

# frontend deps
(cd frontend && npm install --legacy-peer-deps)

# build the frontend (into frontend/dist, served as static assets)
npm --prefix frontend run build

# run the executor tests
npx vitest run

# run wrangler dev
npm run dev
# visit http://localhost:8787
```

Try: **"Build me a hello-world worker"** in the chat.

## Deploy

```bash
npm --prefix frontend run build   # ensure assets are fresh
npm run deploy                    # wrangler deploy (Worker + DO + AI + KV + assets)
```

This uploads the Worker, reconciles the Durable Object, binds the AI runtime and the KV
namespace, and serves the built assets — landing at `https://<subdomain>.<account>.workers.dev`.

## Neuron budget

The free tier grants **10,000 neurons/day**. Granite 4.0 Micro costs roughly 1.5 input +
10 output neurons per M tokens, so a typical 5-iteration task uses a few hundred neurons.
`runAgentLoop` stops at 9,000 neurons/day to stay under the limit.

## Constraints & trade-offs

- **`exec` is simulated** — it validates syntax and runs structural checks rather than a
  real shell. This is the deliberate trade-off for the free tier.
- **Simulated deploy** — the agent packages files and queues an approval; the actual
  "worker goes live" step is the human-approved package in this prototype.
- **Single-user** — workspaces are keyed by an in-code `userId` (default `"default"`);
  the upstream Cloudflare OS auth layer is not ported.

## Tests

```bash
npx vitest run
```

Covers the simulated exec engine (npm install/test, wrangler dry-run, error cases).
