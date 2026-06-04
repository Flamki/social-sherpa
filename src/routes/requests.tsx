import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { Send, Check, X, Loader2, MailCheck, Eye, Inbox as InboxIcon } from "lucide-react";

import { AppShell } from "@/components/app/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { decide, startWorker, useStore, type Action, type ActionStatus } from "@/lib/store";

export const Route = createFileRoute("/requests")({
  head: () => ({
    meta: [
      { title: "Requests — Network Manager" },
      { name: "description", content: "Review and approve outreach actions queued by your AI agent." },
    ],
  }),
  component: RequestsPage,
});

const STATUS_TONE: Record<ActionStatus, string> = {
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  approved: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  sending: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  sent: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  rejected: "bg-muted text-muted-foreground",
  failed: "bg-destructive/15 text-destructive",
};

function RequestsPage() {
  const actions = useStore((s) => s.actions);
  useEffect(() => { startWorker(); }, []);

  const pending = actions.filter((a) => a.status === "pending");
  const other = actions.filter((a) => a.status !== "pending" && a.status !== "sent");

  return (
    <AppShell
      title="Requests"
      rightSlot={<Badge variant={pending.length ? "default" : "secondary"}>{pending.length} pending</Badge>}
    >
      <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
        {actions.length === 0 && (
          <Card className="flex flex-col items-center gap-3 p-12 text-center">
            <InboxIcon className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium">No requests yet</p>
            <p className="text-xs text-muted-foreground">
              Ask the <Link to="/" className="underline">AI Agent</Link> to draft outreach — actions appear here for approval.
            </p>
          </Card>
        )}

        {pending.length > 0 && (
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pending approval</h2>
            <div className="space-y-3">
              {pending.map((a) => <ActionCard key={a.id} a={a} />)}
            </div>
          </section>
        )}

        {other.length > 0 && (
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">In progress</h2>
            <div className="space-y-3">
              {other.map((a) => <ActionCard key={a.id} a={a} />)}
            </div>
          </section>
        )}
      </div>
    </AppShell>
  );

  function ActionCard({ a }: { a: Action }) {
    const Icon = a.type === "profile_view" ? Eye : a.type === "email" ? MailCheck : Send;
    return (
      <Card className="p-4">
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
      </Card>
    );
  }
}