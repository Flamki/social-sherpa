import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { ArrowRight, ShieldAlert, CheckCircle2, ExternalLink, RefreshCw } from "lucide-react";

import { AppShell } from "@/components/app/AppShell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { store, useStore, effectiveCaps } from "@/lib/store";
import {
  createUnipileHostedAuthLink,
  getUnipileProviderStatus,
  listUnipileAccounts,
  saveUnipileProviderConfig,
  saveUnipileAccount,
  type UnipileAccount,
} from "@/lib/unipile";

export const Route = createFileRoute("/onboarding")({
  head: () => ({
    meta: [
      { title: "Onboarding - Network Manager" },
      {
        name: "description",
        content: "Connect LinkedIn, set daily caps, and start a 14-day account warmup.",
      },
    ],
  }),
  component: Onboarding,
});

function Onboarding() {
  const nav = useNavigate();
  const createAuthLink = useServerFn(createUnipileHostedAuthLink);
  const fetchProviderStatus = useServerFn(getUnipileProviderStatus);
  const persistProviderConfig = useServerFn(saveUnipileProviderConfig);
  const fetchUnipileAccounts = useServerFn(listUnipileAccounts);
  const persistUnipileAccount = useServerFn(saveUnipileAccount);
  const session = useStore((s) => s.session);
  const caps = useStore((s) => s.caps);
  const warmup = useStore((s) => s.warmup);
  const [step, setStep] = useState(session.connected ? 1 : 0);
  const [acked, setAcked] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [refreshingAccounts, setRefreshingAccounts] = useState(false);
  const [unipileAccounts, setUnipileAccounts] = useState<UnipileAccount[]>([]);
  const [activeUnipileAccount, setActiveUnipileAccount] = useState("");
  const [connectNote, setConnectNote] = useState("");
  const [providerConfigured, setProviderConfigured] = useState(false);
  const [providerDsn, setProviderDsn] = useState("https://api49.unipile.com:17972");
  const [providerApiKey, setProviderApiKey] = useState("");
  const [savingProvider, setSavingProvider] = useState(false);

  useEffect(() => {
    fetchProviderStatus({})
      .then((res) => {
        setProviderConfigured(res.configured);
        if (res.dsn) setProviderDsn(res.dsn);
      })
      .catch(() => {
        setProviderConfigured(false);
      });
  }, [fetchProviderStatus]);

  async function saveProviderConfig() {
    setSavingProvider(true);
    setConnectNote("");
    try {
      const res = await persistProviderConfig({
        data: { dsn: providerDsn, apiKey: providerApiKey },
      });
      if (!res.success) {
        setConnectNote("Could not save Unipile provider config.");
        return;
      }
      setProviderConfigured(true);
      setProviderApiKey("");
      setConnectNote("Unipile provider saved. Now connect LinkedIn.");
    } catch (e) {
      setConnectNote((e as Error).message);
    } finally {
      setSavingProvider(false);
    }
  }

  async function connectWithUnipile() {
    setConnecting(true);
    setConnectNote("");
    try {
      if (!providerConfigured) {
        setConnectNote("Save Unipile provider config first.");
        return;
      }
      const res = await createAuthLink({ data: { origin: window.location.origin } });
      if (!res.success) {
        setConnectNote(res.error);
        return;
      }
      window.location.href = res.url;
    } catch (e) {
      setConnectNote((e as Error).message);
    } finally {
      setConnecting(false);
    }
  }

  async function refreshUnipile() {
    setRefreshingAccounts(true);
    setConnectNote("");
    try {
      const res = await fetchUnipileAccounts({});
      if (!res.success) {
        setConnectNote(res.error);
        return;
      }
      setUnipileAccounts(res.accounts);
      setActiveUnipileAccount(res.activeAccountId || res.accounts[0]?.id || "");
      if (!res.accounts.length)
        setConnectNote("No LinkedIn account found yet. Connect through the button, then refresh.");
    } catch (e) {
      setConnectNote((e as Error).message);
    } finally {
      setRefreshingAccounts(false);
    }
  }

  async function saveSelectedUnipileAccount(accountId = activeUnipileAccount) {
    if (!accountId) {
      setConnectNote("Select a Unipile account first.");
      return;
    }
    const selected = unipileAccounts.find((account) => account.id === accountId);
    let displayName = selected?.name || selected?.username || "LinkedIn via Unipile";
    let warning = "";
    try {
      const res = await persistUnipileAccount({ data: { accountId } });
      if (res.success) displayName = res.account.name || res.account.username || displayName;
      else warning = res.error;
    } catch (e) {
      warning = (e as Error).message;
    }
    store.set((s) => ({
      ...s,
      session: {
        ...s.session,
        connected: true,
        accountId,
        displayName,
      },
    }));
    if (warning) {
      setConnectNote(
        "LinkedIn account selected for this browser. Server persistence is temporary on this host: " +
          warning,
      );
    } else {
      setConnectNote("LinkedIn account selected. Approved message actions can use Unipile.");
    }
    setStep(1);
  }

  return (
    <AppShell title="Onboarding">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-6 flex items-center gap-2 text-xs text-muted-foreground">
          {["Connect", "Daily caps", "Warmup schedule", "Risk ack"].map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full border ${i <= step ? "border-primary bg-primary text-primary-foreground" : ""}`}
              >
                {i < step ? <CheckCircle2 className="h-3 w-3" /> : i + 1}
              </span>
              <span className={i === step ? "font-medium text-foreground" : ""}>{label}</span>
              {i < 3 && <span className="text-muted-foreground">&gt;</span>}
            </div>
          ))}
        </div>

        {step === 0 && (
          <Card className="p-6">
            <h2 className="text-lg font-semibold">Connect LinkedIn</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Recruiters connect through a hosted Unipile auth flow. Our app stores only the
              returned account id, then sends approved queue actions through that managed
              connection.
            </p>

            <div className="mt-5 rounded-lg border bg-muted/20 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">Unipile provider</div>
                  <div className="text-xs text-muted-foreground">
                    {providerConfigured
                      ? "Saved on this server. Recruiters can connect from the button below."
                      : "One-time local setup for this app instance."}
                  </div>
                </div>
                <span
                  className={`rounded-full px-2 py-1 text-[11px] ${providerConfigured ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600"}`}
                >
                  {providerConfigured ? "configured" : "needed"}
                </span>
              </div>

              {!providerConfigured && (
                <div className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_auto]">
                  <div>
                    <Label className="text-xs">DSN</Label>
                    <Input value={providerDsn} onChange={(e) => setProviderDsn(e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-xs">API key</Label>
                    <Input
                      type="password"
                      value={providerApiKey}
                      placeholder="Paste Unipile API key"
                      onChange={(e) => setProviderApiKey(e.target.value)}
                    />
                  </div>
                  <div className="flex items-end">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={savingProvider || !providerApiKey.trim()}
                      onClick={saveProviderConfig}
                    >
                      {savingProvider && <RefreshCw className="mr-1 h-4 w-4 animate-spin" />}
                      Save
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={connectWithUnipile} disabled={connecting || !providerConfigured}>
                {connecting ? (
                  <RefreshCw className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <ExternalLink className="mr-1 h-4 w-4" />
                )}
                Connect LinkedIn
              </Button>
              <Button variant="outline" onClick={refreshUnipile} disabled={refreshingAccounts}>
                <RefreshCw className={`mr-1 h-4 w-4 ${refreshingAccounts ? "animate-spin" : ""}`} />
                Refresh accounts
              </Button>
              <Button variant="ghost" onClick={() => nav({ to: "/connections" })}>
                Cookie fallback
              </Button>
            </div>

            {connectNote && (
              <div className="mt-4 rounded-md border bg-muted/40 px-3 py-2 text-xs text-foreground">
                {connectNote}
              </div>
            )}

            {unipileAccounts.length > 0 && (
              <div className="mt-5 rounded-lg border">
                <div className="border-b px-4 py-2 text-xs font-medium text-muted-foreground">
                  Connected Unipile accounts
                </div>
                <div className="space-y-2 p-3">
                  {unipileAccounts.map((account) => (
                    <label
                      key={account.id}
                      className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <input
                          type="radio"
                          name="unipile-account"
                          checked={activeUnipileAccount === account.id}
                          onChange={() => setActiveUnipileAccount(account.id)}
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">
                            {account.name || account.username || account.id}
                          </span>
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {account.provider || account.type || "LINKEDIN"} -{" "}
                            {account.status || "unknown"} - {account.id}
                          </span>
                        </span>
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        type="button"
                        onClick={() => saveSelectedUnipileAccount(account.id)}
                      >
                        Use
                      </Button>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {session.connected && (
              <Button variant="outline" className="mt-4" onClick={() => setStep(1)}>
                Already linked - continue
              </Button>
            )}
          </Card>
        )}

        {step === 1 && (
          <Card className="p-6">
            <h2 className="text-lg font-semibold">Set your daily ceiling</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              These are your maximum daily volumes <em>after</em> warmup. Warmup will ramp linearly
              to these over 14 days. Recommended: start low and raise after 30 days clean.
            </p>
            <div className="mt-4 grid grid-cols-3 gap-4">
              {(["invitesPerDay", "messagesPerDay", "profileViewsPerDay"] as const).map((k) => (
                <div key={k}>
                  <Label className="text-xs">{k.replace("PerDay", "")}/day</Label>
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={caps[k]}
                    onChange={(e) =>
                      store.set((s) => ({
                        ...s,
                        caps: {
                          ...s.caps,
                          [k]: Math.max(1, Math.min(100, Number(e.target.value) || 1)),
                        },
                      }))
                    }
                  />
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-amber-600">
              Industry "safe" rule: &lt;=20 invites/day, &lt;=30 DMs/day, &lt;=50 profile views/day
              on a warmed account.
            </p>
            <div className="mt-5 flex gap-2">
              <Button variant="outline" onClick={() => setStep(0)}>
                Back
              </Button>
              <Button onClick={() => setStep(2)}>
                Continue <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          </Card>
        )}

        {step === 2 && (
          <Card className="p-6">
            <h2 className="text-lg font-semibold">14-day warmup schedule</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              The first days are profile views only. Invites and messages ramp linearly to your
              ceiling by day 14.
            </p>
            <div className="mt-4 max-h-64 overflow-auto rounded border">
              <table className="w-full text-xs">
                <thead className="bg-muted text-muted-foreground">
                  <tr>
                    <th className="p-2 text-left">Day</th>
                    <th className="p-2">Views</th>
                    <th className="p-2">Invites</th>
                    <th className="p-2">Messages</th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: 14 }, (_, i) => {
                    const d = i + 1;
                    const eff = effectiveCaps({
                      ...store.get(),
                      warmup: { startedAt: new Date(Date.now() - i * 86400000).toISOString() },
                    });
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
              <p className="mt-3 text-xs text-emerald-600">
                Warmup started {new Date(warmup.startedAt).toLocaleDateString()}.
              </p>
            ) : null}
            <div className="mt-5 flex gap-2">
              <Button variant="outline" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button
                onClick={() => {
                  if (!warmup.startedAt)
                    store.set((s) => ({ ...s, warmup: { startedAt: new Date().toISOString() } }));
                  setStep(3);
                }}
              >
                Start warmup <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          </Card>
        )}

        {step === 3 && (
          <Card className="p-6">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <ShieldAlert className="h-5 w-5 text-amber-600" /> Risk acknowledgment
            </h2>
            <ul className="mt-3 space-y-2 text-sm">
              <li>- LinkedIn ToS prohibits all third-party automation, including this app.</li>
              <li>
                - Accounts may be temporarily restricted or permanently banned without notice.
              </li>
              <li>- Every action is queued for your explicit approval - nothing is automatic.</li>
              <li>- You are responsible for the content of every message sent on your behalf.</li>
            </ul>
            <label className="mt-4 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} />
              I understand and accept the risk.
            </label>
            <div className="mt-5 flex gap-2">
              <Button variant="outline" onClick={() => setStep(2)}>
                Back
              </Button>
              <Button
                disabled={!acked}
                onClick={() => {
                  store.set((s) => ({ ...s, onboarded: true }));
                  nav({ to: "/" });
                }}
              >
                Finish onboarding
              </Button>
            </div>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
