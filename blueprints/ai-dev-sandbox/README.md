# Blueprint: AI Dev Sandbox

A Cloudflare OS-style **Blueprint** describes a whole application — not just
content — so an EdgeForge agent can materialize a complete, deployable gadget
from a natural-language request.

What this blueprint encodes:

- **Gadget type** — a single, self-contained dynamic Worker (`dynamic-worker`,
  `workerd` runtime) that the agent writes into its sandboxed filesystem and
  that the approval Gatekeeper can push to a live `*.workers.dev` URL.
- **Bindings** — the platform may mount the `AI`, `APPROVALS`, and `BUDGET`
  bindings; `ARTIFACTS` (R2) is optional since it is opt-in on the free tier.
- **Agent contract** — model choice (`granite-4.0-h-micro`, a few neurons per
  call), `maxIterations`, `maxFixRetries`, and the rules the agent must follow
  (write tests before deploying, never deploy untested code).
- **Gatekeeper** — `deploy` actions are queued for human approval; nothing
  reaches the internet without it.

`template/` is the initial file set the agent seeds a new project from —
`package.json`, `wrangler.jsonc`, `src/index.ts`, and `test/index.test.ts`,
matching what EdgeForge itself scaffolds in offline mode.