import { createFileRoute, Link } from "@tanstack/react-router";
import { MailCheck, Send, Eye } from "lucide-react";

import { AppShell } from "@/components/app/AppShell";
import { Card } from "@/components/ui/card";
import { useStore } from "@/lib/store";

export const Route = createFileRoute("/inbox")({
  head: () => ({
    meta: [
      { title: "Inbox — Network Manager" },
      { name: "description", content: "Recently sent outreach from your AI agent." },
    ],
  }),
  component: InboxPage,
});

function InboxPage() {
  const sent = useStore((s) => s.actions.filter((a) => a.status === "sent"));
  return (
    <AppShell title="Inbox">
      <div className="mx-auto max-w-3xl space-y-3 px-6 py-6">
        {sent.length === 0 ? (
          <Card className="flex flex-col items-center gap-3 p-12 text-center">
            <MailCheck className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium">No sent messages yet</p>
            <p className="text-xs text-muted-foreground">
              Approve drafts in <Link to="/requests" className="underline">Requests</Link> and they'll show up here.
            </p>
          </Card>
        ) : (
          sent.map((a) => {
            const Icon = a.type === "profile_view" ? Eye : a.type === "email" ? MailCheck : Send;
            return (
              <Card key={a.id} className="p-4">
                <div className="mb-1 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-emerald-600" />
                    <p className="text-sm font-medium">{a.target_name}</p>
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    {a.sent_at ? new Date(a.sent_at).toLocaleString() : ""}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">{a.channel}</p>
                {a.subject && <p className="mt-2 text-xs font-medium">Subject: {a.subject}</p>}
                <p className="mt-1 whitespace-pre-wrap rounded bg-muted p-2 text-xs">{a.body}</p>
              </Card>
            );
          })
        )}
      </div>
    </AppShell>
  );
}