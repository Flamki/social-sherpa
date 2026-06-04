import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Download, CheckCircle2, AlertTriangle } from "lucide-react";

import { Nav } from "@/components/app/Nav";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { store, useStore } from "@/lib/store";

export const Route = createFileRoute("/extension")({
  head: () => ({
    meta: [
      { title: "Connect LinkedIn — Network Manager" },
      { name: "description", content: "Install the Network Manager Chrome extension to link your LinkedIn session." },
    ],
  }),
  component: ExtensionPage,
});

function ExtensionPage() {
  const session = useStore((s) => s.session);
  const [polling, setPolling] = useState(false);

  useEffect(() => {
    if (!polling) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch("/api/public/link-session?check=1");
        const j = await r.json();
        if (j.linked && j.last?.hasLiAt) {
          store.set((s) => ({
            ...s,
            session: { connected: true, capturedAt: j.last.capturedAt, userAgent: j.last.userAgent },
          }));
          setPolling(false);
        }
      } catch { /* noop */ }
    }, 2000);
    return () => clearInterval(t);
  }, [polling]);

  function download() {
    fetch("/network-manager-extension.zip")
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); })
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "network-manager-extension.zip";
        a.click();
        URL.revokeObjectURL(a.href);
        setPolling(true);
      })
      .catch((e) => alert(e.message));
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Nav />
      <main className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-semibold">Connect your LinkedIn session</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The extension reads your LinkedIn cookies and posts them to your workspace.
          We never log in for you — we use your existing session.
        </p>

        <Card className="mt-6 p-5">
          {session.connected ? (
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" />
              <div>
                <p className="text-sm font-medium">Session linked</p>
                <p className="text-xs text-muted-foreground">
                  Captured {session.capturedAt ? new Date(session.capturedAt).toLocaleString() : "just now"}
                </p>
              </div>
            </div>
          ) : (
            <ol className="list-decimal space-y-3 pl-5 text-sm">
              <li>
                <Button onClick={download} size="sm" className="ml-1 inline-flex">
                  <Download className="mr-2 h-3.5 w-3.5" /> Download extension (.zip)
                </Button>
              </li>
              <li>Unzip it.</li>
              <li>
                Open <code className="rounded bg-muted px-1">chrome://extensions</code>, enable
                <strong> Developer mode</strong>, click <strong>Load unpacked</strong>, and pick the unzipped folder.
              </li>
              <li>Open LinkedIn in another tab and make sure you are logged in.</li>
              <li>
                Click the extension icon, paste this URL: <code className="rounded bg-muted px-1">{typeof window !== "undefined" ? window.location.origin : ""}</code>,
                then click <strong>Capture &amp; link session</strong>.
              </li>
              <li>{polling ? "Waiting for capture…" : "This page will switch to linked automatically."}</li>
            </ol>
          )}
        </Card>

        <Card className="mt-4 border-amber-300/40 bg-amber-50/40 p-4 text-xs dark:bg-amber-950/20">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600" />
            <p>
              LinkedIn's Terms of Service prohibit automation. Linking your session and using this tool
              may result in account restrictions or a permanent ban. Start with low daily limits and the
              built-in 14-day warmup. Every action is queued for your approval before sending.
            </p>
          </div>
        </Card>
      </main>
    </div>
  );
}