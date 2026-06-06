import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import {
  Inbox as InboxIcon,
  Send,
  Loader2,
  RefreshCw,
  MessageCircle,
  AlertCircle,
  Linkedin,
  ArrowLeft,
} from "lucide-react";
import { useServerFn } from "@tanstack/react-start";

import { AppShell } from "@/components/app/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStore } from "@/lib/store";
import {
  listConversations,
  readThread,
  type Conversation,
  type ThreadMessage,
} from "@/lib/linkedin.inbox";
import { sendMessage } from "@/lib/linkedin.message";

export const Route = createFileRoute("/inbox")({
  head: () => ({
    meta: [
      { title: "Inbox — Network Manager" },
      { name: "description", content: "Unified LinkedIn inbox — read and reply to conversations." },
    ],
  }),
  component: InboxPage,
});

function InboxPage() {
  const session = useStore((s) => s.session);
  const cookies = (session as any).cookies as { li_at: string; JSESSIONID: string } | undefined;

  const fetchConvos = useServerFn(listConversations);
  const fetchThread = useServerFn(readThread);
  const send = useServerFn(sendMessage);

  const [convos, setConvos] = useState<Conversation[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState("");

  const [active, setActive] = useState<Conversation | null>(null);
  const [thread, setThread] = useState<ThreadMessage[]>([]);
  const [meName, setMeName] = useState("");
  const [loadingThread, setLoadingThread] = useState(false);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendNote, setSendNote] = useState("");
  const [search, setSearch] = useState("");

  const loadList = useCallback(async () => {
    if (!cookies) return;
    setLoadingList(true);
    setListError("");
    try {
      const res = await fetchConvos({ data: { cookies, headless: true } });
      if (res.success) setConvos(res.conversations);
      else setListError(res.error);
    } catch (e) {
      setListError((e as Error).message);
    } finally {
      setLoadingList(false);
    }
  }, [cookies, fetchConvos]);

  async function openThread(c: Conversation) {
    setActive(c);
    setThread([]);
    setSendNote("");
    setLoadingThread(true);
    try {
      const res = await fetchThread({
        data: { cookies: cookies!, threadUrl: c.threadUrl, headless: true },
      });
      if (res.success) {
        setThread(res.messages);
        setMeName(res.meName);
      } else {
        setSendNote("Couldn't load thread: " + res.error);
      }
    } catch (e) {
      setSendNote((e as Error).message);
    } finally {
      setLoadingThread(false);
    }
  }

  async function doSend() {
    if (!active || !draft.trim() || !cookies) return;
    setSending(true);
    setSendNote("");
    const text = draft.trim();
    try {
      const res = await send({
        data: { cookies, threadUrl: active.threadUrl, message: text, headless: true },
      });
      if (res.success) {
        setThread((t) => [...t, { from: "me", sender: meName || "You", text, time: "now" }]);
        setDraft("");
        setSendNote(`✓ Sent · ${res.remainingToday} messages left today`);
      } else {
        setSendNote("⚠ " + res.error);
      }
    } catch (e) {
      setSendNote((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  const filtered = convos.filter(
    (c) => !search || c.name.toLowerCase().includes(search.toLowerCase()),
  );

  if (!cookies) {
    return (
      <AppShell title="Inbox">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <Linkedin className="h-10 w-10 text-[#0A66C2] opacity-60" />
          <p className="text-sm font-medium text-foreground">Connect LinkedIn to load your inbox</p>
          <p className="text-xs">Use the “Connect to LinkedIn” button in the top-right header.</p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="Unified Inbox">
      <div className="flex min-h-0 flex-1">
        {/* LEFT: conversation list */}
        <div
          className={`flex w-full flex-col border-r md:w-80 ${active ? "hidden md:flex" : "flex"}`}
        >
          <div className="flex items-center gap-2 border-b p-3">
            <div className="relative flex-1">
              <MessageCircle className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search contacts…"
                className="h-9 pl-8 text-sm"
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={loadList}
              disabled={loadingList}
              className="h-9 gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loadingList ? "animate-spin" : ""}`} />
            </Button>
          </div>
          <div className="border-b bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
            Inbox sync is paused for the demo path. Click refresh only when you explicitly want to
            fetch conversations.
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {loadingList && (
              <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading conversations…
              </div>
            )}
            {listError && (
              <div className="m-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{listError}</span>
                </div>
              </div>
            )}
            {!loadingList &&
              filtered.map((c) => (
                <button
                  key={c.id}
                  onClick={() => openThread(c)}
                  className={`flex w-full items-center gap-3 border-b px-3 py-3 text-left transition hover:bg-muted/50 ${
                    active?.id === c.id ? "bg-muted" : ""
                  }`}
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                    {c.name.charAt(0)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{c.name}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{c.time}</span>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{c.preview}</p>
                  </div>
                  {c.unread && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />}
                </button>
              ))}
            {!loadingList && !listError && filtered.length === 0 && (
              <div className="p-8 text-center text-sm text-muted-foreground">No conversations.</div>
            )}
          </div>
        </div>

        {/* RIGHT: chat thread + composer */}
        <div className={`flex min-w-0 flex-1 flex-col ${active ? "flex" : "hidden md:flex"}`}>
          {!active ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
              <InboxIcon className="h-10 w-10 opacity-30" />
              <p className="text-sm">Select a conversation to view the thread</p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 border-b p-3">
                <Button
                  variant="ghost"
                  size="sm"
                  className="md:hidden"
                  onClick={() => setActive(null)}
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                  {active.name.charAt(0)}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{active.name}</p>
                  <span className="text-[10px] text-muted-foreground">LinkedIn</span>
                </div>
                <a
                  href={active.threadUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto text-xs text-muted-foreground hover:text-primary"
                >
                  Open on LinkedIn ↗
                </a>
              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
                {loadingThread && (
                  <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading thread…
                  </div>
                )}
                {thread.map((m, i) => (
                  <div
                    key={i}
                    className={`flex ${m.from === "me" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm ${
                        m.from === "me"
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-foreground"
                      }`}
                    >
                      <p className="whitespace-pre-wrap">{m.text}</p>
                      {m.time && (
                        <span
                          className={`mt-1 block text-[10px] ${m.from === "me" ? "text-primary-foreground/70" : "text-muted-foreground"}`}
                        >
                          {m.time}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="border-t p-3">
                {sendNote && (
                  <p
                    className={`mb-2 text-xs ${sendNote.startsWith("✓") ? "text-emerald-600" : "text-amber-600"}`}
                  >
                    {sendNote}
                  </p>
                )}
                <div className="flex items-end gap-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void doSend();
                    }}
                    rows={2}
                    maxLength={2000}
                    placeholder={`Reply to ${active.name}…  (Ctrl+Enter to send)`}
                    className="flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <Button onClick={doSend} disabled={sending || !draft.trim()} className="gap-1.5">
                    {sending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                    Send
                  </Button>
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Sends through a stealth browser to the real LinkedIn thread · cap-gated by warmup
                  ramp · {draft.length}/2000
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
