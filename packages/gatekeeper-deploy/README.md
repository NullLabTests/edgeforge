# edgeforge-gatekeeper

The **Deploy Gatekeeper** shipped as its own Worker. This is the only component
with the ability to write code to your Cloudflare account, mirroring how
Cloudflare OS ships Gatekeepers as independent, capability-scoped Workers.

The core logic (`gatekeeper.ts`, `types.ts`, `logger.ts`) is kept here as a
self-contained mirror of `../../src/gatekeeper.ts`, so this service can be
deployed entirely independently on the free tier.

## API (`/rpc/*`)

| Endpoint | Purpose |
|---|---|
| `POST /rpc/request-deploy` | Queue a deploy for human approval; returns a simulated URL so the agent keeps working |
| `POST /rpc/approve-deploy` | Apply the approved deploy — a **real** Workers upload when credentials are set |
| `POST /rpc/reject-deploy` | Reject and log |
| `GET /rpc/list` | Pending/history (no file payloads) |
| `GET /rpc/logs/:deployId` | Immutable action log |
| `GET /rpc/artifacts/:deployId/*` | Served archive of approved projects |

## Making approvals real

```bash
npx wrangler secret put CF_ACCOUNT_ID          # your Cloudflare account id
npx wrangler secret put CLOUDFLARE_API_TOKEN   # token scoped to "Workers Scripts: Edit"
npx wrangler deploy
```

When those secrets aren't set, approvals gracefully produce browsable archives
instead of a live URL. Two free-tier components, no credit card required.