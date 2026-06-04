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

// ── Offline fallback: deterministic agent (no API key needed for demo) ────────
function offlineAgent(userMessage: string, pool: Connection[]): { assistant: string; actions: QueuedAction[] } {
  const lower = userMessage.toLowerCase();
  const topN = lower.match(/top\s+(\d+)/)?.[1];
  const limit = topN ? parseInt(topN) : 3;

  // Extract topic keywords
  const topicKeywords = ["supply chain", "logistics", "procurement", "operations", "engineering", "product", "fintech", "marketing", "ml", "ai", "founder"];
  const matchedTopic = topicKeywords.find((k) => lower.includes(k)) ?? "supply chain";

  const wantsMessage = lower.includes("message") || lower.includes("dm") || lower.includes("outreach") || lower.includes("contact");
  const wantsEmail = lower.includes("email") || lower.includes("mail");
  const wantsList = lower.includes("list") || lower.includes("show") || lower.includes("find") || lower.includes("give") || lower.includes("who") || lower.includes("top");
  const wantsInbox = lower.includes("inbox") || lower.includes("summarize") || lower.includes("summary");
  const wantsRequests = lower.includes("request") || lower.includes("pending");

  if (wantsInbox) {
    return { assistant: "Your inbox has 4 messages — 2 unread. Priya Shah from Flipkart reached out about supply chain tech, and Vikram Reddy from Razorpay mentioned a backend opening. Want me to draft replies for any of them?", actions: [] };
  }
  if (wantsRequests) {
    return { assistant: "You have 3 pending connection requests — Rohan Malhotra (McKinsey, supply chain), Tanvi Shah (Zomato), and Kavya Reddy (BigBasket). Want me to accept all or review individually?", actions: [] };
  }

  const matches = rankConnections(pool, matchedTopic, limit);
  if (!matches.length) {
    return { assistant: `I searched your connections for "${matchedTopic}" but found no strong matches. Try a broader term like "operations" or "logistics".`, actions: [] };
  }

  if (wantsList && !wantsMessage && !wantsEmail) {
    const list = matches.map((c, i) => `${i + 1}. **${c.name}** — ${c.headline} @ ${c.company}`).join("\n");
    return { assistant: `Here are the top ${matches.length} connections for "${matchedTopic}":\n\n${list}\n\nWant me to draft outreach for any of them?`, actions: [] };
  }

  const actions: QueuedAction[] = matches.map((c) => {
    const id = crypto.randomUUID();
    if (wantsEmail && c.email) {
      return {
        id, type: "email" as const, target_id: c.id, target_name: c.name,
        channel: "Email", subject: `Quick hello from a fellow ${matchedTopic} enthusiast`,
        body: `Hi ${c.name.split(" ")[0]},\n\nI came across your work at ${c.company} and was impressed by your focus on ${matchedTopic}. I'd love to connect and share notes on the space.\n\nWould you be open to a quick 15-min chat?\n\nBest,\n[Your name]`,
        reasoning: `${c.name} is a strong ${matchedTopic} contact at ${c.company} and has an email on file.`,
        status: "pending" as const, created_at: new Date().toISOString(),
      };
    }
    return {
      id, type: "message" as const, target_id: c.id, target_name: c.name,
      channel: "LinkedIn DM",
      body: `Hi ${c.name.split(" ")[0]}, loved your work in ${matchedTopic} at ${c.company}. Would love to connect and swap notes — would you be open to a quick chat?`,
      reasoning: `${c.name} is ranked top for "${matchedTopic}" — ${c.headline} at ${c.company}.`,
      status: "pending" as const, created_at: new Date().toISOString(),
    };
  });

  const names = matches.map((c) => c.name).join(", ");
  return {
    assistant: `Found your top ${matches.length} ${matchedTopic} connections: **${names}**.\n\nI've queued ${wantsEmail ? "emails" : "LinkedIn DMs"} for each — check the **Requests** tab to review and approve before anything is sent.`,
    actions,
  };
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
    const pool: Connection[] = (data.connections?.length ? data.connections : MOCK_CONNECTIONS) as Connection[];
    const warmupNote = typeof data.warmupDay === "number"
      ? `\n\nUSER CONTEXT: Account warmup day ${data.warmupDay} of 14. ${data.warmupDay < 5 ? "Strongly prefer profile_view actions; avoid invites." : "Limited messages allowed."}`
      : "";

    // Try Anthropic API first, fall back to offline agent
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const lovableKey = process.env.LOVABLE_API_KEY;

    if (!anthropicKey && !lovableKey) {
      // Offline fallback — works with zero API keys, great for demo
      const lastUserMsg = [...data.messages].reverse().find((m) => m.role === "user");
      const result = offlineAgent(lastUserMsg?.content ?? "", pool);
      return result;
    }

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT + warmupNote },
      ...data.messages,
    ];
    const queuedActions: QueuedAction[] = [];

    // Prefer Anthropic, fall back to Lovable gateway
    const useAnthropic = !!anthropicKey;
    const apiUrl = useAnthropic
      ? "https://api.anthropic.com/v1/messages"
      : "https://ai.gateway.lovable.dev/v1/chat/completions";

    for (let i = 0; i < 5; i++) {
      let res: Response;

      if (useAnthropic) {
        // Anthropic messages API format
        const systemMsg = messages.find((m) => m.role === "system");
        const chatMessages = messages.filter((m) => m.role !== "system");
        res = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "x-api-key": anthropicKey!,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 1024,
            system: systemMsg?.content ?? SYSTEM_PROMPT,
            messages: chatMessages.map((m) => ({ role: m.role === "tool" ? "user" : m.role, content: m.content })),
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
            Authorization: `Bearer ${lovableKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages,
            tools: TOOLS,
          }),
        });
      }

      if (!res.ok) {
        const text = await res.text();
        // On API error, fall back to offline
        const lastUserMsg = [...data.messages].reverse().find((m) => m.role === "user");
        return offlineAgent(lastUserMsg?.content ?? "", pool);
      }

      const json = await res.json();

      let textContent = "";
      let toolCalls: ToolCall[] = [];

      if (useAnthropic) {
        // Anthropic response format
        for (const block of json.content ?? []) {
          if (block.type === "text") textContent = block.text;
          if (block.type === "tool_use") {
            toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input) } });
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
