import { useState, type ReactNode } from "react";
import { Linkedin, Loader2, CheckCircle2, AlertCircle, Globe } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { store } from "@/lib/store";

export function LinkedInSignInDialog({ trigger }: { trigger: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"choose" | "connecting" | "done">("choose");

  async function connectDemo() {
    setStep("connecting");
    await new Promise((r) => setTimeout(r, 1800));
    store.set((s) => ({
      ...s,
      session: {
        connected: true,
        capturedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
      },
    }));
    setStep("done");
    setTimeout(() => setOpen(false), 1200);
  }

  function onOpenChange(v: boolean) {
    setOpen(v);
    if (!v) setStep("choose");
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

        {step === "choose" && (
          <div className="space-y-4 pt-2">
            <p className="text-sm text-muted-foreground">
              Connect your LinkedIn account so the agent can search your network, manage your inbox, and queue outreach for your approval.
            </p>

            <div className="rounded-lg border bg-muted/40 p-4 space-y-3">
              <div className="flex items-start gap-3 text-sm">
                <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                <span>Search & rank your 1st-degree connections</span>
              </div>
              <div className="flex items-start gap-3 text-sm">
                <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                <span>Draft personalized DMs, emails & connection requests</span>
              </div>
              <div className="flex items-start gap-3 text-sm">
                <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                <span>Manage inbox & connection requests</span>
              </div>
              <div className="flex items-start gap-3 text-sm">
                <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                <span>Respects daily limits (1,000 syncs/day, warmup caps)</span>
              </div>
            </div>

            <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 p-3 flex items-start gap-2 text-xs text-amber-800 dark:text-amber-200">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>Nothing is ever sent without your explicit approval in the Requests panel.</span>
            </div>

            <div className="flex flex-col gap-2 pt-1">
              <Button onClick={connectDemo} className="gap-2 w-full">
                <Globe className="h-4 w-4" />
                Connect LinkedIn Account
              </Button>
              <Button variant="ghost" className="text-xs text-muted-foreground" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {step === "connecting" && (
          <div className="flex flex-col items-center gap-4 py-8">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <div className="text-center">
              <p className="text-sm font-medium">Connecting to LinkedIn…</p>
              <p className="text-xs text-muted-foreground mt-1">Verifying session and pulling profile</p>
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="flex flex-col items-center gap-4 py-8">
            <CheckCircle2 className="h-8 w-8 text-emerald-500" />
            <div className="text-center">
              <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">Connected!</p>
              <p className="text-xs text-muted-foreground mt-1">Ready to manage your network</p>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
