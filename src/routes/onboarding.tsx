import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowRight, ShieldAlert, CheckCircle2 } from "lucide-react";

import { AppShell } from "@/components/app/AppShell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { store, useStore, effectiveCaps } from "@/lib/store";

export const Route = createFileRoute("/onboarding")({
  head: () => ({
    meta: [
      { title: "Onboarding — Network Manager" },
      { name: "description", content: "Connect LinkedIn, set daily caps, and start a 14-day account warmup." },
    ],
  }),
  component: Onboarding,
});

function Onboarding() {
  const nav = useNavigate();
  const session = useStore((s) => s.session);
  const caps = useStore((s) => s.caps);
  const warmup = useStore((s) => s.warmup);
  const [step, setStep] = useState(session.connected ? 1 : 0);
  const [acked, setAcked] = useState(false);

  return (
    <AppShell title="Onboarding">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-6 flex items-center gap-2 text-xs text-muted-foreground">
          {["Connect", "Daily caps", "Warmup schedule", "Risk ack"].map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <span className={`flex h-5 w-5 items-center justify-center rounded-full border ${i <= step ? "border-primary bg-primary text-primary-foreground" : ""}`}>
                {i < step ? <CheckCircle2 className="h-3 w-3" /> : i + 1}
              </span>
              <span className={i === step ? "font-medium text-foreground" : ""}>{label}</span>
              {i < 3 && <span className="text-muted-foreground">›</span>}
            </div>
          ))}
        </div>

        {step === 0 && (
          <Card className="p-6">
            <h2 className="text-lg font-semibold">Connect your LinkedIn session</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Install the Chrome extension and link your account. No password is ever sent.
            </p>
            <Button className="mt-4" onClick={() => nav({ to: "/extension" })}>
              Open install instructions <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
            {session.connected && (
              <Button variant="outline" className="ml-2 mt-4" onClick={() => setStep(1)}>
                Already linked → continue
              </Button>
            )}
          </Card>
        )}

        {step === 1 && (
          <Card className="p-6">
            <h2 className="text-lg font-semibold">Set your daily ceiling</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              These are your maximum daily volumes <em>after</em> warmup. Warmup will ramp linearly to these over 14 days.
              Recommended: start low and raise after 30 days clean.
            </p>
            <div className="mt-4 grid grid-cols-3 gap-4">
              {(["invitesPerDay", "messagesPerDay", "profileViewsPerDay"] as const).map((k) => (
                <div key={k}>
                  <Label className="text-xs">{k.replace("PerDay", "")}/day</Label>
                  <Input
                    type="number" min={1} max={100}
                    value={caps[k]}
                    onChange={(e) =>
                      store.set((s) => ({ ...s, caps: { ...s.caps, [k]: Math.max(1, Math.min(100, Number(e.target.value) || 1)) } }))
                    }
                  />
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-amber-600">
              Industry "safe" rule: ≤20 invites/day, ≤30 DMs/day, ≤50 profile views/day on a warmed account.
            </p>
            <div className="mt-5 flex gap-2">
              <Button variant="outline" onClick={() => setStep(0)}>Back</Button>
              <Button onClick={() => setStep(2)}>Continue <ArrowRight className="ml-1 h-4 w-4" /></Button>
            </div>
          </Card>
        )}

        {step === 2 && (
          <Card className="p-6">
            <h2 className="text-lg font-semibold">14-day warmup schedule</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              The first days are profile views only. Invites and messages ramp linearly to your ceiling by day 14.
            </p>
            <div className="mt-4 max-h-64 overflow-auto rounded border">
              <table className="w-full text-xs">
                <thead className="bg-muted text-muted-foreground">
                  <tr><th className="p-2 text-left">Day</th><th className="p-2">Views</th><th className="p-2">Invites</th><th className="p-2">Messages</th></tr>
                </thead>
                <tbody>
                  {Array.from({ length: 14 }, (_, i) => {
                    const d = i + 1;
                    const eff = effectiveCaps({ ...store.get(), warmup: { startedAt: new Date(Date.now() - i * 86400000).toISOString() } });
                    return (
                      <tr key={d} className="border-t">
                        <td className="p-2 font-medium">Day {d}</td>
                        <td className="p-2 text-center">{eff.profileViewsPerDay}</td>
                        <td className="p-2 text-center">{eff.invitesPerDay}</td>
                        <td className="p-2 text-center">{eff.messagesPerDay}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {warmup.startedAt ? (
              <p className="mt-3 text-xs text-emerald-600">Warmup started {new Date(warmup.startedAt).toLocaleDateString()}.</p>
            ) : null}
            <div className="mt-5 flex gap-2">
              <Button variant="outline" onClick={() => setStep(1)}>Back</Button>
              <Button onClick={() => {
                if (!warmup.startedAt) store.set((s) => ({ ...s, warmup: { startedAt: new Date().toISOString() } }));
                setStep(3);
              }}>
                Start warmup <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          </Card>
        )}

        {step === 3 && (
          <Card className="p-6">
            <h2 className="flex items-center gap-2 text-lg font-semibold"><ShieldAlert className="h-5 w-5 text-amber-600" /> Risk acknowledgment</h2>
            <ul className="mt-3 space-y-2 text-sm">
              <li>· LinkedIn ToS prohibits all third-party automation, including this app.</li>
              <li>· Accounts may be temporarily restricted or permanently banned without notice.</li>
              <li>· Every action is queued for your explicit approval — nothing is automatic.</li>
              <li>· You are responsible for the content of every message sent on your behalf.</li>
            </ul>
            <label className="mt-4 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} />
              I understand and accept the risk.
            </label>
            <div className="mt-5 flex gap-2">
              <Button variant="outline" onClick={() => setStep(2)}>Back</Button>
              <Button disabled={!acked} onClick={() => {
                store.set((s) => ({ ...s, onboarded: true }));
                nav({ to: "/" });
              }}>
                Finish onboarding
              </Button>
            </div>
          </Card>
        )}
      </div>
    </AppShell>
  );
}