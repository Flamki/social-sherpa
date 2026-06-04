import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { MOCK_CONNECTIONS, type Connection } from "../lib/mockConnections";

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
  channel: string;
  subject?: string;
  body: string;
  reasoning: string;
  status: "pending";
  created_at: string;
};

const SYSTEM_PROMPT = `You are a LinkedIn Network Manager agent for the user.
You help the user search their LinkedIn connections, draft personalized outreach,
and queue actions (connection requests, DMs, emails) for human approval.

IMPORTANT RULES:
- You NEVER send anything directly. Every outreach action you take is queued for the user to approve.
- Always search connections first before drafting.
- Personalize every message using the connection's company/headline.
- Keep DMs under 300 chars, emails under 150 words.
- When the user asks for "top N" people, rank by tag relevance and seniority signals in headline.
- After queueing actions, briefly tell the user what you queued and ask them to review the approval panel.
- If the user is in account warmup (early days), prefer queue_profile_view to gently warm targets before messaging.`;

function rankConnections(pool: Connection[], query: string, limit: number): Connection[] {
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = pool.map((c) => {
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
      description: "Search the user's LinkedIn connections by topic, role, or keywords. Returns ranked matches.",
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
      description: "Queue a personalized LinkedIn DM to a connection for user approval. Does NOT send.",
      parameters: {
        type: "object",
        properties: {
          target_id: { type: "string" },
          body: { type: "string", description: "DM body, <300 chars, personalized" },
          reasoning: { type: "string", description: "One sentence: why this person, why this message" },
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
      description: "Queue a new LinkedIn connection request with personalized note for user approval.",
      parameters: {
        type: "object",
        properties: {
          target_name: { type: "string", description: "Name of person to connect with (not yet in network)" },
          body: { type: "string", description: "Connection note, <280 chars" },
          reasoning: { type: "string" },
        },
        required: ["target_name", "body", "reasoning"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "queue_profile_view",
      description: "Queue a soft 'profile view' of a 1st-degree connection. Useful during account warmup before sending messages.",
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

function executeTool(pool: Connection[], name: string, args: Record<string, unknown>): {
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
      id, type: "message", target_id: target.id, target_name: target.name,
      channel: "LinkedIn DM", body: String(args.body), reasoning: String(args.reasoning),
      status: "pending", created_at,
    };
    return { result: { queued: true, action_id: id }, action };
  }
  if (name === "queue_email") {
    const target = pool.find((c) => c.id === args.target_id);
    if (!target) return { result: { error: "connection not found" } };
    const action: QueuedAction = {
      id, type: "email", target_id: target.id, target_name: target.name,
      channel: "Email", subject: String(args.subject), body: String(args.body),
      reasoning: String(args.reasoning), status: "pending", created_at,
    };
    return { result: { queued: true, action_id: id }, action };
  }
  if (name === "queue_connection_request") {
    const action: QueuedAction = {
      id, type: "connection_request", target_id: "new", target_name: String(args.target_name),
      channel: "LinkedIn Invite", body: String(args.body), reasoning: String(args.reasoning),
      status: "pending", created_at,
    };
    return { result: { queued: true, action_id: id }, action };
  }
  if (name === "queue_profile_view") {
    const target = pool.find((c) => c.id === args.target_id);
    if (!target) return { result: { error: "connection not found" } };
    const action: QueuedAction = {
      id, type: "profile_view", target_id: target.id, target_name: target.name,
      channel: "LinkedIn Profile View", body: "(silent profile view)",
      reasoning: String(args.reasoning), status: "pending", created_at,
    };
    return { result: { queued: true, action_id: id }, action };
  }
  return { result: { error: "unknown tool" } };
}

const ConnectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  headline: z.string(),
  company: z.string(),
  location: z.string().optional().default(""),
  tags: z.array(z.string()),
});

export const runAgent = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      messages: z.array(MessageSchema).min(1).max(50),
      connections: z.array(ConnectionSchema).max(5000).optional(),
      warmupDay: z.number().min(0).max(14).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

    const pool: Connection[] = (data.connections?.length ? data.connections : MOCK_CONNECTIONS) as Connection[];
    const warmupNote = typeof data.warmupDay === "number"
      ? `\n\nUSER CONTEXT: Account warmup day ${data.warmupDay} of 14. ${data.warmupDay < 5 ? "Strongly prefer profile_view actions; avoid invites." : "Limited messages allowed."}`
      : "";

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT + warmupNote },
      ...data.messages,
    ];
    const queuedActions: QueuedAction[] = [];

    // Tool-resolution loop, capped.
    for (let i = 0; i < 5; i++) {
      const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages,
          tools: TOOLS,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`AI gateway error ${res.status}: ${text.slice(0, 300)}`);
      }
      const json = await res.json();
      const msg = json.choices?.[0]?.message;
      if (!msg) throw new Error("No message in AI response");

      const toolCalls: ToolCall[] = msg.tool_calls ?? [];
      messages.push({
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: toolCalls.length ? toolCalls : undefined,
      });

      if (!toolCalls.length) {
        return {
          assistant: msg.content ?? "",
          actions: queuedActions,
        };
      }

      for (const tc of toolCalls) {
        let parsedArgs: Record<string, unknown> = {};
        try { parsedArgs = JSON.parse(tc.function.arguments || "{}"); } catch { /* noop */ }
        const { result, action } = executeTool(pool, tc.function.name, parsedArgs);
        if (action) queuedActions.push(action);
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