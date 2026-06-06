import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { Users, Send, MailCheck, Eye, Activity } from "lucide-react";

import { AppShell } from "@/components/app/AppShell";
import { Card } from "@/components/ui/card";
import { useStore, warmupDay, todaysUsage, effectiveCaps } from "@/lib/store";

export const Route = createFileRoute("/overview")({
  head: () => ({
    meta: [
      { title: "Overview — Network Manager" },
      { name: "description", content: "Activity, warmup progress, and daily limits at a glance." },
    ],
  }),
  component: OverviewPage,
});

function OverviewPage() {
  const state = useStore((s) => s);
  const day = useMemo(() => warmupDay(state), [state]);
  const usage = useMemo(() => todaysUsage(state), [state]);
  const caps = useMemo(() => effectiveCaps(state), [state]);

  const counts = {
    connections: state.connections.items.length,
    sent: state.actions.filter((a) => a.status === "sent").length,
    pending: state.actions.filter((a) => a.status === "pending").length,
    views: state.actions.filter((a) => a.type === "profile_view" && a.status === "sent").length,
  };

  const tiles = [
    { label: "Connections", value: counts.connections, icon: Users },
    { label: "Sent", value: counts.sent, icon: MailCheck },
    { label: "Pending", value: counts.pending, icon: Send },
    { label: "Profile views", value: counts.views, icon: Eye },
  ];

  return (
    <AppShell title="Overview">
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-6">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {tiles.map((t) => {
            const Icon = t.icon;
            return (
              <Card key={t.label} className="p-4">
                <div className="mb-2 flex items-center justify-between text-muted-foreground">
                  <span className="text-xs">{t.label}</span>
                  <Icon className="h-4 w-4" />
                </div>
                <p className="text-2xl font-semibold">{t.value}</p>
              </Card>
            );
          })}
        </div>

        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Today's usage vs daily caps</h2>
          </div>
          <div className="space-y-3">
            <UsageBar label="Connection invites" used={usage.invites} cap={caps.invitesPerDay} />
            <UsageBar label="Messages" used={usage.messages} cap={caps.messagesPerDay} />
            <UsageBar label="Profile views" used={usage.views} cap={caps.profileViewsPerDay} />
          </div>
          {day > 0 && (
            <p className="mt-4 text-xs text-muted-foreground">
              Account warmup day {day} of 14 — caps ramp up linearly to protect your account.
            </p>
          )}
        </Card>
      </div>
    </AppShell>
  );
}

function UsageBar({ label, used, cap }: { label: string; used: number; cap: number }) {
  const pct = cap === 0 ? 0 : Math.min(100, Math.round((used / cap) * 100));
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span>{label}</span>
        <span className="text-muted-foreground">
          {used} / {cap}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
