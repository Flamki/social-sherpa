/**
 * action.queue.ts â€” persistent, self-healing action queue (SERVER ONLY).
 *
 * Botdog/PhantomBuster pattern: UI approves actions; a worker drains the queue
 * with caps, jitter, retries, and typed failures. Nothing writes to LinkedIn
 * directly from a button without going through this queue.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { runtimeDataDir } from "@/lib/config.server";

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

async function fsEnv() {
  const [{ promises: fs }, path] = await Promise.all([import("node:fs"), import("node:path")]);
  const queuePath = path.join(runtimeDataDir(), "queue", "actions.json");
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

async function clickFirstVisible(locators: any[], timeout = 4_000): Promise<boolean> {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 8); i++) {
      const item = locator.nth(i);
      const visible = await item.isVisible().catch(() => false);
      const enabled = await item.isEnabled().catch(() => true);
      if (visible && enabled) {
        await item.click({ timeout });
        return true;
      }
    }
  }
  return false;
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
  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await browserSleep(jitter(2_000, 4_500));

    const currentUrl = page.url();
    if (/\/checkpoint/i.test(currentUrl)) {
      await closeOpened(opened);
      return {
        ok: false,
        error: "LinkedIn checkpoint appeared. Clear it manually, then retry the approved action.",
      };
    }
    if (/\/login|\/uas\/login|\/authwall|\/signup/i.test(currentUrl)) {
      await closeOpened(opened);
      return {
        ok: false,
        error: "LinkedIn session expired while opening the profile. Reconnect with fresh cookies.",
      };
    }

    const pageText = await page
      .locator("body")
      .innerText({ timeout: 5_000 })
      .catch(() => "");
    if (/\bPending\b|\bInvitation sent\b/i.test(pageText)) {
      await closeOpened(opened);
      return { ok: true };
    }

    let clickedConnect = await clickFirstVisible([
      page.getByRole("button", { name: /^Connect$/i }),
      page.locator("button").filter({ hasText: /^Connect$/i }),
    ]);

    if (!clickedConnect) {
      const openedMore = await clickFirstVisible([
        page.getByRole("button", { name: /More/i }),
        page.locator("button[aria-label*='More']"),
        page.locator("button").filter({ hasText: /^More$/i }),
      ]);
      if (openedMore) {
        await browserSleep(jitter(500, 1_100));
        clickedConnect = await clickFirstVisible([
          page.getByRole("menuitem", { name: /Connect/i }),
          page.locator("[role='menuitem']").filter({ hasText: /Connect/i }),
          page.locator("div, button").filter({ hasText: /^Connect$/i }),
        ]);
      }
    }

    if (!clickedConnect) {
      const refreshedText = await page
        .locator("body")
        .innerText({ timeout: 3_000 })
        .catch(() => "");
      const alreadyConnected =
        /\b1st\b|\bMessage\b/i.test(refreshedText) && !/\bConnect\b/i.test(refreshedText);
      await closeOpened(opened);
      return alreadyConnected
        ? { ok: true }
        : {
            ok: false,
            error:
              "No Connect button found on this profile. It may be outside your network or LinkedIn may only allow Follow.",
          };
    }

    await browserSleep(jitter(700, 1_600));
    const note = safeNote(action.body);
    if (note) {
      const addedNote = await clickFirstVisible(
        [
          page.getByRole("button", { name: /Add a note/i }),
          page.locator("button").filter({ hasText: /Add a note/i }),
        ],
        3_000,
      );
      if (addedNote) {
        await browserSleep(jitter(400, 900));
        const textarea = page.locator("textarea").first();
        if (await textarea.isVisible().catch(() => false)) {
          await textarea.fill(note, { timeout: 4_000 });
          await browserSleep(jitter(600, 1_200));
        }
      }
    }

    const sent = await clickFirstVisible(
      [
        page.getByRole("button", { name: /^Send$/i }),
        page.getByRole("button", { name: /Send invitation/i }),
        page.locator("button").filter({ hasText: /^Send$/i }),
        page.locator("button").filter({ hasText: /Send invitation/i }),
      ],
      5_000,
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
        "DM needs either a LinkedIn message thread URL or the connection's full profile URL. " +
        "Re-import this connection from the LinkedIn people search so the profile URL is stored.",
    };
  }
  if (!body) return { ok: false, error: "Message action missing body." };

  const { openLinkedIn, sleep: browserSleep } = await import("./linkedin.browser");
  const opened = await openLinkedIn({ cookies, headless });
  if (!opened.ok) return { ok: false, error: opened.error };

  const { page } = opened;
  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await browserSleep(jitter(2_500, 5_000));

    const currentUrl = page.url();
    if (/\/checkpoint/i.test(currentUrl)) {
      await closeOpened(opened);
      return {
        ok: false,
        error: "LinkedIn checkpoint appeared. Clear it manually, then retry the approved action.",
      };
    }
    if (/\/login|\/uas\/login|\/authwall|\/signup/i.test(currentUrl)) {
      await closeOpened(opened);
      return {
        ok: false,
        error: "LinkedIn session expired while opening the profile. Reconnect with fresh cookies.",
      };
    }

    const clickedMessage = await clickFirstVisible(
      [
        page.getByRole("button", { name: /^Message$/i }),
        page.locator("button[aria-label*='Message']"),
        page.locator("a[aria-label*='Message']"),
        page.locator("button").filter({ hasText: /^Message$/i }),
        page.locator("a").filter({ hasText: /^Message$/i }),
      ],
      6_000,
    );

    if (!clickedMessage) {
      await closeOpened(opened);
      return {
        ok: false,
        error:
          "No Message button found on this profile. The person may not be a 1st-degree connection, or LinkedIn hid messaging for this profile.",
      };
    }

    await browserSleep(jitter(1_500, 3_000));

    const composerLocators = [
      page.locator("div.msg-form__contenteditable[contenteditable='true']"),
      page.locator("div[contenteditable='true'][role='textbox']"),
      page.locator("[role='textbox'][contenteditable='true']"),
      page.locator("textarea"),
    ];

    let composer: any = null;
    for (const locator of composerLocators) {
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 5); i++) {
        const item = locator.nth(i);
        if (await item.isVisible().catch(() => false)) {
          composer = item;
          break;
        }
      }
      if (composer) break;
    }

    if (!composer) {
      await closeOpened(opened);
      return { ok: false, error: "Message composer did not open after clicking Message." };
    }

    await composer.click({ timeout: 5_000 });
    await browserSleep(jitter(500, 1_200));
    const tagName = await composer
      .evaluate((el: Element) => el.tagName.toLowerCase())
      .catch(() => "");
    if (tagName === "textarea" || tagName === "input") {
      await composer.fill(body, { timeout: 8_000 });
    } else {
      await page.keyboard.type(body, { delay: Math.round(jitter(28, 70)) });
    }

    await browserSleep(jitter(900, 1_800));
    const clickedSend = await clickFirstVisible(
      [
        page.locator("button.msg-form__send-button"),
        page.getByRole("button", { name: /^Send$/i }),
        page.locator("button[aria-label*='Send']"),
        page.locator("button").filter({ hasText: /^Send$/i }),
      ],
      6_000,
    );

    if (!clickedSend) {
      await closeOpened(opened);
      return {
        ok: false,
        error: "Message composer opened, but no enabled Send button was available.",
      };
    }

    await browserSleep(jitter(1_800, 3_200));
    const composerText = await composer.innerText({ timeout: 2_000 }).catch(() => "");
    const pageText = await page
      .locator("body")
      .innerText({ timeout: 5_000 })
      .catch(() => "");
    const bodyNeedle = body.slice(0, Math.min(80, body.length));
    const composerCleared = !composerText.includes(bodyNeedle);
    const messageVisible = pageText.includes(bodyNeedle);

    await closeOpened(opened);
    return composerCleared || messageVisible
      ? { ok: true }
      : {
          ok: false,
          error:
            "Clicked Send, but could not verify the message left the composer. Check LinkedIn manually, then retry if needed.",
        };
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
      let ok = false;
      let err = "Unsupported action type";

      if (action.type === "message") {
        if (!action.body) throw new Error("Message action missing body.");
        const { canUseUnipileConnector, sendLinkedInMessageWithUnipile } =
          await import("./unipile");
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
        await opened.page.goto(action.targetUrl, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
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
