import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { MailCheck, Send, Eye, MessageCircle, ChevronDown, ChevronUp } from "lucide-react";

import { AppShell } from "@/components/app/AppShell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import { MOCK_INBOX_MESSAGES } from "@/lib/mockConnections";

export const Route = createFileRoute("/inbox")({
  head: () => ({
    meta: [
      { title: "Inbox — Network Manager" },
      { name: "description", content: "LinkedIn messages and sent outreach from your AI agent." },
    ],
  }),
  component: InboxPage,
});

function timeAgo(ts: string) {
  const diff = Date.now() - new Date(ts).getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return "Just now";
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function InboxPage() {
  const sent = useStore((s) => s.actions.filter((a) => a.status === "sent"));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [messages, setMessages] = useState(MOCK_INBOX_MESSAGES);

  function markRead(id: string) {
    setMessages((prev) => prev.map((m) => m.id === id ? { ...m, unread: false } : m));
    setExpanded((cur) => cur === id ? null : id);
  }

  const unreadCount = messages.filter((m) => m.unread).length;

  return (
    <AppShell
      title="Inbox"
      rightSlot={unreadCount > 0 ? <Badge>{unreadCount} unread</Badge> : undefined}
    >
      <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">

        {/* LinkedIn Received Messages */}
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <MessageCircle className="h-3.5 w-3.5" />
            LinkedIn Messages
          </h2>
          <div className="space-y-2">
            {messages.map((msg) => (
              <Card
                key={msg.id}
                className={`cursor-pointer transition-colors hover:bg-muted/50 ${msg.unread ? "border-primary/40 bg-primary/5" : ""}`}
                onClick={() => markRead(msg.id)}
              >
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                        {msg.fromName.charAt(0)}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium truncate">{msg.fromName}</p>
                          {msg.unread && <span className="h-2 w-2 rounded-full bg-primary shrink-0" />}
                        </div>
                        <p className="text-[11px] text-muted-foreground truncate">{msg.fromHeadline}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] text-muted-foreground">{timeAgo(msg.timestamp)}</span>
                      {expanded === msg.id ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                    </div>
                  </div>
                  {expanded !== msg.id && (
                    <p className="mt-2 text-xs text-muted-foreground truncate pl-12">{msg.preview}</p>
                  )}
                  {expanded === msg.id && (
                    <div className="mt-3 space-y-2 pl-12">
                      {msg.thread.map((t, i) => (
                        <div key={i} className={`flex ${t.from === "me" ? "justify-end" : "justify-start"}`}>
                          <div className={`max-w-[80%] rounded-xl px-3 py-2 text-xs ${
                            t.from === "me"
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted text-foreground"
                          }`}>
                            {t.text}
                          </div>
                        </div>
                      ))}
                      <div className="flex gap-2 pt-1">
                        <Button size="sm" variant="outline" className="h-7 text-xs flex-1">Reply</Button>
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </section>

        {/* Sent by Agent */}
        {sent.length > 0 && (
          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Send className="h-3.5 w-3.5" />
              Sent by Agent
            </h2>
            <div className="space-y-2">
              {sent.map((a) => {
                const Icon = a.type === "profile_view" ? Eye : a.type === "email" ? MailCheck : Send;
                return (
                  <Card key={a.id} className="p-4">
                    <div className="mb-1 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Icon className="h-4 w-4 text-emerald-600" />
                        <p className="text-sm font-medium">{a.target_name}</p>
                      </div>
                      <span className="text-[10px] text-muted-foreground">
                        {a.sent_at ? timeAgo(a.sent_at) : ""}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">{a.channel}</p>
                    {a.subject && <p className="mt-2 text-xs font-medium">Subject: {a.subject}</p>}
                    <p className="mt-1 whitespace-pre-wrap rounded bg-muted p-2 text-xs">{a.body}</p>
                  </Card>
                );
              })}
            </div>
          </section>
        )}

        {sent.length === 0 && messages.length === 0 && (
          <Card className="flex flex-col items-center gap-3 p-12 text-center">
            <MailCheck className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium">No messages yet</p>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
