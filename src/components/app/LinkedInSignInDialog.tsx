import { useState, type ReactNode } from "react";
import { Linkedin, Loader2, CheckCircle2, AlertCircle, Key, ShieldCheck } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { store } from "@/lib/store";
import { validateAndSaveSession } from "@/lib/linkedin.session.fn";

export function LinkedInSignInDialog({ trigger }: { trigger: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"form" | "connecting" | "done" | "error">("form");
  const [liAt, setLiAt] = useState("");
  const [jSessionId, setJSessionId] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [displayName, setDisplayName] = useState("");

  const validate = useServerFn(validateAndSaveSession);

  async function connect() {
    if (!liAt.trim() || !jSessionId.trim()) {
      setErrorMsg("Both li_at and JSESSIONID are required.");
      setStep("error");
      return;
    }
    setStep("connecting");
    setErrorMsg("");
    try {
      const res = await validate({
        data: {
          li_at: liAt.trim(),
          JSESSIONID: jSessionId.trim(),
          userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
        },
      });
      if (res.success) {
        // Save globally so imports and the approved action queue can reuse it.
        store.set((s) => ({
          ...s,
          session: {
            connected: true,
            capturedAt: new Date().toISOString(),
            userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
            cookies: { li_at: liAt.trim(), JSESSIONID: jSessionId.trim() },
            displayName: res.displayName,
            accountId: res.accountId,
          } as any,
        }));
        setDisplayName(res.displayName);
        setStep("done");
        setTimeout(() => onOpenChange(false), 1400);
      } else {
        setErrorMsg(res.error);
        setStep("error");
      }
    } catch (e) {
      setErrorMsg((e as Error).message);
      setStep("error");
    }
  }

  function onOpenChange(v: boolean) {
    setOpen(v);
    if (!v) {
      setStep("form");
      setErrorMsg("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Linkedin className="h-5 w-5 text-[#0A66C2]" />
            Connect LinkedIn
          </DialogTitle>
        </DialogHeader>

        {(step === "form" || step === "error") && (
          <div className="space-y-4 pt-2">
            <p className="text-sm text-muted-foreground">
              Paste your session cookies. We validate once, then save the session so imports and
              approved outreach can reuse the same account.
            </p>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground ml-1 flex items-center gap-1.5">
                  <Key className="h-3 w-3" /> li_at cookie
                </label>
                <Input
                  value={liAt}
                  onChange={(e) => setLiAt(e.target.value)}
                  placeholder="Paste li_at cookie…"
                  className="bg-background font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground ml-1 flex items-center gap-1.5">
                  <Key className="h-3 w-3" /> JSESSIONID cookie
                </label>
                <Input
                  value={jSessionId}
                  onChange={(e) => setJSessionId(e.target.value)}
                  placeholder='e.g. "ajax:1234567890…"'
                  className="bg-background font-mono text-xs"
                />
              </div>
            </div>

            <div className="rounded-lg border bg-muted/40 p-3 text-[11px] text-muted-foreground leading-relaxed">
              <p className="font-medium text-foreground mb-1 flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" /> Where to find these
              </p>
              On a logged-in linkedin.com tab: F12 → Application → Cookies → linkedin.com → copy the{" "}
              <code>li_at</code> and <code>JSESSIONID</code> values.
            </div>

            {step === "error" && (
              <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30 p-3 flex items-start gap-2 text-xs text-red-700 dark:text-red-300">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}

            <div className="flex flex-col gap-2 pt-1">
              <Button onClick={connect} className="gap-2 w-full">
                <Linkedin className="h-4 w-4" />
                Connect & Validate
              </Button>
              <Button
                variant="ghost"
                className="text-xs text-muted-foreground"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {step === "connecting" && (
          <div className="flex flex-col items-center gap-4 py-8">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <div className="text-center">
              <p className="text-sm font-medium">Validating session…</p>
              <p className="text-xs text-muted-foreground mt-1">
                Opening a stealth browser and checking your feed
              </p>
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="flex flex-col items-center gap-4 py-8">
            <CheckCircle2 className="h-8 w-8 text-emerald-500" />
            <div className="text-center">
              <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
                Connected{displayName ? ` as ${displayName}` : ""}!
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Session saved - imports and approved outreach are ready
              </p>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
