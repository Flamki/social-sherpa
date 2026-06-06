import { Link } from "@tanstack/react-router";
import { Linkedin } from "lucide-react";
import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import { useStore, warmupDay, todaysUsage, effectiveCaps } from "@/lib/store";

const tabs = [
  { to: "/", label: "Agent" },
  { to: "/connections", label: "Connections" },
  { to: "/onboarding", label: "Onboarding" },
] as const;

export function Nav() {
  const state = useStore((s) => s);
  const session = state.session;
  const day = useMemo(() => warmupDay(state), [state]);
  const usage = useMemo(() => todaysUsage(state), [state]);
  const caps = useMemo(() => effectiveCaps(state), [state]);
  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-3">
        <div className="flex items-center gap-3">
          <Linkedin className="h-5 w-5 text-primary" />
          <span className="text-sm font-semibold">Network Manager</span>
          <Badge variant="secondary" className="text-[10px]">
            v0 · mock send
          </Badge>
        </div>
        <nav className="flex items-center gap-1 text-sm">
          {tabs.map((t) => (
            <Link
              key={t.to}
              to={t.to}
              className="rounded-md px-3 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              activeProps={{
                className: "rounded-md px-3 py-1.5 bg-muted text-foreground font-medium",
              }}
              activeOptions={{ exact: true }}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className={session.connected ? "text-emerald-600" : "text-amber-600"}>
            {session.connected ? "● Session linked" : "○ No session"}
          </span>
          {day > 0 && <span>· Warmup day {day}/14</span>}
          <span>
            · Today {usage.invites}/{caps.invitesPerDay} inv · {usage.messages}/
            {caps.messagesPerDay} msg · {usage.views}/{caps.profileViewsPerDay} view
          </span>
        </div>
      </div>
    </header>
  );
}
