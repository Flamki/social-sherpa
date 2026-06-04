import { createFileRoute } from "@tanstack/react-router";
import { useRef } from "react";
import { Upload, RotateCcw } from "lucide-react";

import { AppShell } from "@/components/app/AppShell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MOCK_CONNECTIONS } from "@/lib/mockConnections";
import { parseLinkedInCsv } from "@/lib/csv";
import { store, useStore } from "@/lib/store";

export const Route = createFileRoute("/connections")({
  head: () => ({
    meta: [
      { title: "Connections — Network Manager" },
      { name: "description", content: "Upload your LinkedIn Connections export and search your real network." },
    ],
  }),
  component: ConnectionsPage,
});

function ConnectionsPage() {
  const conns = useStore((s) => s.connections);
  const fileRef = useRef<HTMLInputElement>(null);

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

  return (
    <AppShell title="Connections">
      <div className="mx-auto max-w-5xl px-6 py-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Your connections</h1>
            <p className="text-sm text-muted-foreground">
              {conns.source === "csv"
                ? `${conns.items.length} connections from CSV (uploaded ${conns.uploadedAt ? new Date(conns.uploadedAt).toLocaleString() : ""})`
                : `${conns.items.length} mock connections — upload your real export to replace`}
            </p>
          </div>
          <div className="flex gap-2">
            <input ref={fileRef} type="file" accept=".csv" hidden onChange={onFile} />
            <Button onClick={() => fileRef.current?.click()}>
              <Upload className="mr-1 h-4 w-4" /> Upload Connections.csv
            </Button>
            {conns.source === "csv" && (
              <Button variant="outline" onClick={reset}>
                <RotateCcw className="mr-1 h-4 w-4" /> Back to mock
              </Button>
            )}
          </div>
        </div>

        <Card className="overflow-hidden">
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                <tr>
                  <th className="p-2 text-left">Name</th>
                  <th className="p-2 text-left">Headline</th>
                  <th className="p-2 text-left">Company</th>
                  <th className="p-2 text-left">Tags</th>
                </tr>
              </thead>
              <tbody>
                {conns.items.slice(0, 500).map((c) => (
                  <tr key={c.id} className="border-t">
                    <td className="p-2 font-medium">{c.name}</td>
                    <td className="p-2 text-muted-foreground">{c.headline}</td>
                    <td className="p-2">{c.company}</td>
                    <td className="p-2">
                      <div className="flex flex-wrap gap-1">
                        {c.tags.slice(0, 4).map((t) => (
                          <Badge key={t} variant="outline" className="text-[10px]">{t}</Badge>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {conns.items.length > 500 && (
            <p className="border-t p-2 text-center text-xs text-muted-foreground">
              Showing first 500 of {conns.items.length}
            </p>
          )}
        </Card>

        <p className="mt-4 text-xs text-muted-foreground">
          How to export: LinkedIn → Settings → Data privacy → Get a copy of your data → Connections only.
        </p>
      </div>
    </AppShell>
  );
}