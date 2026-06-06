import { Link } from "@tanstack/react-router";
import { useMemo, useState, useEffect, type ReactNode } from "react";
import {
  Users,
  UserPlus,
  LayoutDashboard,
  Settings,
  PanelLeftClose,
  PanelLeft,
  User,
  Moon,
  Sun,
  LogOut,
  MessageSquareText,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

import { useStore, warmupDay, todaysUsage, effectiveCaps } from "@/lib/store";
import crockbotLogo from "@/assets/crockbot-logo.png";

const nav = [
  { to: "/", label: "AI Agent", icon: MessageSquareText, exact: true },
  { to: "/connections", label: "Connections", icon: Users },
  { to: "/requests", label: "Requests", icon: UserPlus, badgeKey: "requests" as const },
  { to: "/overview", label: "Overview", icon: LayoutDashboard },
] as const;

const footerNav = [{ to: "/onboarding", label: "Onboarding", icon: Settings }] as const;

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
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    return (
      (localStorage.getItem("theme") as "light" | "dark") ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    );
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("theme", theme);
  }, [theme]);

  const pending = state.actions.filter((a) => a.status === "pending").length;
  const badges: Record<"requests", number> = {
    requests: pending,
  };

  return (
    <div className="flex h-screen overflow-hidden bg-muted/30 text-foreground">
      <aside
        className={`hidden shrink-0 flex-col border-r bg-background transition-[width] duration-200 md:flex ${
          collapsed ? "w-14" : "w-60"
        }`}
      >
        <div className="relative flex h-16 items-center px-2">
          {!collapsed && (
            <img
              src={crockbotLogo}
              alt=""
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-2 top-1/2 -z-0 h-14 w-[calc(100%-1rem)] -translate-y-1/2 select-none object-contain opacity-60 dark:invert"
            />
          )}
          {!collapsed && (
            <span className="relative z-10 ml-10 text-lg font-extrabold tracking-tight text-foreground">
              CrockBot
            </span>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={`relative z-10 ml-auto inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground ${
              collapsed ? "mx-auto" : ""
            }`}
          >
            {collapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </button>
        </div>
        <nav className="flex-1 px-3">
          {nav.map((t) => {
            const Icon = t.icon;
            const badge = "badgeKey" in t && t.badgeKey ? badges[t.badgeKey] : 0;
            return (
              <Link
                key={t.to}
                to={t.to}
                title={collapsed ? t.label : undefined}
                className={`mb-0.5 flex items-center justify-between gap-3 rounded-md py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground ${
                  collapsed ? "justify-center px-0" : "px-3"
                }`}
                activeProps={{
                  className: `mb-0.5 flex items-center justify-between gap-3 rounded-md py-2 text-sm bg-primary/10 text-primary font-medium ${
                    collapsed ? "justify-center px-0" : "px-3"
                  }`,
                }}
                activeOptions={{ exact: "exact" in t ? t.exact : false }}
              >
                <span className="flex items-center gap-3">
                  <Icon className="h-4 w-4" />
                  {!collapsed && t.label}
                </span>
                {!collapsed && badge > 0 && (
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
                title={collapsed ? t.label : undefined}
                className={`mb-0.5 flex items-center gap-3 rounded-md py-2 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground ${
                  collapsed ? "justify-center px-0" : "px-3"
                }`}
                activeProps={{
                  className: `mb-0.5 flex items-center gap-3 rounded-md py-2 text-xs bg-muted text-foreground ${
                    collapsed ? "justify-center px-0" : "px-3"
                  }`,
                }}
              >
                <Icon className="h-3.5 w-3.5" />
                {!collapsed && t.label}
              </Link>
            );
          })}
          {!collapsed && (
            <div className="mt-2 px-3 text-[10px] leading-relaxed text-muted-foreground">
              {day > 0 && <div>Warmup day {day}/14</div>}
              <div>
                Today {usage.invites}/{caps.invitesPerDay} inv · {usage.messages}/
                {caps.messagesPerDay} msg
              </div>
            </div>
          )}
        </div>
        <div className="border-t p-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={`flex w-full items-center gap-2 rounded-md p-2 text-left text-sm hover:bg-muted ${
                  collapsed ? "justify-center" : ""
                }`}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  U
                </span>
                {!collapsed && (
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      Your account
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {session.connected ? "Connected" : "Not connected"}
                    </span>
                  </span>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-56">
              <DropdownMenuItem asChild>
                <Link to="/onboarding">
                  <User className="h-4 w-4" />
                  Account
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  setTheme(theme === "dark" ? "light" : "dark");
                }}
              >
                {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                {theme === "dark" ? "Light mode" : "Dark mode"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  localStorage.clear();
                  window.location.reload();
                }}
              >
                <LogOut className="h-4 w-4" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b bg-background px-6">
          <h1 className="text-base font-semibold">{title}</h1>
          <div className="flex items-center gap-3 text-xs">
            {rightSlot}
            {session.connected ? (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                Connected to LinkedIn
              </span>
            ) : (
              <Link
                to="/onboarding"
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                <span className="h-2 w-2 rounded-full bg-amber-500" />
                Not connected
              </Link>
            )}
          </div>
        </header>
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
