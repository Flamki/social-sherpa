import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Send } from "lucide-react";

import { runAgent } from "@/lib/agent.functions";
import { AppShell } from "@/components/app/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addActions, startWorker, useStore, warmupDay, type Action } from "@/lib/store";

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

const SUGGESTIONS = [
  "Top 3 contacts in supply chain",
  "Message my VP connections",
  "Review pending requests",
  "Summarize my inbox",
];

function Index() {
  const agent = useServerFn(runAgent);
  const connections = useStore((s) => s.connections.items);
  const day = useStore((s) => warmupDay(s));
  const session = useStore((s) => s.session);
  const onboarded = useStore((s) => s.onboarded);

  const [messages, setMessages] = useState<UIMessage[]>([
    {
      role: "assistant",
      content:
        "Hi! I'm your LinkedIn Network Manager. I can search your connections, draft outreach, manage connection requests, and more. What would you like to do?",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeSeg, setActiveSeg] = useState(0);

  useEffect(() => { startWorker(); }, []);

  // Auto-scroll to bottom whenever messages or loading state change
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  // Track which segment (message) is currently in view for the scrollbar dots
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const ratio = el.scrollHeight <= el.clientHeight
        ? 1
        : el.scrollTop / (el.scrollHeight - el.clientHeight);
      const total = Math.max(1, messages.length);
      setActiveSeg(Math.min(total - 1, Math.round(ratio * (total - 1))));
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [messages.length]);

  async function send(override?: string) {
    const text = (override ?? input).trim();
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
    }
  }

  const showChips = messages.length <= 1;

  return (
    <AppShell title="AI Agent">
      {(!onboarded || !session.connected) && (
        <div className="border-b bg-amber-50 px-6 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {!session.connected ? (
            <>No LinkedIn session linked. <Link to="/extension" className="underline">Install the extension</Link> to enable real sends.</>
          ) : (
            <>Finish <Link to="/onboarding" className="underline">onboarding</Link> to start your 14-day warmup.</>
          )}
        </div>
      )}
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
        <div className="relative flex min-h-0 flex-1">
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto scroll-smooth [&::-webkit-scrollbar]:hidden [scrollbar-width:none]"
          >
            <div className="flex flex-col gap-4 px-6 py-6">
            {messages.map((m, i) => (
              <div key={i} className={`flex gap-3 ${m.role === "user" ? "flex-row-reverse" : ""}`}>
                <div
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                    m.role === "user"
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-primary/10 text-primary"
                  }`}
                >
                  {m.role === "user" ? "You" : "AI"}
                </div>
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    m.role === "user"
                      ? "bg-emerald-50 text-emerald-950 dark:bg-emerald-950/40 dark:text-emerald-100"
                      : "bg-muted text-foreground"
                  }`}
                >
                  <p className="whitespace-pre-wrap">{m.content}</p>
                </div>
              </div>
            ))}
            {showChips && (
              <div className="ml-10 flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="rounded-full border bg-background px-3 py-1.5 text-xs text-foreground transition hover:bg-muted"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {loading && (
              <div className="flex gap-3">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">AI</div>
                <div className="rounded-2xl bg-muted px-4 py-2.5 text-sm text-muted-foreground">Thinking…</div>
              </div>
            )}
            </div>
          </div>
          {messages.length > 1 && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-4 right-1.5 flex w-1 flex-col items-stretch justify-center gap-1"
            >
              {messages.map((_, i) => (
                <span
                  key={i}
                  className={`h-0.5 w-full rounded-full transition-colors ${
                    i === activeSeg ? "bg-foreground" : "bg-muted-foreground/30"
                  }`}
                />
              ))}
            </div>
          )}
        </div>
        <div className="border-t bg-background px-6 py-4">
          <div className="flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="Ask the agent anything about your network..."
              disabled={loading}
              className="h-11 rounded-xl"
            />
            <Button onClick={() => send()} disabled={loading || !input.trim()} className="h-11 w-11 rounded-xl p-0">
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </AppShell>
  );
}