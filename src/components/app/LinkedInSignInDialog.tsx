import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Linkedin } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { store } from "@/lib/store";

export function LinkedInSignInDialog({ trigger }: { trigger: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"credentials" | "cookies">("credentials");
  const [showOptional, setShowOptional] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [liAt, setLiAt] = useState("");
  const [liA, setLiA] = useState("");
  const [syncChats, setSyncChats] = useState(true);
  const [syncMessages, setSyncMessages] = useState(true);
  const [localization, setLocalization] = useState<"default" | "proxy">("default");
  const [loading, setLoading] = useState(false);

  const canSubmit =
    tab === "credentials"
      ? email.trim().length > 0 && password.length > 0
      : liAt.trim().length > 0;

  function handleLogin() {
    if (!canSubmit) return;
    setLoading(true);
    setTimeout(() => {
      store.set((s) => ({
        ...s,
        session: {
          connected: true,
          capturedAt: new Date().toISOString(),
          userAgent: navigator.userAgent,
        },
      }));
      setLoading(false);
      setOpen(false);
    }, 700);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
        <DialogHeader className="flex-row items-center gap-2 space-y-0 border-b px-5 py-3">
          <span className="flex h-6 w-6 items-center justify-center rounded bg-[#0a66c2] text-white">
            <Linkedin className="h-3.5 w-3.5" fill="currentColor" strokeWidth={0} />
          </span>
          <DialogTitle className="text-sm font-semibold">Sign in to LinkedIn</DialogTitle>
        </DialogHeader>

        <div className="px-6 py-5">
          <h2 className="text-center text-lg font-semibold">Choose a method</h2>

          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as "credentials" | "cookies")}
            className="mt-4"
          >
            <TabsList className="mx-auto grid w-fit grid-cols-2">
              <TabsTrigger value="credentials">Credentials</TabsTrigger>
              <TabsTrigger value="cookies">Cookies</TabsTrigger>
            </TabsList>

            <TabsContent value="credentials" className="mt-5 space-y-3">
              <Input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </TabsContent>

            <TabsContent value="cookies" className="mt-5 space-y-3">
              <p className="text-sm text-muted-foreground">
                Copy your LinkedIn cookies.{" "}
                <a className="font-medium text-foreground underline" href="#">
                  How to find them?
                </a>
              </p>
              <p className="text-sm text-muted-foreground">
                Your cookies need to be collected in the same browser as this page.
              </p>
              <Input
                placeholder="Enter your li_at value"
                value={liAt}
                onChange={(e) => setLiAt(e.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                If your account has Recruiter or Sales Navigator subscription, copy the li_a too.
              </p>
              <Input
                placeholder="Enter your li_a value (optional)"
                value={liA}
                onChange={(e) => setLiA(e.target.value)}
              />
            </TabsContent>
          </Tabs>

          <button
            type="button"
            onClick={() => setShowOptional((v) => !v)}
            className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium"
          >
            {showOptional ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
            Optional settings
          </button>

          {showOptional && (
            <div className="mt-3 space-y-4">
              <fieldset className="rounded-md border px-3 pb-3 pt-1">
                <legend className="px-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                  Messaging history synchronization
                </legend>
                <label className="mt-1 flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={syncChats}
                    onCheckedChange={(v) => setSyncChats(!!v)}
                  />
                  Synchronize chats
                </label>
                <label className="mt-2 flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={syncMessages}
                    onCheckedChange={(v) => setSyncMessages(!!v)}
                  />
                  Synchronize messages
                </label>
              </fieldset>

              <fieldset className="rounded-md border px-3 pb-3 pt-1">
                <legend className="px-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                  Localization
                </legend>
                <RadioGroup
                  value={localization}
                  onValueChange={(v) => setLocalization(v as "default" | "proxy")}
                  className="mt-1 gap-2"
                >
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="default" id="loc-default" />
                    <Label htmlFor="loc-default" className="text-sm font-normal">
                      Choose from available countries
                    </Label>
                  </div>
                  <Select defaultValue="ip">
                    <SelectTrigger className="ml-6 w-[calc(100%-1.5rem)]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ip">(Default) Based on IP address</SelectItem>
                      <SelectItem value="us">United States</SelectItem>
                      <SelectItem value="uk">United Kingdom</SelectItem>
                      <SelectItem value="de">Germany</SelectItem>
                      <SelectItem value="fr">France</SelectItem>
                      <SelectItem value="in">India</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="proxy" id="loc-proxy" />
                    <Label htmlFor="loc-proxy" className="text-sm font-normal">
                      Use your own proxy
                    </Label>
                  </div>
                </RadioGroup>
              </fieldset>
            </div>
          )}

          <div className="mt-6 grid grid-cols-2 gap-3">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleLogin} disabled={!canSubmit || loading}>
              {loading ? "Signing in…" : "Login"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}