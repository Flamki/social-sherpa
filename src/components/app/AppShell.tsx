import { Link } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";
import { Bot, Users, Inbox, UserPlus, LayoutDashboard, Settings, Chrome } from "lucide-react";

import { useStore, warmupDay, todaysUsage, effectiveCaps } from "@/lib/store";

const nav = [
  { to: "/", label: "AI Agent", icon: Bot, exact: true },
  { to: "/connections", label: "Connections", icon: Users },
  { to: "/inbox", label: "Inbox", icon: Inbox, badgeKey: "inbox" as const },
  { to: "/requests", label: "Requests", icon: UserPlus, badgeKey: "requests" as const },
  { to: "/overview", label: "Overview", icon: LayoutDashboard },
] as const;

const footerNav = [
  { to: "/onboarding", label: "Onboarding", icon: Settings },
  { to: "/extension", label: "Extension", icon: Chrome },
] as const;

export function AppShell({
  title,
  rightSlot,
  children,
}: {
  title: string;
  rightSlot?: ReactNode;
  children: ReactNode;
}) {
  const state = useStore((s) => s);
  const session = state.session;
  const day = useMemo(() => warmupDay(state), [state]);
  const usage = useMemo(() => todaysUsage(state), [state]);
  const caps = useMemo(() => effectiveCaps(state), [state]);

  const pending = state.actions.filter((a) => a.status === "pending").length;
  const badges: Record<"inbox" | "requests", number> = {
    inbox: state.actions.filter((a) => a.status === "sent").length,
    requests: pending,
  };

  return (
    <div className="flex h-screen overflow-hidden bg-muted/30 text-foreground">
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-background md:flex">
        <div className="flex items-center gap-2 px-5 py-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <span className="text-sm font-bold">N</span>
          </div>
          <span className="text-sm font-semibold">NetManager</span>
        </div>
        <nav className="flex-1 px-3">
          {nav.map((t) => {
            const Icon = t.icon;
            const badge = "badgeKey" in t && t.badgeKey ? badges[t.badgeKey] : 0;
            return (
              <Link
                key={t.to}
                to={t.to}
                className="mb-0.5 flex items-center justify-between gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
                activeProps={{
                  className:
                    "mb-0.5 flex items-center justify-between gap-3 rounded-md px-3 py-2 text-sm bg-primary/10 text-primary font-medium",
                }}
                activeOptions={{ exact: "exact" in t ? t.exact : false }}
              >
                <span className="flex items-center gap-3">
                  <Icon className="h-4 w-4" />
                  {t.label}
                </span>
                {badge > 0 && (
                  <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                    {badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="border-t px-3 py-3">
          {footerNav.map((t) => {
            const Icon = t.icon;
            return (
              <Link
                key={t.to}
                to={t.to}
                className="mb-0.5 flex items-center gap-3 rounded-md px-3 py-2 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
                activeProps={{
                  className:
                    "mb-0.5 flex items-center gap-3 rounded-md px-3 py-2 text-xs bg-muted text-foreground",
                }}
              >
                <Icon className="h-3.5 w-3.5" />
                {t.label}
              </Link>
            );
          })}
          <div className="mt-2 px-3 text-[10px] leading-relaxed text-muted-foreground">
            {day > 0 && <div>Warmup day {day}/14</div>}
            <div>
              Today {usage.invites}/{caps.invitesPerDay} inv · {usage.messages}/{caps.messagesPerDay} msg
            </div>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b bg-background px-6">
          <h1 className="text-base font-semibold">{title}</h1>
          <div className="flex items-center gap-3 text-xs">
            {rightSlot}
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span
                className={`h-2 w-2 rounded-full ${session.connected ? "bg-emerald-500" : "bg-amber-500"}`}
              />
              {session.connected ? "Connected to LinkedIn" : "Not connected"}
            </span>
          </div>
        </header>
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
      </div>
    </div>
  );
}