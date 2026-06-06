# CrockBot - LinkedIn Network Manager

Prototype for a recruiter-facing LinkedIn network manager. It imports first-degree connections, lets an agent search/rank the local network, drafts outreach, and routes write actions through an explicit approval queue.

## What Works

- Import LinkedIn first-degree search results from an authenticated user session.
- Normalize imported connections into a local searchable network.
- Ask the agent network questions such as "top people working in supply chain".
- Create deterministic action intents for messages and connection requests.
- Review, approve, retry, and audit queued actions before execution.
- Execute approved LinkedIn messages through Unipile when configured.

## Architecture

- `src/routes/index.tsx` - agent chat UI.
- `src/routes/connections.tsx` - LinkedIn connection import and local network table.
- `src/routes/requests.tsx` - approval queue and worker controls.
- `src/lib/agent.functions.ts` - deterministic agent tools and action creation.
- `src/lib/action.queue.ts` - persistent action queue, status transitions, worker execution.
- `src/lib/import.jobs.ts` - background import jobs that survive route changes.
- `src/lib/linkedin.*.ts` - LinkedIn session/browser/read helpers.
- `src/lib/unipile.ts` - hosted auth and final message execution connector.

## Local Setup

```bash
npm install
npm run dev -- --host 127.0.0.1 --port 3000
```

Then open:

```text
http://127.0.0.1:3000/onboarding
```

Unipile provider settings can be saved from the onboarding screen. Runtime config, cookies, queues, and browser state are stored under `.sherpa/` and are intentionally ignored by Git.

## Demo Flow

1. Connect LinkedIn in onboarding.
2. Import first-degree connections from the Connections page.
3. Ask the agent to find/rank people in the network.
4. Ask the agent to draft or queue a message.
5. Approve the queued action in Requests.
6. Run the worker and inspect sent/failed status.

## Notes

LinkedIn write actions are intentionally separated from agent reasoning. The app owns search, ranking, queueing, approvals, and audit state. A connector can be used only for the final execution layer to avoid fragile cookie-based write automation.
