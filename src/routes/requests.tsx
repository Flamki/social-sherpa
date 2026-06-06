import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Send,
  Check,
  X,
  Loader2,
  MailCheck,
  Eye,
  Inbox as InboxIcon,
  UserPlus,
  Users,
  RefreshCw,
  Play,
  Clock,
  AlertCircle,
  ShieldCheck,
} from "lucide-react";
import { useServerFn } from "@tanstack/react-start";

import { AppShell } from "@/components/app/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useStore } from "@/lib/store";
import {
  decideQueueAction,
  listQueue,
  runWorkerOnce,
  type QueueAction,
  type QueueStatus,
} from "@/lib/action.queue";
import {
  decideInvitation,
  listReceivedInvitations,
  listSentInvitations,
  type LinkedInInvitation,
} from "@/lib/linkedin.requests";

export const Route = createFileRoute("/requests")({
  head: () => ({
    meta: [
      { title: "Requests — Network Manager" },
      {
        name: "description",
        content: "Botdog-style action queue and LinkedIn connection requests.",
      },
    ],
  }),
  component: RequestsPage,
});

const STATUS_TONE: Record<QueueStatus, string> = {
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  approved: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  running: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  retrying: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
  sent: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  rejected: "bg-muted text-muted-foreground",
  failed: "bg-destructive/15 text-destructive",
};

function timeAgo(ts?: string) {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function RequestsPage() {
  const session = useStore((s) => s.session);
  const cookies = (session as any).cookies as { li_at: string; JSESSIONID: string } | undefined;

  const fetchQueue = useServerFn(listQueue);
  const decideQueue = useServerFn(decideQueueAction);
  const workerOnce = useServerFn(runWorkerOnce);
  const fetchReceived = useServerFn(listReceivedInvitations);
  const fetchSent = useServerFn(listSentInvitations);
  const decideInvite = useServerFn(decideInvitation);

  const [queue, setQueue] = useState<QueueAction[]>([]);
  const [received, setReceived] = useState<LinkedInInvitation[]>([]);
  const [sent, setSent] = useState<LinkedInInvitation[]>([]);
  const [loadingQueue, setLoadingQueue] = useState(false);
  const [loadingInvites, setLoadingInvites] = useState(false);
  const [workerBusy, setWorkerBusy] = useState(false);
  const [autoWorker, setAutoWorker] = useState(false);
  const [note, setNote] = useState("");

  const pending = queue.filter((a) => a.status === "pending");
  const approved = queue.filter((a) => ["approved", "retrying", "running"].includes(a.status));
  const history = queue.filter((a) => ["sent", "failed", "rejected"].includes(a.status));
  const totalPending = pending.length + received.length;

  const loadQueue = useCallback(async () => {
    setLoadingQueue(true);
    try {
      const res = await fetchQueue({});
      if (res.success) setQueue(res.actions);
    } finally {
      setLoadingQueue(false);
    }
  }, [fetchQueue]);

  const loadInvites = useCallback(async () => {
    if (!cookies) return;
    setLoadingInvites(true);
    setNote("");
    try {
      const [r, s] = await Promise.all([
        fetchReceived({ data: { cookies, headless: true } }),
        fetchSent({ data: { cookies, headless: true } }),
      ]);
      if (r.success) setReceived(r.invitations);
      else setNote("Incoming requests: " + r.error);
      if (s.success) setSent(s.invitations);
      else setNote((prev) => [prev, "Sent requests: " + s.error].filter(Boolean).join(" · "));
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setLoadingInvites(false);
    }
  }, [cookies, fetchReceived, fetchSent]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);
  useEffect(() => {
    if (!autoWorker || !cookies) return;
    const id = setInterval(() => void runWorker(), 120_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoWorker, cookies]);

  async function decide(id: string, approve: boolean) {
    const res = await decideQueue({ data: { id, approve } });
    if (!res.success) setNote(res.error);
    else if (approve)
      setNote(
        "Approved. It is waiting for the worker; use Run worker or turn Auto on. It is not marked sent until LinkedIn confirms it.",
      );
    else setNote("Rejected. The worker will skip this action.");
    await loadQueue();
  }

  async function runWorker() {
    if (!cookies || workerBusy) return;
    setWorkerBusy(true);
    setNote("");
    try {
      const res = await workerOnce({ data: { cookies, headless: true } });
      if (res.ran) {
        setNote(
          res.success
            ? "✓ Worker sent one due action."
            : `⚠ Worker attempted one action: ${res.error}`,
        );
      } else {
        setNote(res.message);
      }
      await loadQueue();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setWorkerBusy(false);
    }
  }

  async function handleInvite(inv: LinkedInInvitation, action: "accept" | "ignore") {
    if (!cookies) return;
    setNote("");
    const res = await decideInvite({
      data: { cookies, invitationId: inv.id, entityUrn: inv.entityUrn, action, headless: true },
    });
    if (res.success) {
      setReceived((prev) => prev.filter((r) => r.id !== inv.id));
      setNote(action === "accept" ? "✓ Invitation accepted." : "✓ Invitation ignored.");
    } else {
      setNote(res.error);
    }
  }

  const health = useMemo(() => {
    if (!cookies) return "Connect LinkedIn first";
    if (approved.length > 0) return `${approved.length} approved / retrying`;
    if (pending.length > 0) return `${pending.length} awaiting approval`;
    return "Queue idle";
  }, [cookies, approved.length, pending.length]);

  return (
    <AppShell
      title="Requests"
      rightSlot={
        <Badge variant={totalPending > 0 ? "default" : "secondary"}>{totalPending} pending</Badge>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 py-6">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" /> Botdog Queue
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Persistent action queue · retries with backoff · caps/warmup safe
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={loadQueue} disabled={loadingQueue}>
              <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loadingQueue ? "animate-spin" : ""}`} />{" "}
              Queue
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={loadInvites}
              disabled={!cookies || loadingInvites}
            >
              <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loadingInvites ? "animate-spin" : ""}`} />{" "}
              Requests
            </Button>
            <Button size="sm" onClick={runWorker} disabled={!cookies || workerBusy}>
              {workerBusy ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="mr-1 h-3.5 w-3.5" />
              )}
              Run worker
            </Button>
            <Button
              size="sm"
              variant={autoWorker ? "default" : "outline"}
              onClick={() => setAutoWorker((v) => !v)}
              disabled={!cookies}
            >
              <Clock className="mr-1 h-3.5 w-3.5" /> {autoWorker ? "Auto on" : "Auto off"}
            </Button>
          </div>
        </div>

        {note && (
          <div className="mb-4 rounded-lg border bg-muted/40 px-4 py-2 text-xs text-foreground">
            {note}
          </div>
        )}

        {!cookies && (
          <Card className="mb-4 flex items-center gap-3 border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-300">
            <AlertCircle className="h-4 w-4 shrink-0" />
            Connect LinkedIn from the top-right header before fetching requests or running the
            worker.
          </Card>
        )}

        <Tabs defaultValue="queue" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mb-5 shrink-0">
            <TabsTrigger value="queue" className="gap-1.5">
              <Send className="h-3.5 w-3.5" /> Queue
              {pending.length > 0 && <CountBadge n={pending.length} />}
            </TabsTrigger>
            <TabsTrigger value="incoming" className="gap-1.5">
              <UserPlus className="h-3.5 w-3.5" /> Incoming
              {received.length > 0 && <CountBadge n={received.length} />}
            </TabsTrigger>
            <TabsTrigger value="sent" className="gap-1.5">
              <Users className="h-3.5 w-3.5" /> Sent invites
              {sent.length > 0 && <CountBadge n={sent.length} />}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="queue" className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-2 pb-8">
            <Card className="p-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Worker health</span>
                <Badge variant="secondary">{health}</Badge>
              </div>
            </Card>

            {queue.length === 0 ? (
              <Card className="flex flex-col items-center gap-3 p-12 text-center">
                <InboxIcon className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm font-medium">No queued actions yet</p>
                <p className="text-xs text-muted-foreground">
                  Draft outreach from{" "}
                  <Link to="/" className="underline">
                    AI Agent
                  </Link>{" "}
                  or the Inbox composer; approved actions will run here.
                </p>
              </Card>
            ) : null}

            {pending.length > 0 && (
              <section>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Pending approval
                  </h2>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => pending.forEach((a) => void decide(a.id, true))}
                  >
                    <Check className="mr-1 h-3 w-3" /> Approve all
                  </Button>
                </div>
                <div className="space-y-3">
                  {pending.map((a, i) => (
                    <ActionCard key={a.id} a={a} position={i + 1} onDecide={decide} />
                  ))}
                </div>
              </section>
            )}

            {approved.length > 0 && (
              <section>
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Approved / retrying
                </h2>
                <div className="space-y-3">
                  {approved.map((a, i) => (
                    <ActionCard
                      key={a.id}
                      a={a}
                      position={pending.length + i + 1}
                      onDecide={decide}
                    />
                  ))}
                </div>
              </section>
            )}

            {history.length > 0 && (
              <section>
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  History
                </h2>
                <div className="space-y-3">
                  {history.map((a) => (
                    <ActionCard key={a.id} a={a} onDecide={decide} />
                  ))}
                </div>
              </section>
            )}
          </TabsContent>

          <TabsContent
            value="incoming"
            className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-2 pb-8"
          >
            {loadingInvites && <Loading label="Loading incoming requests…" />}
            {!loadingInvites && received.length === 0 ? (
              <Card className="flex flex-col items-center gap-3 p-12 text-center">
                <Users className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm font-medium">No pending connection requests</p>
              </Card>
            ) : null}
            {received.map((req) => (
              <InviteCard key={req.id} req={req} onAction={handleInvite} />
            ))}
          </TabsContent>

          <TabsContent value="sent" className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-2 pb-8">
            {loadingInvites && <Loading label="Loading sent invites…" />}
            {!loadingInvites && sent.length === 0 ? (
              <Card className="flex flex-col items-center gap-3 p-12 text-center">
                <MailCheck className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm font-medium">No sent invitations found</p>
              </Card>
            ) : null}
            {sent.map((req) => (
              <SentInviteCard key={req.id} req={req} />
            ))}
          </TabsContent>
        </Tabs>
      </div>
    </AppShell>
  );
}

function CountBadge({ n }: { n: number }) {
  return (
    <span className="ml-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
      {n}
    </span>
  );
}
function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </div>
  );
}
function shortActionId(id: string) {
  return id.replace(/^act_/, "").slice(-8).toUpperCase();
}
function ActionCard({
  a,
  position,
  onDecide,
}: {
  a: QueueAction;
  position?: number;
  onDecide: (id: string, approve: boolean) => void;
}) {
  const Icon = a.type === "profile_view" ? Eye : a.type === "message" ? MailCheck : Send;
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{a.targetName}</p>
            <p className="text-xs text-muted-foreground">
              {position ? `#${position} in FIFO queue · ` : ""}
              {a.type} · {timeAgo(a.updatedAt)}
            </p>
          </div>
        </div>
        <Badge className={`text-[10px] ${STATUS_TONE[a.status]}`} variant="secondary">
          {a.status === "running" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
          {a.status}
        </Badge>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
          ID {shortActionId(a.id)}
        </span>
        <span>attempt {a.attempts}</span>
        {a.targetUrl && (
          <a
            href={a.targetUrl}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-2 hover:underline"
          >
            profile
          </a>
        )}
        {a.threadUrl && (
          <a
            href={a.threadUrl}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-2 hover:underline"
          >
            thread
          </a>
        )}
        {a.status === "sent" && a.sentAt && (
          <span>sent {new Date(a.sentAt).toLocaleTimeString()}</span>
        )}
      </div>
      {a.body && <p className="whitespace-pre-wrap rounded bg-muted p-2 text-xs">{a.body}</p>}
      {a.reasoning && (
        <p className="mt-2 text-[11px] italic text-muted-foreground">Why: {a.reasoning}</p>
      )}
      {a.lastError && (
        <p className="mt-2 rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {a.lastError}
        </p>
      )}
      {a.nextRunAt && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Next retry: {new Date(a.nextRunAt).toLocaleTimeString()}
        </p>
      )}
      {a.status === "pending" && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" className="flex-1" onClick={() => onDecide(a.id, true)}>
            <Check className="mr-1 h-3 w-3" /> Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={() => onDecide(a.id, false)}
          >
            <X className="mr-1 h-3 w-3" /> Reject
          </Button>
        </div>
      )}
    </Card>
  );
}
function InviteCard({
  req,
  onAction,
}: {
  req: LinkedInInvitation;
  onAction: (req: LinkedInInvitation, action: "accept" | "ignore") => void;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
          {req.fromName.charAt(0)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {req.profileUrl ? (
              <a href={req.profileUrl} target="_blank" rel="noreferrer" className="hover:underline">
                {req.fromName}
              </a>
            ) : (
              req.fromName
            )}
          </p>
          <p className="text-xs text-muted-foreground">{req.fromHeadline}</p>
          {!!req.mutualConnections && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {req.mutualConnections} mutual connections
            </p>
          )}
          {req.message && (
            <p className="mt-2 rounded bg-muted px-3 py-2 text-xs italic">“{req.message}”</p>
          )}
          <div className="mt-3 flex gap-2">
            <Button size="sm" className="h-8 flex-1" onClick={() => onAction(req, "accept")}>
              <Check className="mr-1 h-3 w-3" /> Accept
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 flex-1"
              onClick={() => onAction(req, "ignore")}
            >
              <X className="mr-1 h-3 w-3" /> Ignore
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
function SentInviteCard({ req }: { req: LinkedInInvitation }) {
  return (
    <Card className="p-4">
      <p className="text-sm font-medium">
        {req.profileUrl ? (
          <a href={req.profileUrl} target="_blank" rel="noreferrer" className="hover:underline">
            {req.fromName}
          </a>
        ) : (
          req.fromName
        )}
      </p>
      <p className="text-xs text-muted-foreground">{req.fromHeadline}</p>
      {req.sentAt && <p className="mt-1 text-[11px] text-muted-foreground">Sent {req.sentAt}</p>}
    </Card>
  );
}
