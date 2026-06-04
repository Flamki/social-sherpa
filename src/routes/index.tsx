import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Send, Check, X, Sparkles, Inbox, Loader2, MailCheck, Eye } from "lucide-react";

import { runAgent } from "@/lib/agent.functions";
import { Nav } from "@/components/app/Nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  addActions,
  decide,
  startWorker,
  useStore,
  warmupDay,
  type Action,
  type ActionStatus,
} from "@/lib/store";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Network Manager — LinkedIn AI Agent" },
      { name: "description", content: "AI agent that drafts LinkedIn outreach and queues every action for your approval." },
      { property: "og:title", content: "Network Manager — LinkedIn AI Agent" },
      { property: "og:description", content: "AI agent that drafts and queues LinkedIn outreach for your approval." },
    ],
  }),
  component: Index,
});

type UIMessage = { role: "user" | "assistant"; content: string };

const STATUS_TONE: Record<ActionStatus, string> = {
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  approved: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  sending: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  sent: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  rejected: "bg-muted text-muted-foreground",
  failed: "bg-destructive/15 text-destructive",
};

function Index() {
  const agent = useServerFn(runAgent);
  const connections = useStore((s) => s.connections.items);
  const day = useStore((s) => warmupDay(s));
  const actions = useStore((s) => s.actions);
  const session = useStore((s) => s.session);
  const onboarded = useStore((s) => s.onboarded);

  const [messages, setMessages] = useState<UIMessage[]>([
    {
      role: "assistant",
      content:
        "Hi! I'm your Network Manager. Try: *\"Give me top 3 people in my connections who work on supply chain and draft a message to each\"*",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { startWorker(); }, []);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    const next: UIMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const res = await agent({
        data: {
          messages: next.map((m) => ({ role: m.role, content: m.content })),
          connections,
          warmupDay: day,
        },
      });
      setMessages([...next, { role: "assistant", content: res.assistant || "(no response)" }]);
      if (res.actions.length) {
        addActions(res.actions.map((a) => ({ ...a, status: "pending" as const })) as Action[]);
      }
    } catch (e) {
      setMessages([...next, { role: "assistant", content: `Error: ${(e as Error).message}` }]);
    } finally {
      setLoading(false);
      setTimeout(() => scrollRef.current?.scrollTo({ top: 9e9, behavior: "smooth" }), 50);
    }
  }

  const visible = actions.slice(0, 50);
  const pending = actions.filter((a) => a.status === "pending").length;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Nav />
      {(!onboarded || !session.connected) && (
        <div className="border-b bg-amber-50 px-6 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {!session.connected ? (
            <>Heads up: no LinkedIn session linked. <Link to="/extension" className="underline">Install the extension</Link> to enable real sends.</>
          ) : (
            <>Finish <Link to="/onboarding" className="underline">onboarding</Link> to start your 14-day warmup.</>
          )}
        </div>
      )}
      <main className="mx-auto grid max-w-7xl gap-6 px-6 py-6 lg:grid-cols-[1fr_420px]">
        <Card className="flex h-[calc(100vh-180px)] flex-col">
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <Sparkles className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-medium">Chat with your agent</h2>
          </div>
          <ScrollArea className="flex-1">
            <div ref={scrollRef} className="flex flex-col gap-3 p-4">
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                    m.role === "user"
                      ? "ml-auto bg-primary text-primary-foreground"
                      : "bg-muted text-foreground"
                  }`}
                >
                  <p className="whitespace-pre-wrap">{m.content}</p>
                </div>
              ))}
              {loading && (
                <div className="max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                  Thinking…
                </div>
              )}
            </div>
          </ScrollArea>
          <div className="flex gap-2 border-t p-3">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="Ask your agent..."
              disabled={loading}
            />
            <Button onClick={send} disabled={loading || !input.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </Card>

        <Card className="flex h-[calc(100vh-180px)] flex-col">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <Inbox className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-medium">Approval queue</h2>
            </div>
            <Badge variant={pending ? "default" : "secondary"}>{pending} pending</Badge>
          </div>
          <ScrollArea className="flex-1">
            <div className="flex flex-col gap-3 p-4">
              {visible.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No actions yet. Ask the agent to draft outreach.
                </p>
              )}
              {visible.map((a) => (
                <ActionCard key={a.id} a={a} />
              ))}
            </div>
          </ScrollArea>
        </Card>
      </main>
    </div>
  );
}

function ActionCard({ a }: { a: Action }) {
  const Icon = a.type === "profile_view" ? Eye : a.type === "email" ? MailCheck : Send;
  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">{a.target_name}</p>
            <p className="text-xs text-muted-foreground">{a.channel}</p>
          </div>
        </div>
        <Badge className={`text-[10px] ${STATUS_TONE[a.status]}`} variant="secondary">
          {a.status === "sending" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
          {a.status}
        </Badge>
      </div>
      {a.subject && <p className="mb-1 text-xs font-medium">Subject: {a.subject}</p>}
      <p className="whitespace-pre-wrap rounded bg-muted p-2 text-xs">{a.body}</p>
      <p className="mt-2 text-[11px] italic text-muted-foreground">Why: {a.reasoning}</p>
      {a.status === "pending" && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" className="flex-1" onClick={() => decide(a.id, true)}>
            <Check className="mr-1 h-3 w-3" /> Approve
          </Button>
          <Button size="sm" variant="outline" className="flex-1" onClick={() => decide(a.id, false)}>
            <X className="mr-1 h-3 w-3" /> Reject
          </Button>
        </div>
      )}
      {a.status === "sent" && a.sent_at && (
        <p className="mt-2 text-[10px] text-emerald-600">Sent {new Date(a.sent_at).toLocaleTimeString()} (mock)</p>
      )}
    </Card>
  );
}