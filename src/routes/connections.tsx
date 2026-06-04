import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Upload, RotateCcw, Search, RefreshCw, Users, CheckCircle2, Loader2 } from "lucide-react";

import { AppShell } from "@/components/app/AppShell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { MOCK_CONNECTIONS } from "@/lib/mockConnections";
import { parseLinkedInCsv } from "@/lib/csv";
import { store, useStore } from "@/lib/store";

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

function ConnectionsPage() {
  const conns = useStore((s) => s.connections);
  const session = useStore((s) => s.session);
  const fileRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [syncState, setSyncState] = useState<SyncState>("idle");
  const [syncProgress, setSyncProgress] = useState(0);
  const [syncTotal] = useState(847); // realistic demo number

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const items = parseLinkedInCsv(text);
    if (!items.length) {
      alert("Could not parse this file. Make sure it's the LinkedIn Connections.csv export.");
      return;
    }
    store.set((s) => ({ ...s, connections: { source: "csv", uploadedAt: new Date().toISOString(), items } }));
  }

  function reset() {
    store.set((s) => ({ ...s, connections: { source: "mock", items: MOCK_CONNECTIONS } }));
  }

  async function simulateSync() {
    if (!session.connected) return;
    setSyncState("syncing");
    setSyncProgress(0);

    // Simulate LinkedIn sync with realistic pacing (1000/day limit shown)
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
      await new Promise((r) => setTimeout(r, 120));
      setSyncProgress(Math.round((i / steps) * syncTotal));
    }

    // Mark synced in store
    store.set((s) => ({
      ...s,
      connections: { source: "mock", uploadedAt: new Date().toISOString(), items: MOCK_CONNECTIONS },
    }));
    setSyncState("done");
  }

  const filtered = conns.items.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      c.headline.toLowerCase().includes(q) ||
      c.company.toLowerCase().includes(q) ||
      c.tags.some((t) => t.includes(q))
    );
  });

  return (
    <AppShell title="Connections">
      <div className="mx-auto max-w-5xl px-6 py-6">

        {/* Header row */}
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              Your connections
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {conns.source === "csv"
                ? `${conns.items.length} connections from CSV (uploaded ${conns.uploadedAt ? new Date(conns.uploadedAt).toLocaleString() : ""})`
                : `${conns.items.length} connections synced · Daily limit: 1,000 syncs`}
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {session.connected ? (
              <Button
                onClick={simulateSync}
                disabled={syncState === "syncing"}
                className="gap-2"
              >
                {syncState === "syncing" ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Syncing… {syncProgress}/{syncTotal}</>
                ) : syncState === "done" ? (
                  <><CheckCircle2 className="h-4 w-4 text-emerald-500" /> Synced</>
                ) : (
                  <><RefreshCw className="h-4 w-4" /> Sync LinkedIn</>
                )}
              </Button>
            ) : null}
            <input ref={fileRef} type="file" accept=".csv" hidden onChange={onFile} />
            <Button variant="outline" onClick={() => fileRef.current?.click()}>
              <Upload className="mr-1.5 h-4 w-4" /> Import CSV
            </Button>
            {conns.source === "csv" && (
              <Button variant="ghost" onClick={reset}>
                <RotateCcw className="mr-1.5 h-4 w-4" /> Reset
              </Button>
            )}
          </div>
        </div>

        {/* Sync progress bar */}
        {syncState === "syncing" && (
          <div className="mb-4">
            <div className="mb-1 flex justify-between text-xs text-muted-foreground">
              <span>Pulling connections from LinkedIn…</span>
              <span>{syncProgress} / {syncTotal}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all duration-150"
                style={{ width: `${Math.round((syncProgress / syncTotal) * 100)}%` }}
              />
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">Daily sync limit: 1,000 connections</p>
          </div>
        )}

        {/* Search */}
        <div className="mb-4 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, company, role, or tag…"
            className="pl-9"
          />
        </div>

        {/* Table */}
        <Card className="overflow-hidden">
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                <tr>
                  <th className="p-3 text-left">Name</th>
                  <th className="p-3 text-left hidden md:table-cell">Headline</th>
                  <th className="p-3 text-left">Company</th>
                  <th className="p-3 text-left hidden sm:table-cell">Tags</th>
                  <th className="p-3 text-left hidden lg:table-cell">Location</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 500).map((c) => (
                  <tr key={c.id} className="border-t hover:bg-muted/30 transition-colors">
                    <td className="p-3 font-medium">
                      <div className="flex items-center gap-2">
                        <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center text-[11px] font-bold text-primary shrink-0">
                          {c.name.charAt(0)}
                        </div>
                        {c.name}
                      </div>
                    </td>
                    <td className="p-3 text-muted-foreground hidden md:table-cell max-w-[200px] truncate">{c.headline}</td>
                    <td className="p-3">{c.company}</td>
                    <td className="p-3 hidden sm:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {c.tags.slice(0, 3).map((t) => (
                          <Badge key={t} variant="outline" className="text-[10px] py-0">{t}</Badge>
                        ))}
                      </div>
                    </td>
                    <td className="p-3 text-muted-foreground text-xs hidden lg:table-cell">{c.location}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 && (
            <div className="p-12 text-center text-sm text-muted-foreground">No connections match "{search}"</div>
          )}
          {filtered.length > 500 && (
            <p className="border-t p-2 text-center text-xs text-muted-foreground">
              Showing first 500 of {filtered.length}
            </p>
          )}
        </Card>

        <p className="mt-3 text-xs text-muted-foreground">
          To export from LinkedIn: Settings → Data privacy → Get a copy of your data → Connections only.
        </p>
      </div>
    </AppShell>
  );
}
