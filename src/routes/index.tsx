import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { runAgent, type QueuedAction } from "@/lib/agent.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Linkedin, Send, Check, X, Sparkles, Inbox } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Network Manager — LinkedIn AI Agent" },
      { name: "description", content: "AI agent that searches your LinkedIn network, drafts outreach, and queues every action for your approval." },
      { property: "og:title", content: "Network Manager — LinkedIn AI Agent" },
      { property: "og:description", content: "AI agent that drafts and queues LinkedIn outreach for your approval." },
    ],
  }),
  component: Index,
});

type UIMessage = { role: "user" | "assistant"; content: string };

function Index() {
  const agent = useServerFn(runAgent);
  const [messages, setMessages] = useState<UIMessage[]>([
    {
      role: "assistant",
      content:
        "Hi! I'm your Network Manager. Try: *\"Give me top 3 people in my connections who work on supply chain and draft a message to each\"*",
    },
  ]);
  const [input, setInput] = useState("");
  const [actions, setActions] = useState<QueuedAction[]>([]);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    const next: UIMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const res = await agent({ data: { messages: next.map((m) => ({ role: m.role, content: m.content })) } });
      setMessages([...next, { role: "assistant", content: res.assistant || "(no response)" }]);
      if (res.actions.length) setActions((prev) => [...res.actions, ...prev]);
    } catch (e) {
      setMessages([...next, { role: "assistant", content: `Error: ${(e as Error).message}` }]);
    } finally {
      setLoading(false);
      setTimeout(() => scrollRef.current?.scrollTo({ top: 9e9, behavior: "smooth" }), 50);
    }
  }

  function decide(id: string, approve: boolean) {
    setActions((prev) => prev.filter((a) => a.id !== id));
    setMessages((m) => [
      ...m,
      {
        role: "assistant",
        content: approve ? "Approved and sent (mock)." : "Action rejected.",
      },
    ]);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <Linkedin className="h-5 w-5 text-primary" />
            <h1 className="text-lg font-semibold">Network Manager</h1>
            <Badge variant="secondary" className="ml-2">AI agent · v0</Badge>
          </div>
          <span className="text-xs text-muted-foreground">Approval-gated · Mock LinkedIn data</span>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-6 px-6 py-6 lg:grid-cols-[1fr_400px]">
        {/* Chat */}
        <Card className="flex h-[calc(100vh-140px)] flex-col">
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

        {/* Action queue */}
        <Card className="flex h-[calc(100vh-140px)] flex-col">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <Inbox className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-medium">Approval queue</h2>
            </div>
            <Badge variant={actions.length ? "default" : "secondary"}>{actions.length}</Badge>
          </div>
          <ScrollArea className="flex-1">
            <div className="flex flex-col gap-3 p-4">
              {actions.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No actions queued. Ask the agent to draft outreach and queued
                  actions will appear here for your approval.
                </p>
              )}
              {actions.map((a) => (
                <Card key={a.id} className="p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium">{a.target_name}</p>
                      <p className="text-xs text-muted-foreground">{a.channel}</p>
                    </div>
                    <Badge variant="outline" className="text-[10px]">
                      {a.type.replace("_", " ")}
                    </Badge>
                  </div>
                  {a.subject && (
                    <p className="mb-1 text-xs font-medium">Subject: {a.subject}</p>
                  )}
                  <p className="whitespace-pre-wrap rounded bg-muted p-2 text-xs">{a.body}</p>
                  <p className="mt-2 text-[11px] italic text-muted-foreground">
                    Why: {a.reasoning}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" className="flex-1" onClick={() => decide(a.id, true)}>
                      <Check className="mr-1 h-3 w-3" /> Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1"
                      onClick={() => decide(a.id, false)}
                    >
                      <X className="mr-1 h-3 w-3" /> Reject
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          </ScrollArea>
        </Card>
      </main>
    </div>
  );
}
