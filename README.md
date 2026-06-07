# LinkedIn Network Manager

An assignment-grade prototype for managing a LinkedIn network with an agent, deterministic search, approval-gated actions, and a production-safe execution boundary.

The app answers questions over imported connections, creates auditable outreach intents, and sends approved LinkedIn messages through a connector layer when configured.

## Live Demo

- App: https://social-sherpa-blond.vercel.app
- Primary demo path: `Onboarding -> Connect LinkedIn -> AI Agent -> Requests`

The hosted app disables cookie-based browser import because Vercel serverless cannot run a persistent Chrome profile. Local development can still use the cookie/browser importer.

## Core Capabilities

- Search and rank imported first-degree LinkedIn connections.
- Answer network questions such as "top 3 people working in supply chain".
- Draft LinkedIn DMs and connection request notes.
- Convert agent output into deterministic action intents.
- Require explicit approval before any write action is executed.
- Track action status, attempts, errors, timestamps, and next retry time.
- Execute approved LinkedIn DMs through Unipile when configured.
- Receive Unipile webhook events for messaging/status sync.

## System Design

```text
User
  |
  v
TanStack Start UI
  |-- AI Agent page
  |-- Connections page
  |-- Requests approval queue
  |-- Onboarding / provider connection
  |
  v
Server Functions
  |-- agent.functions.ts      -> intent parsing, search, ranking, tool calls
  |-- action.queue.ts         -> approval queue, worker, retry state
  |-- import.jobs.ts          -> local browser import jobs
  |-- unipile.ts              -> hosted auth and final LinkedIn execution
  |
  v
Execution Boundary
  |-- Local only: Playwright/Patchright browser importer
  |-- Hosted: Unipile connector for approved LinkedIn actions
  |
  v
Runtime Store
  |-- local: .sherpa/
  |-- hosted: /tmp/social-sherpa
```

## Why The Execution Boundary Exists

The agent never directly performs LinkedIn write actions. It can only create a queued intent. A separate worker executes approved actions and records the result.

This separation keeps the system deterministic:

- Agent reasoning is testable and auditable.
- User approval is mandatory for outbound actions.
- Failed sends remain visible with error details.
- The execution provider can change without rewriting the agent.

## Request Lifecycle

```text
drafted -> pending approval -> approved -> running -> sent
                                      |         |
                                      |         -> failed / retrying
                                      -> cancelled
```

The agent can inspect queue state and should tell the user when an import or another action is already running. This avoids pretending that a message was sent before the worker actually marks it as `sent`.

## Important Files

- `src/routes/index.tsx` - chat interface for the network agent.
- `src/routes/connections.tsx` - connection import UI and searchable table.
- `src/routes/requests.tsx` - approval queue and worker controls.
- `src/routes/onboarding.tsx` - provider connection flow.
- `src/routes/api/webhooks/unipile.ts` - Unipile webhook receiver.
- `src/lib/agent.functions.ts` - deterministic agent tools and fallback logic.
- `src/lib/action.queue.ts` - queue state machine and execution worker.
- `src/lib/import.jobs.ts` - browser import job orchestration.
- `src/lib/linkedin.*.ts` - local browser/session helpers.
- `src/lib/unipile.ts` - hosted LinkedIn connector integration.

## Local Setup

```bash
npm install
npm run dev -- --host 127.0.0.1 --port 3000
```

Open:

```text
http://127.0.0.1:3000
```

## Environment

Copy `.env.example` to `.env.local` and configure only what you need.

```bash
cp .env.example .env.local
```

Common variables:

- `FIREWORKS_API_KEY` - optional LLM provider for the agent.
- `ANTHROPIC_API_KEY` - optional LLM provider for the agent.
- `UNIPILE_ENABLED` - enables hosted action execution.
- `UNIPILE_DSN` - Unipile API base URL.
- `UNIPILE_API_KEY` - Unipile API key.
- `UNIPILE_ACCOUNT_ID` - optional connected account id.
- `UNIPILE_WEBHOOK_SECRET` - optional webhook token.
- `SHERPA_DATA_DIR` - optional runtime data directory.

If no LLM key is present, the agent falls back to deterministic local logic over real imported connections only.

## Unipile Webhook

Create a Messaging webhook in Unipile:

```text
https://social-sherpa-blond.vercel.app/api/webhooks/unipile
```

If `UNIPILE_WEBHOOK_SECRET` is set, configure the URL as:

```text
https://social-sherpa-blond.vercel.app/api/webhooks/unipile?token=<secret>
```

The webhook route accepts account/message events and stores a lightweight runtime event log for demo inspection.

## Hosted vs Local Behavior

Hosted Vercel:

- Uses Unipile for approved LinkedIn write actions.
- Disables cookie-based browser import because serverless functions cannot keep Chrome/profile state alive.

Local development:

- Can run Playwright/Patchright browser flows.
- Can import from an authenticated LinkedIn browser session.
- Stores runtime state in `.sherpa/`.

## Production Notes

For a real multi-user deployment:

- Replace the runtime file store with Postgres, Supabase, Neon, or another durable database.
- Move the queue worker to a durable background worker.
- Store provider tokens in encrypted server-side storage.
- Use per-user Unipile accounts or another approved provider account mapping.
- Persist webhook events and reconcile delivery status into the queue.
- Add auth before exposing user data or queue controls.

## Verification

```bash
npm run lint
npm run build
```

Current lint output has existing warnings around `any` types and Fast Refresh component exports, but no blocking errors after cleanup.
