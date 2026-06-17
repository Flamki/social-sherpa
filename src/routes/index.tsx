import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Send } from "lucide-react";

import { runAgent } from "@/lib/agent.functions";
import {
  listQueue,
  runActionNow,
  decideQueueAction,
  clearPendingActions,
} from "@/lib/action.queue";
import { AppShell } from "@/components/app/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  addActions,
  setAgentMessages,
  startWorker,
  useStore,
  warmupDay,
  type Action,
  type AgentMessage,
} from "@/lib/store";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Network Manager — LinkedIn AI Agent" },
      {
        name: "description",
        content:
          "AI agent that drafts LinkedIn outreach and queues every action for your approval.",
      },
      { property: "og:title", content: "Network Manager — LinkedIn AI Agent" },
      {
        property: "og:description",
        content: "AI agent that drafts and queues LinkedIn outreach for your approval.",
      },
    ],
  }),
  component: Index,
});

type UIMessage = AgentMessage;

const SUGGESTIONS = [
  "Top 3 contacts in supply chain",
  "Message my VP connections",
  "Review pending requests",
  "Queue a profile view for supply chain leads",
];

function Index() {
  const agent = useServerFn(runAgent);
  const fetchQueue = useServerFn(listQueue);
  const runNow = useServerFn(runActionNow);
  const decide = useServerFn(decideQueueAction);
  const clearBacklogFn = useServerFn(clearPendingActions);
  const connections = useStore((s) => s.connections.items);
  const day = useStore((s) => warmupDay(s));
  const session = useStore((s) => s.session);
  const ops = useStore((s) => s.ops);
  const actions = useStore((s) => s.actions);
  const onboarded = true; // Force onboarded for direct testing

  const messages = useStore((s) => s.messages);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const turnRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [activeSeg, setActiveSeg] = useState(0);

  // Inline action approval and status. The chat shows ONLY the
  // action(s) from your current request — full history lives in the Requests tab.
  const [pendingActions, setPendingActions] = useState<any[]>([]);
  const [actState, setActState] = useState<
    Record<
      string,
      { status: "idle" | "sending" | "sent" | "failed"; error?: string; needsCookies?: boolean }
    >
  >({});
  // Count of stale not-yet-sent actions sitting in the queue from earlier sessions.
  const [backlogCount, setBacklogCount] = useState(0);

  // Indices of user messages — each is one "turn" / segment in the scrollbar
  const turnIndices = messages.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0);

  async function loadBacklogCount() {
    try {
      const res = await fetchQueue({});
      if (!res.success) return;
      const stale = res.actions.filter((a: any) =>
        ["pending", "approved", "retrying", "failed"].includes(a.status),
      );
      setBacklogCount(stale.length);
    } catch {
      /* non-fatal */
    }
  }

  async function approveAndSend(action: any) {
    const cookies = session.cookies;
    setActState((s) => ({ ...s, [action.id]: { status: "sending" } }));
    try {
      const res = await runNow({ data: { id: action.id, cookies, headless: true } });
      const sent = res.status === "sent";
      setActState((s) => ({
        ...s,
        [action.id]: {
          status: sent ? "sent" : "failed",
          error: res.error,
          needsCookies: (res as any).needsCookies,
        },
      }));
      return sent;
    } catch (e) {
      setActState((s) => ({
        ...s,
        [action.id]: { status: "failed", error: (e as Error).message },
      }));
      return false;
    }
  }

  async function approveCampaign(actionsToSend: any[]) {
    for (const action of actionsToSend) {
      const st = actState[action.id]?.status || "idle";
      if (st === "idle" || st === "failed") {
        await approveAndSend(action);
      }
    }
  }

  async function rejectAction(action: any) {
    setPendingActions((list) => list.filter((a) => a.id !== action.id));
    try {
      await decide({ data: { id: action.id, approve: false } });
    } catch {
      /* non-fatal */
    }
  }

  async function rejectCampaign(actionsToReject: any[]) {
    setPendingActions((list) => list.filter((a) => !actionsToReject.some((r) => r.id === a.id)));
    for (const action of actionsToReject) {
      try {
        await decide({ data: { id: action.id, approve: false } });
      } catch {
        /* non-fatal */
      }
    }
  }

  async function clearBacklog() {
    try {
      await clearBacklogFn({});
    } catch {
      /* non-fatal */
    }
    setBacklogCount(0);
  }

  useEffect(() => {
    startWorker();
    loadBacklogCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll to bottom whenever messages or loading state change
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  // Track which turn (user message) is currently in view for the segment indicator
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const top = el.scrollTop;
      let current = 0;
      turnRefs.current.forEach((node, i) => {
        if (!node) return;
        if (node.offsetTop - 80 <= top) current = i;
      });
      setActiveSeg(current);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [turnIndices.length]);

  function scrollToTurn(i: number) {
    const el = scrollRef.current;
    const node = turnRefs.current[i];
    if (!el || !node) return;
    el.scrollTo({ top: node.offsetTop - 16, behavior: "smooth" });
  }

  async function send(override?: string) {
    const text = (override ?? input).trim();
    if (!text || loading) return;
    const next: UIMessage[] = [...messages, { role: "user", content: text }];
    setAgentMessages(next);
    setInput("");
    setLoading(true);
    try {
      const queueRes = await fetchQueue({});
      const serverQueue = queueRes.success ? queueRes.actions : [];
      const beforeIds = new Set(serverQueue.map((a) => a.id));
      const res = await agent({
        data: {
          messages: next.map((m) => ({ role: m.role, content: m.content })),
          connections,
          warmupDay: day,
          ops,
          cookies: session.cookies,
          queue: serverQueue.length
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
            : actions.map((a) => ({
                id: a.id,
                type: a.type,
                target_name: a.target_name,
                status: a.status,
                created_at: a.created_at,
              })),
        },
      });
      setAgentMessages([...next, { role: "assistant", content: res.assistant || "(no response)" }]);
      if (res.actions.length) {
        addActions(res.actions.map((a) => ({ ...a, status: "pending" as const })) as Action[]);
        // Surface ONLY the actions this turn created (diff against the pre-call queue).
        const after = await fetchQueue({});
        const fresh = (after.success ? after.actions : []).filter((a) => !beforeIds.has(a.id));
        if (fresh.length) {
          setPendingActions(fresh);
          setActState(() => {
            const n: Record<
              string,
              {
                status: "idle" | "sending" | "sent" | "failed";
                error?: string;
                needsCookies?: boolean;
              }
            > = {};
            for (const a of fresh) n[a.id] = { status: "idle" };
            return n;
          });
        }
      }
    } catch (e) {
      setAgentMessages([...next, { role: "assistant", content: `Error: ${(e as Error).message}` }]);
    } finally {
      setLoading(false);
    }
  }

  const showChips = messages.length <= 1;
  const sendableCampaignActions = pendingActions.filter((a) => {
    const st = actState[a.id]?.status || "idle";
    return st === "idle" || st === "failed";
  });
  const sendingCampaign = pendingActions.some((a) => actState[a.id]?.status === "sending");
  const isCampaignBatch = pendingActions.length > 1;

  return (
    <AppShell title="AI Agent">
      {(!onboarded || !session.connected) && (
        <div className="border-b bg-amber-50 px-6 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {!session.connected ? (
            <>
              No LinkedIn account linked. Connect through{" "}
              <Link to="/onboarding" className="underline">
                onboarding
              </Link>{" "}
              to enable approved sends.
            </>
          ) : (
            <>
              Finish{" "}
              <Link to="/onboarding" className="underline">
                onboarding
              </Link>{" "}
              to start your 14-day warmup.
            </>
          )}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-y-auto scroll-smooth [&::-webkit-scrollbar]:hidden [scrollbar-width:none]"
          >
            <div className="flex flex-col gap-4 px-6 py-6">
              {backlogCount > 0 && (
                <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  <span>
                    {backlogCount} older pending action{backlogCount === 1 ? "" : "s"} from a
                    previous session are sitting in your queue.
                  </span>
                  <Button size="sm" variant="outline" onClick={clearBacklog}>
                    Clear them
                  </Button>
                </div>
              )}
              {messages.map((m, i) => (
                <div
                  key={i}
                  ref={(node) => {
                    if (m.role !== "user") return;
                    const turnIdx = turnIndices.indexOf(i);
                    if (turnIdx >= 0) turnRefs.current[turnIdx] = node;
                  }}
                  className={`flex gap-3 ${m.role === "user" ? "flex-row-reverse" : ""}`}
                >
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
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                    AI
                  </div>
                  <div className="rounded-2xl bg-muted px-4 py-2.5 text-sm text-muted-foreground">
                    Thinking…
                  </div>
                </div>
              )}
              {pendingActions.length > 0 && (
                <div className="ml-10 flex flex-col gap-2">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Pending actions — approve to send now
                  </p>
                  {isCampaignBatch && (
                    <div className="flex flex-wrap gap-2 rounded-xl border bg-background p-3">
                      <Button
                        size="sm"
                        disabled={sendingCampaign || sendableCampaignActions.length === 0}
                        onClick={() => approveCampaign(sendableCampaignActions)}
                      >
                        {sendableCampaignActions.length > 0
                          ? `Approve campaign & send ${sendableCampaignActions.length}`
                          : "Campaign handled"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={sendingCampaign || sendableCampaignActions.length === 0}
                        onClick={() => rejectCampaign(sendableCampaignActions)}
                      >
                        Reject campaign
                      </Button>
                    </div>
                  )}
                  {pendingActions.map((a) => {
                    const st = actState[a.id]?.status || "idle";
                    const label =
                      a.type === "message"
                        ? "LinkedIn DM"
                        : a.type === "connection_request"
                          ? "Connection request"
                          : a.type === "profile_view"
                            ? "Profile view"
                            : a.type;
                    return (
                      <div key={a.id} className="rounded-xl border bg-background p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium">
                            {label} → {a.targetName}
                          </span>
                          {st === "sending" && (
                            <span className="text-xs text-muted-foreground">Sending…</span>
                          )}
                          {st === "sent" && (
                            <span className="text-xs font-medium text-emerald-600">✓ Sent</span>
                          )}
                          {st === "failed" && (
                            <span className="text-xs font-medium text-red-500">Failed</span>
                          )}
                          {st === "idle" && isCampaignBatch && (
                            <span className="text-xs text-muted-foreground">Ready</span>
                          )}
                        </div>
                        {a.body && (
                          <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                            {a.body}
                          </p>
                        )}
                        {st === "idle" && !isCampaignBatch && (
                          <div className="mt-2 flex gap-2">
                            <Button size="sm" onClick={() => approveAndSend(a)}>
                              Approve &amp; Send
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => rejectAction(a)}>
                              Reject
                            </Button>
                          </div>
                        )}
                        {st === "failed" && (
                          <div className="mt-2">
                            <p className="text-xs text-red-500">
                              {actState[a.id]?.error || "Something went wrong."}
                            </p>
                            {actState[a.id]?.needsCookies ? (
                              <div className="mt-2 space-y-1.5">
                                <p className="text-xs text-muted-foreground">
                                  Your LinkedIn session expired. Reconnect on the Connections page,
                                  then retry this action.
                                </p>
                                <div className="flex flex-wrap gap-2">
                                  <Button size="sm" asChild>
                                    <Link to="/connections">Reconnect LinkedIn</Link>
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => approveAndSend(a)}
                                  >
                                    Retry
                                  </Button>
                                </div>
                              </div>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                className="mt-1"
                                onClick={() => approveAndSend(a)}
                              >
                                Retry
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          <div className="border-t bg-background px-6 py-4">
            <div className="mx-auto w-full max-w-3xl">
              <div className="flex gap-2">
                <Input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && send()}
                  placeholder="Ask the agent anything about your network..."
                  disabled={loading}
                  className="h-11 rounded-xl"
                />
                <Button
                  onClick={() => send()}
                  disabled={loading || !input.trim()}
                  className="h-11 w-11 rounded-xl p-0"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>
        {turnIndices.length > 0 && (
          <div className="pointer-events-none absolute right-2 top-0 bottom-20 z-10 flex w-2 flex-col items-stretch justify-center gap-1.5 py-6">
            {turnIndices.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => scrollToTurn(i)}
                aria-label={`Jump to message ${i + 1}`}
                className={`pointer-events-auto h-0.5 w-full rounded-full transition-colors ${
                  i === activeSeg
                    ? "bg-foreground"
                    : "bg-muted-foreground/30 hover:bg-muted-foreground/60"
                }`}
              />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
