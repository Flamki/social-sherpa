import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Telescope, Loader2, UserPlus, Check, AlertCircle, Building2 } from "lucide-react";

import { AppShell } from "@/components/app/AppShell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { store, useStore } from "@/lib/store";
import { discoverProspects, type Prospect } from "@/lib/linkedin.discover";
import { enqueueAction, runActionNow } from "@/lib/action.queue";

export const Route = createFileRoute("/prospects")({
  head: () => ({
    meta: [
      { title: "Find Prospects — Network Manager" },
      { name: "description", content: "Discover new LinkedIn leads outside your network." },
    ],
  }),
  component: ProspectsPage,
});

function ProspectsPage() {
  const session = useStore((s) => s.session);
  // Results live in the global store so they survive navigating away and back.
  const discover = useStore((s) => s.discover);
  const find = useServerFn(discoverProspects);
  const enqueue = useServerFn(enqueueAction);
  const runNow = useServerFn(runActionNow);

  const [query, setQuery] = useState(discover.query);
  const [limit, setLimit] = useState(10);
  const [state, setState] = useState<"idle" | "searching">("idle");
  const [error, setError] = useState("");
  const prospects = discover.items;
  const queued = discover.queued;

  const connected = session.connected && session.cookies?.li_at;

  async function runSearch() {
    if (!query.trim() || state === "searching") return;
    if (!connected) {
      setError("Connect LinkedIn first (Connections page) so we can search on your behalf.");
      return;
    }
    setState("searching");
    setError("");
    store.set((s) => ({ ...s, discover: { query: query.trim(), items: [], queued: {} } }));
    try {
      const res = await find({
        data: { cookies: session.cookies!, query: query.trim(), limit },
      });
      if (res.success) {
        store.set((s) => ({
          ...s,
          discover: { query: query.trim(), items: res.prospects, queued: {} },
        }));
        if (!res.prospects.length) setError("No people matched. Try broader keywords.");
      } else {
        setError(res.error || "Search failed.");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setState("idle");
    }
  }

  function setStatus(publicId: string, status: "sending" | "sent" | "failed") {
    store.set((s) => ({
      ...s,
      discover: { ...s.discover, queued: { ...s.discover.queued, [publicId]: status } },
    }));
  }

  // Send a plain connection request (no note, no message) immediately — no approval step.
  async function requestConnection(p: Prospect) {
    setStatus(p.publicId, "sending");
    try {
      const enq = await enqueue({
        data: {
          type: "connection_request",
          targetName: p.name,
          targetUrl: p.profileUrl,
          reasoning: `Prospect discovered via search "${query.trim()}".`,
        },
      });
      if (!enq.success || !enq.action) {
        setStatus(p.publicId, "failed");
        return;
      }
      const res = await runNow({
        data: { id: enq.action.id, cookies: session.cookies, headless: false },
      });
      setStatus(p.publicId, res.status === "sent" ? "sent" : "failed");
      if (res.status !== "sent")
        setError(`Couldn't connect to ${p.name}: ${res.error || "unknown error"}`);
    } catch (e) {
      setStatus(p.publicId, "failed");
      setError(`Couldn't connect to ${p.name}: ${(e as Error).message}`);
    }
  }

  return (
    <AppShell title="Find Prospects">
      <div className="mx-auto h-full w-full max-w-4xl overflow-y-auto px-6 py-6">
        <Card className="mb-6 border-primary/20 bg-primary/5 p-6">
          <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold text-foreground">
            <Telescope className="h-5 w-5 text-primary" /> Discover new leads
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Search LinkedIn for people <strong>outside your network</strong> by role, skill, or
            industry — then send connection requests with one click.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <label className="ml-1 text-xs font-medium text-muted-foreground">
                Who are you looking for?
              </label>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runSearch()}
                placeholder='e.g. "supply chain manager fintech" or "growth marketer startup"'
                className="bg-background"
                disabled={state === "searching"}
              />
            </div>
            <div className="w-24 space-y-1.5">
              <label className="ml-1 text-xs font-medium text-muted-foreground">Count</label>
              <Input
                type="number"
                min={1}
                max={50}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value) || 10)}
                className="bg-background"
                disabled={state === "searching"}
              />
            </div>
            <Button onClick={runSearch} disabled={state === "searching" || !query.trim()}>
              {state === "searching" ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Searching…
                </>
              ) : (
                <>
                  <Telescope className="mr-2 h-4 w-4" /> Find prospects
                </>
              )}
            </Button>
          </div>
          {!connected && (
            <p className="mt-3 text-xs text-amber-500">
              Not connected to LinkedIn —{" "}
              <Link to="/connections" className="underline">
                connect on the Connections page
              </Link>{" "}
              first.
            </p>
          )}
          {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
        </Card>

        {prospects.length > 0 && (
          <div className="space-y-2">
            <p className="ml-1 text-xs uppercase tracking-wide text-muted-foreground">
              {prospects.length} prospect{prospects.length === 1 ? "" : "s"} found — click Connect
              to send a connection request
            </p>
            {prospects.map((p) => (
              <Card key={p.publicId} className="flex items-center justify-between gap-4 p-3">
                <div className="flex min-w-0 items-center gap-3">
                  {p.picture ? (
                    <img
                      src={p.picture}
                      alt={p.name}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      className="h-9 w-9 shrink-0 rounded-full bg-primary/10 object-cover"
                    />
                  ) : (
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">
                      {p.name?.charAt(0) || "?"}
                    </div>
                  )}
                  <div className="min-w-0">
                    <a
                      href={p.profileUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-sm font-medium hover:text-primary hover:underline"
                    >
                      {p.name}
                    </a>
                    <p className="truncate text-xs text-muted-foreground">
                      {p.headline || "—"}
                      {p.company && (
                        <span className="ml-1 inline-flex items-center gap-0.5">
                          <Building2 className="h-3 w-3" /> {p.company}
                        </span>
                      )}
                    </p>
                    {p.location && (
                      <p className="truncate text-[11px] text-muted-foreground/70">{p.location}</p>
                    )}
                  </div>
                </div>
                {queued[p.publicId] === "sending" ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Sending…
                  </span>
                ) : queued[p.publicId] === "sent" ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-600">
                    <Check className="h-4 w-4" /> Request sent
                  </span>
                ) : queued[p.publicId] === "failed" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 gap-1.5 text-red-500"
                    onClick={() => requestConnection(p)}
                  >
                    <UserPlus className="h-4 w-4" /> Failed — retry
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 gap-1.5"
                    onClick={() => requestConnection(p)}
                  >
                    <UserPlus className="h-4 w-4" /> Connect
                  </Button>
                )}
              </Card>
            ))}
            <p className="ml-1 mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <AlertCircle className="h-3.5 w-3.5" /> Connect sends a plain LinkedIn connection
              request (no message) right away. Track them in the{" "}
              <Link to="/requests" className="underline">
                Requests
              </Link>{" "}
              tab.
            </p>
          </div>
        )}
      </div>
    </AppShell>
  );
}
