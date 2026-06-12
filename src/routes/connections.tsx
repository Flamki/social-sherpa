import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  RefreshCw,
  Users,
  Loader2,
  Key,
  AlertCircle,
  ShieldCheck,
  Fingerprint,
  Globe,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useServerFn } from "@tanstack/react-start";

import { AppShell } from "@/components/app/AppShell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { store, useStore } from "@/lib/store";
import { getConnectionImportJob, startConnectionImportJob } from "@/lib/import.jobs";
import { saveProxyConfig, getSessionInfo } from "@/lib/linkedin.config";
import { testProxy } from "@/lib/linkedin.proxy.fn";
import type { ImportDiagnostic, Lead } from "@/lib/linkedin.sync";

export const Route = createFileRoute("/connections")({
  head: () => ({
    meta: [
      { title: "Connections — Network Manager" },
      { name: "description", content: "Sync and search your LinkedIn connections." },
    ],
  }),
  component: ConnectionsPage,
});

type SyncState = "idle" | "syncing" | "done";

type LiveImportState = {
  jobId: string;
  requestedCount: number;
  items: Lead[];
  latest?: Lead;
  pagesVisited: number;
  source?: "voyager" | "visible";
  complete: boolean;
};

const FIRST_DEGREE_SEARCH_URL =
  "https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&network=%5B%22F%22%5D";

type SessionInfo = {
  accountId: string;
  fingerprint: {
    userAgent: string;
    timezoneId: string;
    locale: string;
    viewport: { width: number; height: number };
  };
  proxy: { host: string; port: number } | null;
  proxySource: "manual" | "auto" | null;
  warmupDay: number;
  dailyImportCap: number;
  withinActiveHours: boolean;
};

function formatImportDiagnostic(diag: ImportDiagnostic) {
  if (!diag) return "";
  const base =
    diag.stopReason === "requested-limit-reached"
      ? "requested import count reached"
      : diag.stopReason === "linkedin-showed-no-next-page"
        ? "LinkedIn showed no next page"
        : diag.stopReason === "linkedin-page-did-not-advance"
          ? "LinkedIn kept returning the same page after Next and direct-page fallback"
          : diag.stopReason === "visible-pages-were-duplicates"
            ? "LinkedIn repeated the same visible results"
            : diag.stopReason === "voyager-pages-were-duplicates"
              ? "LinkedIn repeated the same API results"
              : diag.stopReason === "voyager-returned-empty-page"
                ? "LinkedIn returned an empty API page"
                : diag.stopReason === "voyager-total-reached"
                  ? "LinkedIn API reached its reported total"
                  : diag.stopReason === "voyager-endpoints-exhausted"
                    ? "LinkedIn API endpoints returned no additional unique connections"
                    : diag.stopReason === "voyager-request-failed"
                      ? "LinkedIn API request failed"
                      : diag.stopReason || "importer stopped";
  const stats = [
    diag.source ? `${diag.source} path` : "",
    diag.pagesVisited ? `${diag.pagesVisited} page${diag.pagesVisited === 1 ? "" : "s"}` : "",
    typeof diag.lastPageAdded === "number" ? `last page added ${diag.lastPageAdded}` : "",
    typeof diag.lastParsedCount === "number" ? `parsed ${diag.lastParsedCount}` : "",
    typeof diag.lastAnchorCount === "number" ? `anchors ${diag.lastAnchorCount}` : "",
  ].filter(Boolean);
  return `${base}${stats.length ? ` (${stats.join(", ")})` : ""}`;
}

function ConnectionsPage() {
  const state = useStore((s) => s);
  const conns = state.connections;
  const session = state.session;
  const importOp = state.ops.import;

  const startImport = useServerFn(startConnectionImportJob);
  const getImport = useServerFn(getConnectionImportJob);
  const saveProxy = useServerFn(saveProxyConfig);
  const runProxyTest = useServerFn(testProxy);
  const fetchInfo = useServerFn(getSessionInfo);

  const [search, setSearch] = useState("");
  const [syncState, setSyncState] = useState<SyncState>("idle");
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [liveImport, setLiveImport] = useState<LiveImportState | null>(null);
  const liveJobIdRef = useRef("");
  const revealQueueRef = useRef<Lead[]>([]);
  const queuedIdsRef = useRef(new Set<string>());
  const revealTimerRef = useRef<number | null>(null);
  const pendingCompletionRef = useRef<null | (() => void)>(null);
  const pendingCompletionJobIdRef = useRef("");

  const [liAt, setLiAt] = useState("");
  const [jSessionId, setJSessionId] = useState("");
  const [searchUrl, setSearchUrl] = useState(FIRST_DEGREE_SEARCH_URL);
  const [importLimit, setImportLimit] = useState(25);
  const [showLogin, setShowLogin] = useState(!session.connected);

  // Stealth / safety panel
  const [showStealth, setShowStealth] = useState(false);
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [proxyHost, setProxyHost] = useState("");
  const [proxyPort, setProxyPort] = useState("");
  const [proxyUser, setProxyUser] = useState("");
  const [proxyPass, setProxyPass] = useState("");
  const [headful, setHeadful] = useState(false);
  const [proxyTest, setProxyTest] = useState<"idle" | "testing" | "ok" | "err">("idle");
  const [proxyTestMsg, setProxyTestMsg] = useState("");
  const [cookieImportHostedDisabled, setCookieImportHostedDisabled] = useState(false);

  function currentCookies() {
    return session.cookies || { li_at: liAt, JSESSIONID: jSessionId };
  }

  function finishRevealQueue() {
    if (revealTimerRef.current !== null) {
      window.clearInterval(revealTimerRef.current);
      revealTimerRef.current = null;
    }
    const complete = pendingCompletionRef.current;
    pendingCompletionRef.current = null;
    pendingCompletionJobIdRef.current = "";
    if (complete) complete();
  }

  function beginLiveImport(jobId: string, requestedCount: number) {
    if (liveJobIdRef.current === jobId) return;
    if (revealTimerRef.current !== null) window.clearInterval(revealTimerRef.current);
    liveJobIdRef.current = jobId;
    revealQueueRef.current = [];
    queuedIdsRef.current = new Set();
    pendingCompletionRef.current = null;
    pendingCompletionJobIdRef.current = "";
    revealTimerRef.current = null;
    setLiveImport({
      jobId,
      requestedCount,
      items: [],
      pagesVisited: 0,
      complete: false,
    });
  }

  function enqueueLiveItems(job: any) {
    beginLiveImport(job.id, job.requestedCount || importLimit);
    const incoming = (job.items || []) as Lead[];
    for (const item of incoming) {
      const key = item.publicId || item.profileUrl || item.id;
      if (!key || queuedIdsRef.current.has(key)) continue;
      queuedIdsRef.current.add(key);
      revealQueueRef.current.push(item);
    }

    setLiveImport((current) =>
      current
        ? {
            ...current,
            requestedCount: job.requestedCount || current.requestedCount,
            pagesVisited: job.pagesVisited || current.pagesVisited,
            source: job.source || current.source,
          }
        : current,
    );

    if (revealTimerRef.current !== null || revealQueueRef.current.length === 0) return;
    revealTimerRef.current = window.setInterval(() => {
      const next = revealQueueRef.current.shift();
      if (!next) {
        finishRevealQueue();
        return;
      }
      setLiveImport((current) =>
        current
          ? {
              ...current,
              items: [...current.items, next],
              latest: next,
            }
          : current,
      );
      if (revealQueueRef.current.length === 0 && pendingCompletionRef.current) {
        finishRevealQueue();
      }
    }, 90);
  }

  function completeImportJob(job: any, cookiesToUse: ReturnType<typeof currentCookies>) {
    const res = job.result;
    store.set((s) => ({
      ...s,
      session: { ...s.session, connected: true, cookies: cookiesToUse },
      connections: {
        source: "linkedin",
        uploadedAt: new Date().toISOString(),
        items: res.items as any,
      },
      ops: {
        ...s.ops,
        import: {
          status: "done",
          jobId: job.id,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt || new Date().toISOString(),
          requestedCount: job.requestedCount,
          importedCount: res.count,
          totalAvailable: res.totalAvailable,
          message: `Imported ${res.count} connections.`,
        },
      },
    }));
    setLiveImport((current) => (current ? { ...current, complete: true } : current));
    setSyncState("done");
    setShowLogin(false);
    const totalText = res.totalAvailable ? ` of about ${res.totalAvailable}` : "";
    const requestedText =
      res.requestedCount && res.requestedCount !== res.count
        ? ` / ${res.requestedCount} requested`
        : "";
    const capText =
      res.capBypassed && res.cappedAt
        ? ` Warmup recommendation was ${res.cappedAt}/run; manual import override used.`
        : res.effectiveLimit && res.effectiveLimit !== res.requestedCount
          ? ` Warmup cap limited this run to ${res.effectiveLimit}.`
          : "";
    const diagnosticText = res.diagnostic
      ? ` Reason: ${formatImportDiagnostic(res.diagnostic)}.`
      : "";
    setStatusMsg(
      `✓ Imported ${res.count}${requestedText}${totalText} leads. Background job complete.${capText}${diagnosticText}`,
    );
  }

  async function applyImportJob(job: any, cookiesToUse = currentCookies()) {
    if (job.status === "running") {
      enqueueLiveItems(job);
      setSyncState("syncing");
      setStatusMsg(
        `Importing ${job.importedCount || 0} of ${job.requestedCount || importOp.requestedCount || importLimit} connections in the background.`,
      );
      return;
    }

    if (job.status === "done" && job.result?.success) {
      enqueueLiveItems(job);
      if (pendingCompletionJobIdRef.current === job.id) return;
      if (revealQueueRef.current.length > 0) {
        pendingCompletionJobIdRef.current = job.id;
        pendingCompletionRef.current = () => completeImportJob(job, cookiesToUse);
        setStatusMsg("LinkedIn fetch complete. Finishing the live connection list...");
      } else {
        completeImportJob(job, cookiesToUse);
      }
      return;
    }

    const error = job.error || job.result?.error || "Import failed.";
    store.set((s) => ({
      ...s,
      ops: {
        ...s.ops,
        import: {
          ...s.ops.import,
          status: "failed",
          jobId: job.id,
          finishedAt: job.finishedAt || new Date().toISOString(),
          message: error,
        },
      },
    }));
    setSyncState("idle");
    setStatusMsg(`Import failed: ${error}`);
  }

  async function pollImportJob(jobId: string) {
    const res = await getImport({ data: { jobId } });
    if (res.success) await applyImportJob(res.job);
    else {
      store.set((s) => ({
        ...s,
        ops: {
          ...s.ops,
          import: {
            ...s.ops.import,
            status: "failed",
            finishedAt: new Date().toISOString(),
            message: res.error,
          },
        },
      }));
      setSyncState("idle");
      setStatusMsg(res.error);
    }
  }

  useEffect(() => {
    setCookieImportHostedDisabled(
      !["localhost", "127.0.0.1", "::1"].includes(window.location.hostname),
    );
  }, []);

  useEffect(() => {
    if (importOp.status !== "running" || !importOp.jobId) return;
    void pollImportJob(importOp.jobId);
    const id = window.setInterval(() => void pollImportJob(importOp.jobId!), 750);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importOp.status, importOp.jobId]);

  useEffect(
    () => () => {
      if (revealTimerRef.current !== null) window.clearInterval(revealTimerRef.current);
    },
    [],
  );

  async function loadInfo() {
    const c = currentCookies();
    if (!c.li_at) {
      alert("Enter your li_at cookie first so we can load this account's fingerprint.");
      return;
    }
    try {
      const res = (await fetchInfo({ data: { li_at: c.li_at } })) as SessionInfo;
      setInfo(res);
      if (res.proxy) {
        setProxyHost(res.proxy.host);
        setProxyPort(String(res.proxy.port));
      }
    } catch (e) {
      alert("Could not load session info: " + (e as Error).message);
    }
  }

  async function persistProxy() {
    const c = currentCookies();
    if (!c.li_at) {
      alert("Enter your li_at cookie first.");
      return;
    }
    const proxy =
      proxyHost &&
      proxyPort &&
      (proxyUser.trim() || proxyPass.trim() || info?.proxySource !== "auto")
        ? {
            host: proxyHost.trim(),
            port: parseInt(proxyPort, 10),
            username: proxyUser.trim() || undefined,
            password: proxyPass.trim() || undefined,
          }
        : null;
    try {
      await saveProxy({ data: { li_at: c.li_at, proxy } });
      await loadInfo();
      setStatusMsg(proxy ? "✓ Sticky proxy saved for this account." : "✓ Proxy cleared.");
    } catch (e) {
      alert("Failed to save proxy: " + (e as Error).message);
    }
  }

  async function checkProxy() {
    const c = currentCookies();
    if (!c.li_at) {
      alert("Enter your li_at cookie first.");
      return;
    }
    const proxy =
      proxyHost &&
      proxyPort &&
      (proxyUser.trim() || proxyPass.trim() || info?.proxySource !== "auto")
        ? {
            host: proxyHost.trim(),
            port: parseInt(proxyPort, 10),
            username: proxyUser.trim() || undefined,
            password: proxyPass.trim() || undefined,
          }
        : null;
    setProxyTest("testing");
    setProxyTestMsg("");
    try {
      const res = await runProxyTest({ data: { li_at: c.li_at, proxy } });
      if (res.success) {
        setProxyTest("ok");
        setProxyTestMsg(
          `${res.usedProxy ? "✓ Proxy OK" : "⚠ NO PROXY — this is your home IP"} · exit IP ${res.exitIp}` +
            `${res.country ? ` (${res.city ? res.city + ", " : ""}${res.country})` : ""} · ${res.latencyMs}ms`,
        );
      } else {
        setProxyTest("err");
        setProxyTestMsg(res.error);
      }
    } catch (e) {
      setProxyTest("err");
      setProxyTestMsg((e as Error).message);
    }
  }

  async function startRealSync(force = false) {
    if (cookieImportHostedDisabled) {
      setStatusMsg(
        "Cookie import is local-only on the hosted app because Vercel cannot run a persistent Chrome profile. Use Onboarding > Connect LinkedIn for live approved actions.",
      );
      return;
    }

    const cookiesToUse = currentCookies();
    if (!cookiesToUse.li_at || !cookiesToUse.JSESSIONID) {
      alert("Please enter both li_at and JSESSIONID cookies.");
      return;
    }

    const requestedCount = Math.max(1, Math.min(1000, Math.floor(importLimit || 25)));
    beginLiveImport(`starting_${Date.now()}`, requestedCount);
    setSyncState("syncing");
    setStatusMsg("Starting background import...");

    try {
      const res = await startImport({
        data: {
          cookies: cookiesToUse,
          searchUrl: searchUrl.trim() || undefined,
          limit: requestedCount,
          headless: !headful,
          force,
          bypassWarmupImportCap: true,
        },
      });

      if (!res.success) throw new Error(res.error || "Could not start import job.");

      beginLiveImport(res.job.id, requestedCount);
      store.set((s) => ({
        ...s,
        session: { ...s.session, connected: true, cookies: cookiesToUse },
        ops: {
          ...s.ops,
          import: {
            status: "running",
            jobId: res.job.id,
            startedAt: res.job.startedAt,
            requestedCount,
            message: res.reused
              ? "An import is already running. Reattached to it."
              : "Import running in background. You can switch tabs.",
          },
        },
      }));

      setStatusMsg(
        res.reused
          ? "Reattached to the running import job."
          : "Import started in background. You can switch tabs.",
      );
      void pollImportJob(res.job.id);
    } catch (e) {
      const message = (e as Error).message;
      setSyncState("idle");
      setStatusMsg(`Import could not start: ${message}`);
      store.set((s) => ({
        ...s,
        ops: {
          ...s.ops,
          import: {
            ...s.ops.import,
            status: "failed",
            finishedAt: new Date().toISOString(),
            message,
          },
        },
      }));
    }
  }
  const visibleConnections = useMemo(
    () => (syncState === "syncing" && liveImport ? liveImport.items : conns.items || []),
    [conns.items, liveImport, syncState],
  );
  const filtered = useMemo(() => {
    return visibleConnections.filter((c) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        c.name.toLowerCase().includes(q) ||
        c.headline.toLowerCase().includes(q) ||
        c.company.toLowerCase().includes(q) ||
        (c.tags || []).some((t) => t.includes(q))
      );
    });
  }, [visibleConnections, search]);

  return (
    <AppShell title="Connections">
      <div className="mx-auto max-w-5xl px-6 py-6 overflow-y-auto h-full">
        {(showLogin || session.connected) && (
          <Card className="mb-6 p-6 border-primary/20 bg-primary/5">
            <h2 className="text-lg font-semibold flex items-center gap-2 mb-4 text-foreground">
              <Key className="h-5 w-5 text-primary" />
              Import LinkedIn Connections
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {!session.connected && (
                <>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground ml-1">
                      li_at cookie
                    </label>
                    <Input
                      value={liAt}
                      onChange={(e) => setLiAt(e.target.value)}
                      placeholder="Paste li_at cookie…"
                      className="bg-background"
                      disabled={cookieImportHostedDisabled}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground ml-1">
                      JSESSIONID cookie
                    </label>
                    <Input
                      value={jSessionId}
                      onChange={(e) => setJSessionId(e.target.value)}
                      placeholder="Paste JSESSIONID cookie…"
                      className="bg-background"
                      disabled={cookieImportHostedDisabled}
                    />
                  </div>
                </>
              )}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground ml-1">
                  LinkedIn 1st-degree search URL
                </label>
                <Input
                  value={searchUrl}
                  onChange={(e) => setSearchUrl(e.target.value)}
                  placeholder={FIRST_DEGREE_SEARCH_URL}
                  className="bg-background"
                  disabled={cookieImportHostedDisabled}
                />
                <p className="text-[10px] text-muted-foreground ml-1">
                  Use the people search link with network=[&quot;F&quot;].
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground ml-1">
                  Import count
                </label>
                <Input
                  type="number"
                  min={1}
                  max={1000}
                  value={importLimit}
                  onChange={(e) => setImportLimit(Number(e.target.value) || 25)}
                  className="bg-background"
                  disabled={cookieImportHostedDisabled}
                />
                <p className="text-[10px] text-muted-foreground ml-1">
                  Ask for 1-1000; manual imports use this count while still reporting the warmup
                  recommendation.
                </p>
              </div>
            </div>

            {cookieImportHostedDisabled && (
              <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-100">
                {
                  "Hosted demo path: connect LinkedIn through Unipile from onboarding. Cookie import launches a local Chrome browser, so it is available only on localhost."
                }
              </div>
            )}

            <div className="mt-4 flex items-center justify-between gap-4">
              <p className="text-[10px] text-muted-foreground max-w-md">
                {cookieImportHostedDisabled
                  ? "For hosted production, use Unipile for live approved actions. Cookie/browser import remains available locally."
                  : "Find these in Chrome DevTools: Application -> Cookies -> linkedin.com. We drive a real, fingerprint-stable browser through your account's sticky proxy - no raw API calls."}
              </p>
              <div className="flex shrink-0 items-center gap-2">
                {cookieImportHostedDisabled && (
                  <Button asChild variant="secondary">
                    <a href="/onboarding">Connect LinkedIn</a>
                  </Button>
                )}
                <Button
                  onClick={() => startRealSync(false)}
                  disabled={syncState === "syncing" || cookieImportHostedDisabled}
                  title={
                    cookieImportHostedDisabled
                      ? "Cookie import is local-only. Use onboarding for hosted live action execution."
                      : undefined
                  }
                >
                  {syncState === "syncing" ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" /> Syncing
                    </>
                  ) : cookieImportHostedDisabled ? (
                    "Disabled on Vercel"
                  ) : session.connected ? (
                    "Import Connections"
                  ) : (
                    "Connect & Import"
                  )}
                </Button>
              </div>
            </div>
          </Card>
        )}

        {/* Stealth & Safety panel */}
        <Card className="mb-6 border-muted">
          <button
            onClick={() => {
              setShowStealth((v) => !v);
              if (!info) void loadInfo();
            }}
            className="w-full flex items-center justify-between p-4 text-left"
          >
            <span className="flex items-center gap-2 font-medium text-foreground">
              <ShieldCheck className="h-4 w-4 text-emerald-500" /> Stealth &amp; Safety
            </span>
            {showStealth ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>

          {showStealth && (
            <div className="px-4 pb-4 space-y-4 border-t border-muted pt-4">
              {info && (
                <div className="grid gap-3 sm:grid-cols-3 text-xs">
                  <div className="rounded-lg bg-muted/40 p-3">
                    <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
                      <Fingerprint className="h-3.5 w-3.5" /> Stable fingerprint
                    </div>
                    <div className="text-foreground font-mono text-[10px] break-all">
                      {info.fingerprint.timezoneId} · {info.fingerprint.locale}
                    </div>
                    <div className="text-muted-foreground text-[10px] mt-1 truncate">
                      {info.fingerprint.userAgent.split(") ")[0]})
                    </div>
                  </div>
                  <div className="rounded-lg bg-muted/40 p-3">
                    <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
                      <Globe className="h-3.5 w-3.5" /> Sticky proxy
                    </div>
                    <div className="text-foreground">
                      {info.proxy ? (
                        `${info.proxy.host}:${info.proxy.port}`
                      ) : (
                        <span className="text-amber-500">none (uses host IP — risky)</span>
                      )}
                    </div>
                    {info.proxySource && (
                      <div className="text-muted-foreground text-[10px] mt-1">
                        {info.proxySource === "auto" ? "auto provider" : "manual override"}
                      </div>
                    )}
                  </div>
                  <div className="rounded-lg bg-muted/40 p-3">
                    <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
                      <ShieldCheck className="h-3.5 w-3.5" /> Warmup &amp; caps
                    </div>
                    <div className="text-foreground">
                      Day {info.warmupDay}/14 · suggested cap {info.dailyImportCap}/run
                    </div>
                    <div
                      className={
                        info.withinActiveHours
                          ? "text-emerald-500 text-[10px] mt-1"
                          : "text-amber-500 text-[10px] mt-1"
                      }
                    >
                      {info.withinActiveHours ? "within active hours" : "outside active hours"}
                    </div>
                  </div>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-4">
                <div className="space-y-1.5 sm:col-span-2">
                  <label className="text-[10px] text-muted-foreground ml-1">
                    Proxy host (residential, sticky)
                  </label>
                  <Input
                    value={proxyHost}
                    onChange={(e) => setProxyHost(e.target.value)}
                    placeholder="brd.superproxy.io"
                    className="bg-background h-9"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] text-muted-foreground ml-1">Port</label>
                  <Input
                    value={proxyPort}
                    onChange={(e) => setProxyPort(e.target.value)}
                    placeholder="22225"
                    className="bg-background h-9"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] text-muted-foreground ml-1">Username</label>
                  <Input
                    value={proxyUser}
                    onChange={(e) => setProxyUser(e.target.value)}
                    placeholder="optional"
                    className="bg-background h-9"
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <label className="text-[10px] text-muted-foreground ml-1">Password</label>
                  <Input
                    type="password"
                    value={proxyPass}
                    onChange={(e) => setProxyPass(e.target.value)}
                    placeholder="optional"
                    className="bg-background h-9"
                  />
                </div>
                <div className="flex items-end gap-2 sm:col-span-2">
                  <Button size="sm" variant="outline" onClick={persistProxy}>
                    Save proxy
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={checkProxy}
                    disabled={proxyTest === "testing"}
                  >
                    {proxyTest === "testing" ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> Testing
                      </>
                    ) : (
                      "Test proxy"
                    )}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={loadInfo}>
                    Refresh
                  </Button>
                  <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground ml-auto">
                    <input
                      type="checkbox"
                      checked={headful}
                      onChange={(e) => setHeadful(e.target.checked)}
                    />
                    Show browser
                  </label>
                </div>
                {proxyTestMsg && (
                  <div
                    className={`sm:col-span-2 rounded-md px-3 py-2 text-[11px] font-mono ${
                      proxyTest === "ok"
                        ? proxyTestMsg.startsWith("✓")
                          ? "bg-emerald-500/10 text-emerald-500"
                          : "bg-amber-500/10 text-amber-500"
                        : "bg-red-500/10 text-red-400"
                    }`}
                  >
                    {proxyTestMsg}
                  </div>
                )}
              </div>

              <p className="text-[10px] text-muted-foreground">
                Each account keeps a fixed fingerprint + a single sticky residential IP across every
                run — the core anti-ban trick. The app shows a warmup recommendation and keeps
                imports inside active hours.
              </p>
            </div>
          )}
        </Card>

        {statusMsg && (
          <div className="mb-4 rounded-lg border border-muted bg-muted/30 px-4 py-2 text-xs text-foreground">
            {statusMsg}
          </div>
        )}

        {liveImport && (syncState === "syncing" || liveImport.complete) && (
          <div className="mb-5 border-y border-muted bg-muted/20 px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {liveImport.complete ? (
                    <ShieldCheck className="h-4 w-4 text-emerald-500" />
                  ) : (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  )}
                  <span>{liveImport.complete ? "Import complete" : "Importing connections"}</span>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {liveImport.latest
                    ? `Added ${liveImport.latest.name}`
                    : "Opening LinkedIn and preparing the first page..."}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-sm font-semibold tabular-nums text-foreground">
                  {liveImport.items.length} / {liveImport.requestedCount}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {liveImport.source
                    ? `${liveImport.source} · ${liveImport.pagesVisited} page${liveImport.pagesVisited === 1 ? "" : "s"}`
                    : "starting"}
                </div>
              </div>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden bg-muted">
              <div
                className="h-full bg-primary transition-[width] duration-200 ease-out"
                style={{
                  width: `${Math.min(
                    100,
                    (liveImport.items.length / Math.max(1, liveImport.requestedCount)) * 100,
                  )}%`,
                }}
              />
            </div>
          </div>
        )}

        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2 text-foreground">
              <Users className="h-5 w-5 text-primary" /> Your connections
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {visibleConnections.length} leads imported
              {info
                ? ` · warmup day ${info.warmupDay}/14 · suggested cap ${info.dailyImportCap}/run`
                : ""}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={() => startRealSync(false)}
              disabled={syncState === "syncing" || !session.connected}
              variant="outline"
              size="sm"
              className="gap-2"
            >
              <RefreshCw className={`h-4 w-4 ${syncState === "syncing" ? "animate-spin" : ""}`} />
              {syncState === "syncing" ? "Syncing…" : "Sync LinkedIn"}
            </Button>
          </div>
        </div>

        <div className="mb-4 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, company, role, or tag…"
            className="pl-9 h-11"
          />
        </div>

        <Card className="overflow-hidden border-muted">
          <div className="max-h-[55vh] overflow-auto scrollbar-thin scrollbar-thumb-muted-foreground/20">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm text-xs text-muted-foreground z-10">
                <tr>
                  <th className="p-3 text-left font-medium">Name</th>
                  <th className="p-3 text-left font-medium hidden md:table-cell">Headline</th>
                  <th className="p-3 text-left font-medium">Company</th>
                  <th className="p-3 text-left font-medium hidden lg:table-cell">Location</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-muted/50 text-foreground">
                {filtered.map((c: any) => (
                  <tr key={c.id} className="hover:bg-muted/30 transition-colors">
                    <td className="p-3 font-medium">
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-[11px] font-bold text-primary shrink-0">
                          {c.name?.charAt(0) || "?"}
                        </div>
                        {c.profileUrl ? (
                          <a
                            href={c.profileUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:text-primary hover:underline transition-colors"
                          >
                            {c.name}
                          </a>
                        ) : (
                          <span>{c.name}</span>
                        )}
                      </div>
                    </td>
                    <td className="p-3 text-muted-foreground hidden md:table-cell max-w-[260px] truncate">
                      {c.headline}
                    </td>
                    <td className="p-3">{c.company}</td>
                    <td className="p-3 text-muted-foreground text-xs hidden lg:table-cell">
                      {c.location}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 && (
            <div className="p-20 flex flex-col items-center justify-center gap-3 text-muted-foreground">
              <AlertCircle className="h-8 w-8 opacity-20" />
              <p className="text-sm">
                No connections found. Sync your account to start lead search.
              </p>
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
