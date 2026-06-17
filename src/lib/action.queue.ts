/**
 * action.queue.ts - persistent, self-healing action queue (SERVER ONLY).
 *
 * Botdog/PhantomBuster pattern: UI approves actions; a worker drains the queue
 * with caps, jitter, retries, and typed failures. Nothing writes to LinkedIn
 * directly from a button without going through this queue.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type QueueStatus =
  | "pending"
  | "approved"
  | "running"
  | "sent"
  | "rejected"
  | "failed"
  | "retrying";
export type QueueType = "message" | "connection_request" | "profile_view";

export type QueueAction = {
  id: string;
  type: QueueType;
  targetName: string;
  targetUrl?: string;
  threadUrl?: string;
  profileUrn?: string;
  body?: string;
  reasoning?: string;
  status: QueueStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  sentAt?: string;
  attempts: number;
  nextRunAt?: string;
  lastError?: string;
};

type QueueFile = { actions: QueueAction[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (min: number, max: number) => min + Math.random() * (max - min);

function queueRuntimeDataDir(path: typeof import("node:path")) {
  if (process.env.SHERPA_DATA_DIR?.trim()) return process.env.SHERPA_DATA_DIR.trim();
  if (process.env.VERCEL) return path.join("/tmp", "social-sherpa");
  return path.join(process.cwd(), ".sherpa");
}

async function fsEnv() {
  const [{ promises: fs }, path] = await Promise.all([import("node:fs"), import("node:path")]);
  const queuePath = path.join(queueRuntimeDataDir(path), "queue", "actions.json");
  return { fs, path, queuePath };
}
async function ensureDir() {
  const { fs, path, queuePath } = await fsEnv();
  await fs.mkdir(path.dirname(queuePath), { recursive: true });
}
async function readQueue(): Promise<QueueFile> {
  await ensureDir();
  const { fs, queuePath } = await fsEnv();
  try {
    return JSON.parse(await fs.readFile(queuePath, "utf8"));
  } catch {
    return { actions: [] };
  }
}

export async function readQueueActions(): Promise<QueueAction[]> {
  const q = await readQueue();
  return q.actions;
}

async function writeQueue(q: QueueFile) {
  await ensureDir();
  const { fs, queuePath } = await fsEnv();
  await fs.writeFile(queuePath, JSON.stringify(q, null, 2));
}
function id() {
  return "act_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}
function now() {
  return new Date().toISOString();
}
function due(a: QueueAction) {
  return !a.nextRunAt || new Date(a.nextRunAt).getTime() <= Date.now();
}
function backoff(attempts: number) {
  // 1m, 3m, 9m, 27m, max 2h + jitter
  const minutes = Math.min(120, Math.pow(3, Math.max(0, attempts - 1)));
  return new Date(Date.now() + minutes * 60_000 + jitter(5_000, 30_000)).toISOString();
}

async function closeOpened(opened: { persistCookies?: () => Promise<void>; context: any }) {
  await opened.persistCookies?.().catch(() => {});
  await opened.context.close().catch(() => {});
}

function safeNote(body?: string) {
  return (body || "").trim().slice(0, 280);
}

function safeDm(body?: string) {
  return (body || "").trim().slice(0, 2_000);
}

function profileUrlFor(action: QueueAction) {
  const raw = (action.targetUrl || "").trim();
  if (!raw) return "";
  if (/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\//i.test(raw)) return raw;
  if (/^https:\/\/www\.linkedin\.com\/pub\//i.test(raw)) return raw;
  return "";
}

function publicIdFromActionUrl(url: string): string {
  const m = url.match(/\/in\/([^/?#]+)/i);
  if (!m?.[1]) return "";
  try {
    return decodeURIComponent(m[1]).trim();
  } catch {
    return m[1].trim();
  }
}

// Resolve a profile's stable LinkedIn id from its public handle (vanity URL). The id is
// what the messaging and invitation APIs need — there is no per-profile page navigation.
async function resolveProfileId(context: any, jsessionid: string, publicId: string) {
  const { voyagerRequest } = await import("./linkedin.voyager");
  const r = await voyagerRequest(context, {
    url: `https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(publicId)}`,
    jsessionid,
    retries: 1,
  });
  if (r.reason !== "ok") {
    return { id: "", entityUrn: "", error: `Profile lookup failed (${r.status}): ${r.message}` };
  }
  const pools = [
    ...(Array.isArray(r.data?.elements) ? r.data.elements : []),
    ...(Array.isArray(r.data?.data?.elements) ? r.data.data.elements : []),
    ...(Array.isArray(r.data?.included) ? r.data.included : []),
  ];
  let entityUrn = "";
  for (const e of pools) {
    const urn = String(e?.entityUrn || "");
    if (/urn:li:fsd_profile:/.test(urn)) {
      entityUrn = urn;
      break;
    }
  }
  if (!entityUrn) {
    return { id: "", entityUrn: "", error: "Could not resolve this profile's LinkedIn id." };
  }
  return { id: entityUrn.split(":").pop() || "", entityUrn, error: "" };
}

// Send a NEW LinkedIn DM via the lightweight Voyager messaging API — no profile-page
// navigation, no button clicking. Far lighter and less bot-detectable than driving the UI.
async function sendMessageViaProfileUi(
  action: QueueAction,
  cookies: { li_at: string; JSESSIONID: string },
  headless: boolean,
) {
  const targetUrl = profileUrlFor(action);
  const body = safeDm(action.body);
  if (!targetUrl) {
    return {
      ok: false,
      error:
        "DM needs the connection's full LinkedIn profile URL. " +
        "Re-import this connection so the profile URL is stored.",
    };
  }
  if (!body) return { ok: false, error: "Message action missing body." };
  const publicId = publicIdFromActionUrl(targetUrl);
  if (!publicId) return { ok: false, error: "Could not read the profile handle from the URL." };

  const { openLinkedIn } = await import("./linkedin.browser");
  const { currentJsession, voyagerRequest } = await import("./linkedin.voyager");
  const opened = await openLinkedIn({ cookies, headless });
  if (!opened.ok) return { ok: false, error: opened.error };
  try {
    const jsessionid = await currentJsession(opened.context, cookies.JSESSIONID);
    const resolved = await resolveProfileId(opened.context, jsessionid, publicId);
    if (resolved.error) {
      await closeOpened(opened);
      return { ok: false, error: resolved.error };
    }
    const r = await voyagerRequest(opened.context, {
      method: "POST",
      url: "https://www.linkedin.com/voyager/api/messaging/conversations?action=create",
      jsessionid,
      headers: { "content-type": "application/json; charset=UTF-8" },
      body: {
        conversationCreate: {
          eventCreate: {
            value: {
              "com.linkedin.voyager.messaging.create.MessageCreate": {
                body,
                attachments: [],
                attributedBody: { text: body, attributes: [] },
                mediaAttachments: [],
              },
            },
          },
          recipients: [`urn:li:fs_miniProfile:${resolved.id}`],
          subtype: "MEMBER_TO_MEMBER",
        },
      },
      retries: 1,
    });
    await closeOpened(opened);
    if (r.reason === "ok") return { ok: true };
    return { ok: false, error: `LinkedIn rejected the message (${r.status}): ${r.message}` };
  } catch (e) {
    await closeOpened(opened);
    return { ok: false, error: (e as Error).message };
  }
}

// Send a connection request by driving the real "Connect" button on the profile page.
// The Voyager invitation REST API is being deprecated (404s), so the UI is the reliable path.
async function sendConnectionRequestViaUi(
  action: QueueAction,
  cookies: { li_at: string; JSESSIONID: string },
  headless: boolean,
) {
  const targetUrl = profileUrlFor(action);
  if (!targetUrl) {
    return {
      ok: false,
      error:
        "Connection request needs a full LinkedIn profile URL, for example https://www.linkedin.com/in/name/.",
    };
  }

  const { openLinkedIn, sleep: browserSleep } = await import("./linkedin.browser");
  const opened = await openLinkedIn({ cookies, headless });
  if (!opened.ok) return { ok: false, error: opened.error };
  const { page } = opened;

  // Click the first visible match among a list of locators.
  const clickVisible = async (locators: any[], timeout = 5_000) => {
    for (const loc of locators) {
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 6); i++) {
        const item = loc.nth(i);
        if (await item.isVisible().catch(() => false)) {
          await item.click({ timeout }).catch(() => {});
          return true;
        }
      }
    }
    return false;
  };

  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await browserSleep(jitter(2_500, 4_500));
    const url = page.url();
    if (/\/checkpoint/i.test(url)) {
      await closeOpened(opened);
      return { ok: false, error: "LinkedIn checkpoint appeared. Clear it manually, then retry." };
    }
    if (/\/login|\/uas\/login|\/authwall/i.test(url)) {
      await closeOpened(opened);
      return { ok: false, error: "LinkedIn session expired while opening the profile. Reconnect." };
    }

    // Already connected, or an invite is already pending → treat as done.
    const bodyText = await page
      .locator("body")
      .innerText({ timeout: 5_000 })
      .catch(() => "");
    if (/\bPending\b|\bInvitation sent\b/i.test(bodyText)) {
      await closeOpened(opened);
      return { ok: true };
    }

    // Click "Connect" — either the top-level button or one surfaced under "More".
    let clickedConnect = await clickVisible([
      page.getByRole("button", { name: /^Connect$/i }),
      page.locator("button[aria-label^='Invite']"),
      page.locator("button").filter({ hasText: /^Connect$/i }),
    ]);
    if (!clickedConnect) {
      const openedMore = await clickVisible([
        page.getByRole("button", { name: /^More/i }),
        page.locator("button[aria-label*='More actions']"),
      ]);
      if (openedMore) {
        await browserSleep(jitter(600, 1_200));
        clickedConnect = await clickVisible([
          page.getByRole("menuitem", { name: /Connect/i }),
          page.locator("[role='menuitem']").filter({ hasText: /Connect/i }),
          page.locator("div[aria-label^='Invite']"),
        ]);
      }
    }
    if (!clickedConnect) {
      const refreshed = await page
        .locator("body")
        .innerText({ timeout: 3_000 })
        .catch(() => "");
      const alreadyIn = /\b1st\b|\bMessage\b/i.test(refreshed) && !/\bConnect\b/i.test(refreshed);
      await closeOpened(opened);
      return alreadyIn
        ? { ok: true }
        : {
            ok: false,
            error:
              "No Connect button found — this person may be outside your network, or LinkedIn only allows Follow.",
          };
    }

    await browserSleep(jitter(800, 1_600));
    // In the "Add a note?" dialog, send WITHOUT a note (a plain connection request).
    const sent = await clickVisible(
      [
        page.getByRole("button", { name: /Send without a note/i }),
        page.getByRole("button", { name: /^Send$/i }),
        page.getByRole("button", { name: /Send (now|invitation)/i }),
        page.locator("button").filter({ hasText: /^Send$/i }),
      ],
      6_000,
    );
    if (!sent) {
      await closeOpened(opened);
      return { ok: false, error: "Connect dialog opened, but no Send button was available." };
    }

    await browserSleep(jitter(1_200, 2_500));
    await closeOpened(opened);
    return { ok: true };
  } catch (e) {
    await closeOpened(opened);
    return { ok: false, error: (e as Error).message };
  }
}

const EnqueueSchema = z.object({
  type: z.enum(["message", "connection_request", "profile_view"]),
  targetName: z.string().min(1).max(200),
  targetUrl: z.string().optional(),
  threadUrl: z.string().optional(),
  profileUrn: z.string().optional(),
  body: z.string().max(2000).optional(),
  reasoning: z.string().max(1000).optional(),
});

export const enqueueAction = createServerFn({ method: "POST" })
  .inputValidator(EnqueueSchema)
  .handler(async ({ data }) => {
    const q = await readQueue();
    const action: QueueAction = {
      id: id(),
      type: data.type,
      targetName: data.targetName,
      targetUrl: data.targetUrl,
      threadUrl: data.threadUrl,
      profileUrn: data.profileUrn,
      body: data.body,
      reasoning: data.reasoning,
      status: "pending",
      createdAt: now(),
      updatedAt: now(),
      attempts: 0,
    };
    q.actions.push(action);
    await writeQueue(q);
    return { success: true as const, action };
  });

export const listQueue = createServerFn({ method: "GET" }).handler(async () => {
  const q = await readQueue();
  return { success: true as const, actions: q.actions };
});

const DecisionSchema = z.object({ id: z.string(), approve: z.boolean() });
export const decideQueueAction = createServerFn({ method: "POST" })
  .inputValidator(DecisionSchema)
  .handler(async ({ data }) => {
    const q = await readQueue();
    const t = q.actions.find((a) => a.id === data.id);
    if (!t) return { success: false as const, error: "Action not found" };
    t.status = data.approve ? "approved" : "rejected";
    t.approvedAt = data.approve ? now() : undefined;
    t.updatedAt = now();
    if (data.approve) t.nextRunAt = new Date(Date.now() + jitter(60_000, 180_000)).toISOString();
    await writeQueue(q);
    return { success: true as const, action: t };
  });

const WorkerSchema = z.object({
  cookies: z.object({ li_at: z.string().min(10), JSESSIONID: z.string().min(3) }).optional(),
  unipileAccountId: z.string().min(1).optional(),
  headless: z.boolean().default(true),
});

type SendData = {
  cookies?: { li_at: string; JSESSIONID: string };
  unipileAccountId?: string;
  headless: boolean;
};

// A failure whose message points at the session/cookies — so the UI can prompt for fresh ones.
function isSessionError(msg: string) {
  return /session expired|cookie|reconnect|checkpoint|\/login|authwall|expired|\b999\b|blocked/i.test(
    msg || "",
  );
}

// Actually performs the action (DM / connection request / profile view). Shared by the
// background worker and the inline "send now" path so both behave identically. May throw.
async function dispatchSend(
  action: QueueAction,
  data: SendData,
): Promise<{ ok: boolean; err: string }> {
  let ok = false;
  let err = "Unsupported action type";

  if (action.type === "message") {
    if (!action.body) throw new Error("Message action missing body.");
    const { canUseUnipileConnector, sendLinkedInMessageWithUnipile } = await import("./unipile");
    if (await canUseUnipileConnector(data.unipileAccountId)) {
      const result = await sendLinkedInMessageWithUnipile({
        text: action.body,
        profileUrl: action.targetUrl,
        threadUrl: action.threadUrl,
        accountId: data.unipileAccountId,
      });
      ok = result.ok;
      err = result.ok ? "" : result.error;
    } else if (!data.cookies) {
      throw new Error("Connect LinkedIn with Unipile or cookies before running this action.");
    } else if (!action.threadUrl) {
      const result = await sendMessageViaProfileUi(action, data.cookies, data.headless);
      ok = result.ok;
      err = result.error || "";
    } else {
      const threadId = action.threadUrl.split("/messaging/thread/")[1]?.split("/")[0] || "";
      if (!threadId) throw new Error("Could not parse thread id from message action.");
      const { openLinkedIn } = await import("./linkedin.browser");
      const { currentJsession, voyagerRequest } = await import("./linkedin.voyager");
      const opened = await openLinkedIn({ cookies: data.cookies, headless: data.headless });
      if (!opened.ok) throw new Error(opened.error);
      const payload = {
        eventCreate: {
          value: {
            "com.linkedin.voyager.messaging.create.MessageCreate": {
              body: action.body,
              attachments: [],
              attributedBody: { text: action.body, attributes: [] },
              mediaAttachments: [],
            },
          },
        },
        dedupeByClientGeneratedToken: false,
      };
      const r = await voyagerRequest(opened.context, {
        method: "POST",
        url: `https://www.linkedin.com/voyager/api/messaging/conversations/${encodeURIComponent(threadId)}/events?action=create`,
        jsessionid: await currentJsession(opened.context, data.cookies.JSESSIONID),
        body: payload,
        headers: { "content-type": "application/json; charset=UTF-8" },
      });
      await closeOpened(opened);
      ok = r.reason === "ok";
      err = ok ? "" : r.message;
    }
  } else if (action.type === "profile_view") {
    if (!data.cookies) {
      throw new Error("Profile views need a cookie-backed LinkedIn browser session.");
    }
    if (!action.targetUrl) throw new Error("Profile view action missing targetUrl.");
    const { openLinkedIn, sleep: browserSleep } = await import("./linkedin.browser");
    const opened = await openLinkedIn({ cookies: data.cookies, headless: data.headless });
    if (!opened.ok) throw new Error(opened.error);
    await opened.page.goto(action.targetUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await browserSleep(jitter(3_000, 8_000));
    await closeOpened(opened);
    ok = true;
  } else if (action.type === "connection_request") {
    if (!data.cookies) {
      throw new Error("Connection requests need a cookie-backed LinkedIn browser session.");
    }
    const result = await sendConnectionRequestViaUi(action, data.cookies, data.headless);
    ok = result.ok;
    err = result.error || "";
  }
  return { ok, err };
}

/** Drain one approved due action. UI can call this on demand; later cron/daemon can call it periodically. */
export const runWorkerOnce = createServerFn({ method: "POST" })
  .inputValidator(WorkerSchema)
  .handler(async ({ data }) => {
    const q = await readQueue();
    const action = q.actions.find(
      (a) => (a.status === "approved" || a.status === "retrying") && due(a),
    );
    if (!action) return { success: true as const, ran: false, message: "No due approved action." };

    action.status = "running";
    action.updatedAt = now();
    action.attempts += 1;
    await writeQueue(q);

    // Human-shaped gap before the actual write.
    await sleep(jitter(8_000, 18_000));

    try {
      const { ok, err } = await dispatchSend(action, data);

      const fresh = await readQueue();
      const t = fresh.actions.find((a) => a.id === action.id)!;
      if (ok) {
        t.status = "sent";
        t.sentAt = now();
        t.lastError = undefined;
        t.nextRunAt = undefined;
      } else {
        t.status = action.attempts >= 3 ? "failed" : "retrying";
        t.lastError = err;
        t.nextRunAt = t.status === "retrying" ? backoff(action.attempts) : undefined;
      }
      t.updatedAt = now();
      await writeQueue(fresh);
      return { success: ok, ran: true, action: t, error: ok ? undefined : err };
    } catch (e) {
      const fresh = await readQueue();
      const t = fresh.actions.find((a) => a.id === action.id)!;
      const msg = (e as Error).message;
      t.status = action.attempts >= 3 ? "failed" : "retrying";
      t.lastError = msg;
      t.nextRunAt = t.status === "retrying" ? backoff(action.attempts) : undefined;
      t.updatedAt = now();
      await writeQueue(fresh);
      return { success: false as const, ran: true, action: t, error: msg };
    }
  });

export const resetQueue = createServerFn({ method: "POST" }).handler(async () => {
  await writeQueue({ actions: [] });
  return { success: true as const };
});

/** Drop every not-yet-sent action (pending/approved/retrying/failed/rejected), keeping only
 *  sent + in-flight ones as history. Used to clear a stale backlog from the chat. */
export const clearPendingActions = createServerFn({ method: "POST" }).handler(async () => {
  const q = await readQueue();
  const kept = q.actions.filter((a) => a.status === "sent" || a.status === "running");
  const cleared = q.actions.length - kept.length;
  await writeQueue({ actions: kept });
  return { success: true as const, cleared };
});

const RunNowSchema = z.object({
  id: z.string(),
  cookies: z.object({ li_at: z.string().min(10), JSESSIONID: z.string().min(3) }).optional(),
  unipileAccountId: z.string().min(1).optional(),
  headless: z.boolean().default(true),
});

/**
 * Run ONE queued action immediately by id — the inline "approve & send" from the agent chat.
 * Returns a clear sent/failed status with the real error, and flags `needsCookies` when the
 * failure is a session/cookie problem so the chat can prompt for fresh cookies on the spot.
 * Unlike the background worker, this fires right away (no pacing delay) and doesn't retry —
 * the user is watching and gets immediate feedback.
 */
export const runActionNow = createServerFn({ method: "POST" })
  .inputValidator(RunNowSchema)
  .handler(async ({ data }) => {
    const q = await readQueue();
    const action = q.actions.find((a) => a.id === data.id);
    if (!action) {
      return { success: false as const, status: "failed" as const, error: "Action not found." };
    }
    if (action.status === "sent") {
      return { success: true as const, status: "sent" as const };
    }

    action.status = "running";
    action.approvedAt = action.approvedAt || now();
    action.attempts += 1;
    action.updatedAt = now();
    await writeQueue(q);

    try {
      const { ok, err } = await dispatchSend(action, data);
      const fresh = await readQueue();
      const t = fresh.actions.find((a) => a.id === action.id)!;
      if (ok) {
        t.status = "sent";
        t.sentAt = now();
        t.lastError = undefined;
        t.nextRunAt = undefined;
      } else {
        t.status = "failed";
        t.lastError = err;
        t.nextRunAt = undefined;
      }
      t.updatedAt = now();
      await writeQueue(fresh);
      return {
        success: ok,
        status: ok ? ("sent" as const) : ("failed" as const),
        error: ok ? undefined : err,
        needsCookies: ok ? false : isSessionError(err),
      };
    } catch (e) {
      const msg = (e as Error).message;
      const fresh = await readQueue();
      const t = fresh.actions.find((a) => a.id === action.id)!;
      t.status = "failed";
      t.lastError = msg;
      t.nextRunAt = undefined;
      t.updatedAt = now();
      await writeQueue(fresh);
      return {
        success: false as const,
        status: "failed" as const,
        error: msg,
        needsCookies: isSessionError(msg),
      };
    }
  });
