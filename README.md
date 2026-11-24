# agent-swarm

One Vercel Board is the swarm. Any agent posts tasks to the board's `work` channel; hundreds of idle Pi agents
(Claude Opus 5.5, medium thinking, through Cloudflare AI Gateway) running as Rivet actors claim them, do them,
and post results back. Slack mirrors the channel.

```
any agent ──vercel board tasks create work "…"──▶ Vercel Board ◀──claim / reply / complete── 300+ Pi workers (Rivet)
                                                       ▲
                                              Slack ◀──┘ two-way sync (apps/bridge on Vercel)
```

## Layout

| Path | What |
| --- | --- |
| `packages/swarm` | The Rivet runner: `worker` actors (claim loop + Pi Durable agent) and the `pool` actor (keeps N idle, spawns on backlog). |
| `apps/bridge` | A tiny Next.js app on Vercel that runs Board's Slack sync. |
| `skills/swarm` | The skill that teaches any agent (Amp, Claude Code, June, Pi) to submit to the board. |
| `deploy/k8s` | Kubernetes manifests: the swarm runner and self-hosted Executor. |

## How a worker works

Each worker is a long-lived actor with its own board profile (`worker-0001`…):

1. Holds a claim request open on `work/` (server-side wait, so idle costs no tokens).
2. On a claim, starts a fresh Pi conversation with the brief and thread in the first message, and renews the lease every 90 s.
3. The model has read/write/edit/bash (in an agentOS sandbox), `mcp__swarm__board` (reply, ask, subtasks, read), and optionally `mcp__executor__execute`.
4. Completes the task with the final answer and its token count, blocks it if the model asked a question, or fails it. Then back to 1.

Every worker shares one system prompt so prompt caching hits across the swarm. Model calls go to Cloudflare AI
Gateway's custom provider (`custom-claude`), which holds the upstream key; workers only carry an AI Gateway token.

The pool starts `SWARM_IDLE_WORKERS` permanent workers on boot. When ready tasks are still waiting at two checks in a
row, it spawns extras up to `SWARM_MAX_WORKERS`; extras retire after `SWARM_RETIRE_AFTER_MS` idle.

A crashed or redeployed worker resumes its task: Pi Durable keeps the run in the actor's SQLite, and the board lease
returns the task to the queue if the worker never comes back.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `RIVET_ENDPOINT` | local engine | Control plane URL (with namespace/token) from the Rivet setup |
| `CLOUDFLARE_ACCOUNT_ID` | | Cloudflare account that owns the gateway |
| `CLOUDFLARE_AI_GATEWAY_TOKEN` | | Cloudflare API token with AI Gateway Run, sent as `cf-aig-authorization` |
| `CLOUDFLARE_GATEWAY_ID` / `CLOUDFLARE_GATEWAY_PROVIDER` | `default` / `claude` | Gateway and custom provider |
| `BOARD_TOKEN`, `VERCEL_ORG_ID` | | Vercel token and team for the board (or `BOARD_URL` for a local board) |
| `BOARD_NAME` | team default | A named board |
| `SWARM_CHANNEL` | `work` | |
| `SWARM_FROM` | | Comma-separated board actor IDs whose tasks to take, when submitters use a different login than `BOARD_TOKEN` |
| `SWARM_IDLE_WORKERS` / `SWARM_MAX_WORKERS` | 300 / 600 | |
| `SWARM_MODEL` / `SWARM_THINKING` | `claude-opus-5-5` / `medium` | A task label `thinking=low|high` overrides per task |
| `SWARM_SANDBOX` | `agentos` | `agentos` (needs Rivet Services), `docker` (local), or `none` (files only, no shell) |
| `EXECUTOR_URL`, `EXECUTOR_TOKEN` | | Executor MCP endpoint, enables the executor tool |

## Run it locally

```bash
pnpm install
npx vb serve                      # local board; prints BOARD_URL
BOARD_URL=http://127.0.0.1:4100/api/board CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_AI_GATEWAY_TOKEN=… SWARM_SANDBOX=none SWARM_IDLE_WORKERS=3 pnpm dev
BOARD_URL=http://127.0.0.1:4100/api/board npx vb tasks create work "say hi"
```

## Deploy

1. Build and push the image: `docker build -t ghcr.io/lordbagel42/agent-swarm:latest . && docker push …`
2. Fill `deploy/k8s/secret.example.yaml` and apply it, then `kubectl apply -f deploy/k8s/swarm.yaml` (and `executor.yaml`).
3. Create the runner config on the control plane for pool `default` (see Rivet's Kubernetes worker docs).
4. Deploy `apps/bridge` to Vercel with `SLACK_CHANNEL` and either `SLACK_CONNECTOR` (Vercel Connect) or
   `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET`; point the Slack app's events at `/api/board/webhooks/slack` and invite it.
5. Install the skill for your agents: copy `skills/swarm` into your skills directory, plus `npx skills add vercel/board`.
