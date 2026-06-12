import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { enqueueAction, readQueueActions } from "@/lib/action.queue";
import type { Connection } from "@/lib/connections.types";

const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  tool_call_id: z.string().optional(),
  tool_calls: z.any().optional(),
  name: z.string().optional(),
});

export type ChatMessage = z.infer<typeof MessageSchema>;

export type QueuedAction = {
  id: string;
  type: "connection_request" | "message" | "email" | "profile_view";
  target_id: string;
  target_name: string;
  target_url?: string;
  channel: string;
  subject?: string;
  body: string;
  reasoning: string;
  status: "pending";
  created_at: string;
};

const SYSTEM_PROMPT = `You are a friendly, sharp LinkedIn Network Manager assistant — like a helpful colleague who knows the user's network well. Talk naturally and conversationally, the way a good chat assistant does: warm, clear, and to the point. Never sound robotic or list rigid rules back at the user.

WHAT YOU HELP WITH:
- Answering questions about the user's connections — how many they have, who they are, who works where, who fits a role or topic.
- Drafting personalized outreach and queueing actions (LinkedIn DMs, emails, connection requests, profile views) for the user to approve.

HOW TO ANSWER:
- A "LIVE NETWORK DATA" section below contains the user's real connections and counts. Answer questions about their network DIRECTLY from it — in plain, friendly language. Do NOT call a tool just to count or list connections; that data is already in front of you.
- Only call a tool when the user actually wants to TAKE an action (queue a message, email, connection request, or profile view), or to search a network too large to see in full.
- For simple questions ("how many do I have", "who works at X", "find me marketing people"), just reply conversationally. No tools, no preamble.

ACTION RULES (only when queueing something):
- You NEVER send anything to LinkedIn directly. Every action is queued for the user to approve in the "Requests" tab, and a background worker sends approved ones automatically — don't tell users to copy-paste or visit profiles manually.
- Personalize each message using the person's company/headline. Keep DMs under 300 characters and emails under 150 words.
- For "top N" requests, rank by relevance and seniority signals in the headline.
- During early account warmup, prefer profile views to gently warm targets before messaging.
- Only queue a new connection request if the user gives the target's full LinkedIn profile URL.
- After queueing, briefly say what you queued and point them to the Requests tab.
- Use only the connections in the data below — never invent people. If there are none yet, say so warmly and point them to import from the Connections page.

Be the kind of assistant people actually enjoy talking to: helpful first, concise, and human.`;

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name || "there";
}

function wantsBroadMessage(lower: string) {
  return (
    /\b(send|message|dm|contact|outreach)\b/i.test(lower) &&
    /\b(my\s+)?(connections|network|contacts|people)\b/i.test(lower)
  );
}

function extractRequestedMessage(userMessage: string) {
  const quoted = userMessage.match(/["']([^"']{1,280})["']/)?.[1]?.trim();
  if (quoted) return quoted;
  if (/\bhi\b/i.test(userMessage)) return "Hi {first}, hope you're doing well.";
  if (/\bhello\b/i.test(userMessage)) return "Hello {first}, hope you're doing well.";
  return "Hi {first}, hope you're doing well.";
}

async function queueActionForApproval(action: QueuedAction) {
  await enqueueAction({
    data: {
      type: action.type,
      targetName: action.target_name,
      targetUrl:
        action.type === "connection_request"
          ? action.target_url
          : (action as any).target_url || undefined,
      threadUrl:
        action.type === "message" && action.target_id.startsWith("thread:")
          ? `https://www.linkedin.com/messaging/thread/${action.target_id.slice("thread:".length)}`
          : undefined,
      profileUrn: undefined,
      body: action.body,
      reasoning: action.reasoning,
    },
  });
}

async function deterministicActionAgent(userMessage: string, pool: Connection[]) {
  const lower = userMessage.toLowerCase();
  if (!wantsBroadMessage(lower)) return null;

  if (!pool.length) {
    return {
      assistant:
        "I do not have imported connections yet. Go to Connections, sync/import at least one connection, then ask me to message them.",
      actions: [] as QueuedAction[],
    };
  }

  const topN = lower.match(/top\s+(\d+)/)?.[1];
  const limit = topN ? Math.max(1, Math.min(Number(topN), 10)) : Math.min(pool.length, 5);
  const template = extractRequestedMessage(userMessage);
  const recipients = pool.slice(0, limit);
  const created_at = new Date().toISOString();

  const actions: QueuedAction[] = recipients.map((c) => {
    const body = template.replaceAll("{first}", firstName(c.name));
    return {
      id: crypto.randomUUID(),
      type: "message",
      target_id: c.id,
      target_name: c.name,
      target_url: (c as any).profileUrl,
      channel: "LinkedIn DM",
      body,
      reasoning: `User asked to message imported connections; ${c.name} is in the current connection list.`,
      status: "pending",
      created_at,
    };
  });

  for (const action of actions) await queueActionForApproval(action);

  const names = recipients.map((c) => c.name).join(", ");
  return {
    assistant: `Queued ${actions.length} LinkedIn message${actions.length === 1 ? "" : "s"} for approval: ${names}.\n\nOpen Requests to approve or reject before anything is marked sent.`,
    actions,
  };
}

function rankConnections(pool: Connection[], query: string, limit: number): Connection[] {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = pool
    .map((c) => {
      const hay = `${c.name} ${c.headline} ${c.company} ${c.tags.join(" ")}`.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (hay.includes(t)) score += 2;
        for (const tag of c.tags) if (tag.includes(t)) score += 3;
      }
      if (/vp|head|chief|founder|director|sr\.?|senior|lead/i.test(c.headline)) score += 1;
      return { c, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map((s) => s.c);
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_connections",
      description:
        "Search the user's LinkedIn connections by topic, role, or keywords. Returns ranked matches.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Topic/role/keywords e.g. 'supply chain'" },
          limit: { type: "number", description: "Max results", default: 5 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "queue_linkedin_message",
      description:
        "Queue a personalized LinkedIn DM to a connection for user approval. Does NOT send.",
      parameters: {
        type: "object",
        properties: {
          target_id: { type: "string" },
          body: { type: "string", description: "DM body, <300 chars, personalized" },
          reasoning: {
            type: "string",
            description: "One sentence: why this person, why this message",
          },
        },
        required: ["target_id", "body", "reasoning"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "queue_email",
      description: "Queue a personalized email to a connection for user approval. Does NOT send.",
      parameters: {
        type: "object",
        properties: {
          target_id: { type: "string" },
          subject: { type: "string" },
          body: { type: "string", description: "Email body, <150 words" },
          reasoning: { type: "string" },
        },
        required: ["target_id", "subject", "body", "reasoning"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "queue_connection_request",
      description:
        "Queue a new LinkedIn connection request with personalized note for user approval.",
      parameters: {
        type: "object",
        properties: {
          target_name: {
            type: "string",
            description: "Name of person to connect with (not yet in network)",
          },
          target_url: {
            type: "string",
            description: "Full LinkedIn profile URL, e.g. https://www.linkedin.com/in/name/",
          },
          body: { type: "string", description: "Connection note, <280 chars" },
          reasoning: { type: "string" },
        },
        required: ["target_name", "target_url", "body", "reasoning"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "queue_profile_view",
      description:
        "Queue a soft 'profile view' of a 1st-degree connection. Useful during account warmup before sending messages.",
      parameters: {
        type: "object",
        properties: {
          target_id: { type: "string" },
          reasoning: { type: "string" },
        },
        required: ["target_id", "reasoning"],
      },
    },
  },
];

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

type OpsContext = {
  import?: {
    status?: "idle" | "running" | "done" | "failed";
    requestedCount?: number;
    importedCount?: number;
    totalAvailable?: number;
    message?: string;
  };
};

type QueueContext = Array<{
  id: string;
  type: string;
  target_name: string;
  status: string;
  created_at?: string;
  updated_at?: string;
  next_run_at?: string;
  sent_at?: string;
  last_error?: string;
  attempts?: number;
}>;

function wantsAction(lower: string) {
  return /\b(send|message|dm|contact|outreach|connect|invite|view)\b/i.test(lower);
}

function wantsQueueStatus(lower: string) {
  return (
    /\b(queue|queued|pending|approved|status|happening|happen|running|progress|line|next|sent|go|went|worker|failed|error)\b/i.test(
      lower,
    ) || /\bdid\s+it\b/i.test(lower)
  );
}

function queueSummary(queue: QueueContext) {
  const pending = queue.filter((a) => a.status === "pending").length;
  const approved = queue.filter(
    (a) =>
      a.status === "approved" ||
      a.status === "retrying" ||
      a.status === "running" ||
      a.status === "sending",
  ).length;
  const sent = queue.filter((a) => a.status === "sent").length;
  const failed = queue.filter((a) => a.status === "failed").length;
  const next =
    queue.find((a) => a.status === "running" || a.status === "sending") ||
    queue.find(
      (a) =>
        (a.status === "approved" || a.status === "retrying") &&
        (!a.next_run_at || new Date(a.next_run_at).getTime() <= Date.now()),
    ) ||
    queue.find((a) => a.status === "approved" || a.status === "retrying") ||
    queue.find((a) => a.status === "pending");
  return { pending, approved, sent, failed, next };
}

function describeQueueItem(a: QueueContext[number]) {
  const parts = [`${a.type} for ${a.target_name}`, `status: ${a.status}`];
  if (a.next_run_at && (a.status === "approved" || a.status === "retrying")) {
    const nextRun = new Date(a.next_run_at);
    parts.push(
      nextRun.getTime() <= Date.now()
        ? "worker due now"
        : `next run: ${nextRun.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`,
    );
  }
  if (a.sent_at)
    parts.push(
      `sent: ${new Date(a.sent_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`,
    );
  if (a.last_error) parts.push(`last error: ${a.last_error}`);
  return parts.join(" | ");
}

function operationalAnswer(userMessage: string, ops: OpsContext, queue: QueueContext) {
  const lower = userMessage.toLowerCase();
  const importState = ops.import;
  const q = queueSummary(queue);
  const queuedMatch = wantsAction(lower)
    ? queue.find(
        (a) =>
          a.target_name &&
          lower.includes(a.target_name.toLowerCase()) &&
          ["pending", "approved", "sending"].includes(a.status),
      )
    : undefined;

  if (queuedMatch) {
    return {
      assistant:
        `${queuedMatch.target_name} already has a ${queuedMatch.type} task in the queue with status "${queuedMatch.status}". ` +
        "I will not create a duplicate. Check Requests for its position and approval state.",
      actions: [] as QueuedAction[],
    };
  }

  if (importState?.status === "running" && wantsAction(lower)) {
    return {
      assistant:
        `Connection import is running right now (${importState.requestedCount ?? "selected"} requested). ` +
        "I will not queue new LinkedIn actions until the import finishes, so the account does one job at a time. " +
        `Current queue: ${q.pending} pending approval, ${q.approved} approved/running.`,
      actions: [] as QueuedAction[],
    };
  }

  if (wantsQueueStatus(lower)) {
    const importLine =
      importState?.status === "running"
        ? `Import: running (${importState.requestedCount ?? "selected"} requested).`
        : importState?.status === "done"
          ? `Import: done (${importState.importedCount ?? 0}${importState.totalAvailable ? ` of about ${importState.totalAvailable}` : ""} imported).`
          : importState?.status === "failed"
            ? `Import: failed - ${importState.message || "last import did not complete"}.`
            : "Import: idle.";
    const nextLine = q.next
      ? `Next queue item: ${describeQueueItem(q.next)}.`
      : "Next queue item: none.";
    const recent = queue
      .filter((a) => ["running", "approved", "retrying", "failed", "sent"].includes(a.status))
      .slice(-3)
      .reverse()
      .map((a) => `- ${describeQueueItem(a)}`)
      .join("\n");
    return {
      assistant:
        `${importLine}\n\nQueue: ${q.pending} pending approval, ${q.approved} approved/running/retrying, ${q.sent} sent, ${q.failed} failed.\n${nextLine}\n\nOnly actions with status "sent" have actually gone through LinkedIn.` +
        (recent ? `\n\nRecent tracked actions:\n${recent}` : ""),
      actions: [] as QueuedAction[],
    };
  }

  return null;
}

function executeTool(
  pool: Connection[],
  name: string,
  args: Record<string, unknown>,
): {
  result: unknown;
  action?: QueuedAction;
} {
  if (name === "search_connections") {
    const matches = rankConnections(pool, String(args.query ?? ""), Number(args.limit ?? 5));
    return { result: { matches } };
  }
  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();
  if (name === "queue_linkedin_message") {
    const target = pool.find((c) => c.id === args.target_id);
    if (!target) return { result: { error: "connection not found" } };
    const action: QueuedAction = {
      id,
      type: "message",
      target_id: target.id,
      target_name: target.name,
      target_url: (target as any).profileUrl,
      channel: "LinkedIn DM",
      body: String(args.body),
      reasoning: String(args.reasoning),
      status: "pending",
      created_at,
    };
    return { result: { queued: true, action_id: id }, action };
  }
  if (name === "queue_email") {
    const target = pool.find((c) => c.id === args.target_id);
    if (!target) return { result: { error: "connection not found" } };
    const action: QueuedAction = {
      id,
      type: "email",
      target_id: target.id,
      target_name: target.name,
      channel: "Email",
      subject: String(args.subject),
      body: String(args.body),
      reasoning: String(args.reasoning),
      status: "pending",
      created_at,
    };
    return { result: { queued: true, action_id: id }, action };
  }
  if (name === "queue_connection_request") {
    const targetUrl = String(args.target_url ?? "").trim();
    if (!/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/(in|pub)\//i.test(targetUrl)) {
      return { result: { error: "full LinkedIn profile URL required for connection request" } };
    }
    const action: QueuedAction = {
      id,
      type: "connection_request",
      target_id: targetUrl,
      target_name: String(args.target_name),
      target_url: targetUrl,
      channel: "LinkedIn Invite",
      body: String(args.body),
      reasoning: String(args.reasoning),
      status: "pending",
      created_at,
    };
    return { result: { queued: true, action_id: id }, action };
  }
  if (name === "queue_profile_view") {
    const target = pool.find((c) => c.id === args.target_id);
    if (!target) return { result: { error: "connection not found" } };
    const action: QueuedAction = {
      id,
      type: "profile_view",
      target_id: target.id,
      target_name: target.name,
      target_url: (target as any).profileUrl,
      channel: "LinkedIn Profile View",
      body: "(silent profile view)",
      reasoning: String(args.reasoning),
      status: "pending",
      created_at,
    };
    return { result: { queued: true, action_id: id }, action };
  }
  return { result: { error: "unknown tool" } };
}

// ── Offline fallback: deterministic agent (no API key needed for demo) ────────
// Offline fallback: deterministic agent when no API key is configured.
function offlineAgent(
  userMessage: string,
  pool: Connection[],
): { assistant: string; actions: QueuedAction[] } {
  const lower = userMessage.toLowerCase();
  const trimmed = userMessage.trim();
  const topN = lower.match(/top\s+(\d+)/)?.[1];
  const limit = topN ? parseInt(topN, 10) : 10;

  const isGreeting =
    /^(hi|hey|hello|yo|sup|what|ok|okay)\??$/i.test(trimmed) ||
    /\b(are you live|you there|are you working)\b/i.test(lower);
  const wantsMessage =
    lower.includes("message") ||
    lower.includes("dm") ||
    lower.includes("outreach") ||
    lower.includes("contact") ||
    lower.includes("send");
  const wantsEmail = lower.includes("email") || lower.includes("mail");
  const wantsInbox =
    lower.includes("inbox") || lower.includes("summarize") || lower.includes("summary");

  if (wantsInbox) {
    return {
      assistant:
        "Inbox automation is paused in this build so the LinkedIn session stays quiet. I can still search imported connections and queue approved outreach/actions.",
      actions: [],
    };
  }

  if (isGreeting) {
    return {
      assistant: pool.length
        ? `I'm live. I can search and queue actions for your ${pool.length} imported LinkedIn connection${pool.length === 1 ? "" : "s"}. Try "list my connections" or "send hi to [name]".`
        : "I'm live, but I don't have any real imported LinkedIn connections yet. Connect/sync LinkedIn from Connections first, then I can search, rank, and queue actions.",
      actions: [],
    };
  }

  const wantsAllConnections =
    /\b(list|show|all|who|top|find|give)\b.*\b(connection|contact|people|network)\b/i.test(lower) ||
    /\b(connection|contact)\b.*\b(list|show|all)\b/i.test(lower);

  if (wantsAllConnections && !wantsMessage && !wantsEmail) {
    if (!pool.length) {
      return {
        assistant:
          "You don't have any real imported connections yet. Go to Connections and sync/import LinkedIn first.",
        actions: [],
      };
    }
    const showing = pool.slice(0, Math.min(limit, pool.length));
    const list = showing
      .map(
        (c, i) =>
          `${i + 1}. **${c.name}** - ${c.headline || "-"} ${c.company ? `@ ${c.company}` : ""}`,
      )
      .join("\n");
    const moreNote =
      pool.length > showing.length ? `\n\n...and ${pool.length - showing.length} more.` : "";
    return {
      assistant: `Here are your ${showing.length} imported connection${showing.length === 1 ? "" : "s"}:\n\n${list}${moreNote}\n\nWant me to draft outreach for any of them?`,
      actions: [],
    };
  }

  if (!pool.length) {
    return {
      assistant:
        "I don't have any real imported connections yet. Go to Connections and sync/import LinkedIn, then ask me to search or queue outreach.",
      actions: [],
    };
  }

  return {
    assistant:
      `I have ${pool.length} imported connection${pool.length === 1 ? "" : "s"}. ` +
      'Tell me the exact network task, for example: "list my connections", "top 3 supply chain contacts", or "send hi to [name]".',
    actions: [],
  };
}
const ConnectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  headline: z.string(),
  company: z.string(),
  location: z.string().optional().default(""),
  tags: z.array(z.string()),
  profileUrl: z.string().optional(),
  email: z.string().optional(),
  connectedAt: z.number().optional(),
});

const OpsSchema = z
  .object({
    import: z
      .object({
        status: z.enum(["idle", "running", "done", "failed"]).optional(),
        requestedCount: z.number().optional(),
        importedCount: z.number().optional(),
        totalAvailable: z.number().optional(),
        message: z.string().optional(),
      })
      .optional(),
  })
  .optional();

const QueueContextSchema = z
  .array(
    z.object({
      id: z.string(),
      type: z.string(),
      target_name: z.string(),
      status: z.string(),
      created_at: z.string().optional(),
      updated_at: z.string().optional(),
      next_run_at: z.string().optional(),
      sent_at: z.string().optional(),
      last_error: z.string().optional(),
      attempts: z.number().optional(),
    }),
  )
  .max(500)
  .optional();

// Instant, free answer for plain factual questions ("how many connections do I have?")
// so they never spend a slow model round-trip — and never loop looking for a count tool.
function instantAnswer(userMessage: string, pool: Connection[]): string | null {
  const lower = userMessage.toLowerCase().trim();
  const asksCount =
    /\b(how many|number of|count|total)\b/.test(lower) &&
    /\b(connection|connections|contact|contacts|lead|leads|people|network)\b/.test(lower);
  if (asksCount) {
    if (!pool.length) {
      return "You don't have any imported connections yet. Head to the Connections page and import from LinkedIn — then I can tell you exactly how many you've got.";
    }
    return (
      `You currently have ${pool.length} imported connection${pool.length === 1 ? "" : "s"} in your network. ` +
      "Want me to list some, find people by role or company, or draft outreach to anyone?"
    );
  }
  return null;
}

// The live network snapshot the model reads to answer directly — counts, warmup state,
// queue state, and a roster of real connections. This is what stops the model from
// calling tools (or looping) just to count or list people.
function buildNetworkContext(
  pool: Connection[],
  queue: QueueContext,
  warmupDay: number | undefined,
  ops: OpsContext,
): string {
  const lines: string[] = [
    "\n\n--- LIVE NETWORK DATA (answer questions about the network directly from this; do not call a tool just to count or list) ---",
    `Total imported connections: ${pool.length}.`,
  ];
  if (typeof warmupDay === "number") {
    lines.push(`Account warmup: day ${warmupDay} of 14.`);
  }
  if (ops.import?.status) {
    const imported =
      typeof ops.import.importedCount === "number" ? ` (${ops.import.importedCount} imported)` : "";
    lines.push(`Last import: ${ops.import.status}${imported}.`);
  }
  if (queue.length) {
    const pending = queue.filter((a) => a.status === "pending").length;
    lines.push(`Action queue: ${pending} pending approval, ${queue.length} total.`);
  }
  if (pool.length) {
    const SHOWN = 60;
    lines.push(
      "\nEach connection below may include a profile URL and the date you connected. " +
        "Share these when asked. A missing connected-date means LinkedIn didn't provide one for that person.",
    );
    lines.push(
      `\nConnections${pool.length > SHOWN ? ` (showing first ${SHOWN} of ${pool.length})` : ""}:`,
    );
    pool.slice(0, SHOWN).forEach((c, i) => {
      const company = c.company ? ` @ ${c.company}` : "";
      const url = c.profileUrl ? ` · ${c.profileUrl}` : "";
      const connected =
        typeof c.connectedAt === "number"
          ? ` · connected ${new Date(c.connectedAt).toLocaleDateString("en-US", {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}`
          : "";
      lines.push(
        `${i + 1}. ${c.name} — ${c.headline || "no headline"}${company}${connected}${url}`,
      );
    });
  } else {
    lines.push("The user has not imported any connections yet.");
  }
  return lines.join("\n");
}

// Convert our internal OpenAI-style message log into valid Anthropic Messages format:
// assistant tool calls become tool_use blocks, and tool results become a user turn with
// tool_result blocks whose ids match. The old code flattened these into plain text, which
// broke multi-turn tool use and caused the model to loop.
function toAnthropicMessages(messages: ChatMessage[]) {
  const out: Array<{ role: "user" | "assistant"; content: any }> = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const blocks: any[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of (m.tool_calls as ToolCall[] | undefined) || []) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {
          /* noop */
        }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      out.push({ role: "assistant", content: blocks.length ? blocks : m.content || "" });
    } else if (m.role === "tool") {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }],
      });
    }
  }
  return out;
}

export const runAgent = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      messages: z.array(MessageSchema).min(1).max(50),
      connections: z.array(ConnectionSchema).max(5000).optional(),
      warmupDay: z.number().min(0).max(14).optional(),
      ops: OpsSchema,
      queue: QueueContextSchema,
    }),
  )
  .handler(async ({ data }) => {
    const pool: Connection[] = (data.connections || []) as Connection[];
    const lastUserMsg = [...data.messages].reverse().find((m) => m.role === "user");
    const serverQueue = await readQueueActions().catch(() => []);
    const queueContext: QueueContext = serverQueue.length
      ? serverQueue.map((a) => ({
          id: a.id,
          type: a.type,
          target_name: a.targetName,
          status: a.status,
          created_at: a.createdAt,
          updated_at: a.updatedAt,
          next_run_at: a.nextRunAt,
          sent_at: a.sentAt,
          last_error: a.lastError,
          attempts: a.attempts,
        }))
      : data.queue || [];
    const instant = instantAnswer(lastUserMsg?.content ?? "", pool);
    if (instant) return { assistant: instant, actions: [] as QueuedAction[] };
    const operational = operationalAnswer(lastUserMsg?.content ?? "", data.ops || {}, queueContext);
    if (operational) return operational;
    const deterministic = await deterministicActionAgent(lastUserMsg?.content ?? "", pool);
    if (deterministic) return deterministic;

    const warmupNote =
      typeof data.warmupDay === "number"
        ? `\n\nUSER CONTEXT: Account warmup day ${data.warmupDay} of 14. ${data.warmupDay < 5 ? "Strongly prefer profile_view actions; avoid invites." : "Limited messages allowed."}`
        : "";

    // Priority: Fireworks > Anthropic > deterministic offline fallback.
    const fireworksKey = process.env.FIREWORKS_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;

    if (!fireworksKey && !anthropicKey) {
      const result = offlineAgent(lastUserMsg?.content ?? "", pool);
      for (const action of result.actions) await queueActionForApproval(action);
      return result;
    }

    const networkContext = buildNetworkContext(pool, queueContext, data.warmupDay, data.ops || {});
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT + warmupNote + networkContext },
      ...data.messages,
    ];
    const queuedActions: QueuedAction[] = [];

    let provider: "fireworks" | "anthropic";
    let apiUrl: string;
    let model: string;

    if (fireworksKey) {
      provider = "fireworks";
      apiUrl = "https://api.fireworks.ai/inference/v1/chat/completions";
      model = "accounts/fireworks/models/deepseek-v4-pro";
    } else if (anthropicKey) {
      provider = "anthropic";
      apiUrl = "https://api.anthropic.com/v1/messages";
      model = "claude-opus-4-8";
    }

    for (let i = 0; i < 5; i++) {
      let res: Response;

      if (provider === "anthropic") {
        const systemMsg = messages.find((m) => m.role === "system");
        res = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "x-api-key": anthropicKey!,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: 1024,
            system: systemMsg?.content ?? SYSTEM_PROMPT,
            messages: toAnthropicMessages(messages),
            tools: TOOLS.map((t) => ({
              name: t.function.name,
              description: t.function.description,
              input_schema: t.function.parameters,
            })),
          }),
        });
      } else {
        res = await fetch(apiUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${fireworksKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages,
            tools: TOOLS,
            tool_choice: "auto",
            max_tokens: 1024,
            temperature: 0.3,
          }),
        });
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error(`[agent] ${provider} API error (${res.status}):`, text.slice(0, 300));
        return {
          assistant:
            `⚠ ${provider.charAt(0).toUpperCase() + provider.slice(1)} API returned ${res.status}. ` +
            (res.status === 401 || res.status === 403
              ? `Your API key looks invalid or expired. Update FIREWORKS_API_KEY in .env.local and restart the dev server.`
              : `Error: ${text.slice(0, 200)}`),
          actions: [] as QueuedAction[],
        };
      }

      const json = await res.json();

      let textContent = "";
      let toolCalls: ToolCall[] = [];

      if (provider === "anthropic") {
        for (const block of json.content ?? []) {
          if (block.type === "text") textContent = block.text;
          if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: { name: block.name, arguments: JSON.stringify(block.input) },
            });
          }
        }
      } else {
        const msg = json.choices?.[0]?.message;
        if (!msg) break;
        textContent = msg.content ?? "";
        toolCalls = msg.tool_calls ?? [];
      }

      messages.push({
        role: "assistant",
        content: textContent,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      });

      if (!toolCalls.length) {
        return { assistant: textContent, actions: queuedActions };
      }

      for (const tc of toolCalls) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments || "{}");
        } catch {
          /* noop */
        }
        const { result, action } = executeTool(pool, tc.function.name, parsedArgs);
        if (action) {
          await queueActionForApproval(action);
          queuedActions.push(action);
        }
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          name: tc.function.name,
          content: JSON.stringify(result),
        });
      }
    }
    return { assistant: "(stopped: too many tool iterations)", actions: queuedActions };
  });
