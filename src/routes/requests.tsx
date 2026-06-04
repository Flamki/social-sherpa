import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Send, Check, X, Loader2, MailCheck, Eye, Inbox as InboxIcon, UserPlus, Users } from "lucide-react";

import { AppShell } from "@/components/app/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { decide, startWorker, useStore, type Action, type ActionStatus } from "@/lib/store";
import { MOCK_CONNECTION_REQUESTS } from "@/lib/mockConnections";

export const Route = createFileRoute("/requests")({
  head: () => ({
    meta: [
      { title: "Requests — Network Manager" },
      { name: "description", content: "Review agent-queued outreach and incoming connection requests." },
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

  const [incomingRequests, setIncomingRequests] = useState(MOCK_CONNECTION_REQUESTS);

  const pending = actions.filter((a) => a.status === "pending");
  const other = actions.filter((a) => a.status !== "pending" && a.status !== "sent");
  const totalPending = pending.length + incomingRequests.length;

  function acceptRequest(id: string) {
    setIncomingRequests((prev) => prev.filter((r) => r.id !== id));
  }
  function ignoreRequest(id: string) {
    setIncomingRequests((prev) => prev.filter((r) => r.id !== id));
  }

  return (
    <AppShell
      title="Requests"
      rightSlot={<Badge variant={totalPending > 0 ? "default" : "secondary"}>{totalPending} pending</Badge>}
    >
      <div className="mx-auto max-w-3xl px-6 py-6">
        <Tabs defaultValue="outgoing">
          <TabsList className="mb-5">
            <TabsTrigger value="outgoing" className="gap-1.5">
              <Send className="h-3.5 w-3.5" />
              Agent Queue
              {pending.length > 0 && (
                <span className="ml-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                  {pending.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="incoming" className="gap-1.5">
              <UserPlus className="h-3.5 w-3.5" />
              Incoming
              {incomingRequests.length > 0 && (
                <span className="ml-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                  {incomingRequests.length}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          {/* Agent Queue Tab */}
          <TabsContent value="outgoing" className="space-y-4">
            {actions.length === 0 ? (
              <Card className="flex flex-col items-center gap-3 p-12 text-center">
                <InboxIcon className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm font-medium">No requests yet</p>
                <p className="text-xs text-muted-foreground">
                  Ask the <Link to="/" className="underline">AI Agent</Link> to draft outreach — actions appear here for approval.
                </p>
              </Card>
            ) : null}

            {pending.length > 0 && (
              <section>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pending approval</h2>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => pending.forEach((a) => decide(a.id, true))}
                  >
                    <Check className="mr-1 h-3 w-3" /> Approve all
                  </Button>
                </div>
                <div className="space-y-3">
                  {pending.map((a) => <ActionCard key={a.id} a={a} />)}
                </div>
              </section>
            )}

            {other.length > 0 && (
              <section>
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">In progress</h2>
                <div className="space-y-3">
                  {other.map((a) => <ActionCard key={a.id} a={a} />)}
                </div>
              </section>
            )}
          </TabsContent>

          {/* Incoming Tab */}
          <TabsContent value="incoming" className="space-y-3">
            {incomingRequests.length === 0 ? (
              <Card className="flex flex-col items-center gap-3 p-12 text-center">
                <Users className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm font-medium">No pending connection requests</p>
              </Card>
            ) : (
              incomingRequests.map((req) => (
                <Card key={req.id} className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-sm font-bold text-primary shrink-0">
                      {req.fromName.charAt(0)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{req.fromName}</p>
                      <p className="text-xs text-muted-foreground">{req.fromHeadline}</p>
                      {req.mutualConnections > 0 && (
                        <p className="text-[11px] text-muted-foreground mt-0.5">{req.mutualConnections} mutual connections</p>
                      )}
                      {req.message && (
                        <p className="mt-2 rounded bg-muted px-3 py-2 text-xs italic">"{req.message}"</p>
                      )}
                      <div className="mt-3 flex gap-2">
                        <Button size="sm" className="flex-1 h-8" onClick={() => acceptRequest(req.id)}>
                          <Check className="mr-1 h-3 w-3" /> Accept
                        </Button>
                        <Button size="sm" variant="outline" className="flex-1 h-8" onClick={() => ignoreRequest(req.id)}>
                          <X className="mr-1 h-3 w-3" /> Ignore
                        </Button>
                      </div>
                    </div>
                  </div>
                </Card>
              ))
            )}
          </TabsContent>
        </Tabs>
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
