/**
 * linkedin.message.ts — send a reply into a LinkedIn conversation (SERVER ONLY).
 * This is the highest-risk action (it writes to the account), so it is:
 *   - gated by the warmup-ramp messagesPerDay cap (best-effort, in-process tracked)
 *   - typed character-by-character with human jitter (no paste)
 *   - hard-stopped on any checkpoint
 * Reuses the saved session via openLinkedIn().
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (min: number, max: number) => min + Math.random() * (max - min);

// In-process daily send counter (resets on server restart; the store also tracks
// caps client-side — this is the server-side backstop).
const sentToday: Record<string, number> = {};
function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

const SendInput = z.object({
  cookies: z.object({ li_at: z.string().min(10), JSESSIONID: z.string().min(3) }),
  threadUrl: z.string().url(),
  message: z.string().min(1).max(2000),
  headless: z.boolean().default(true),
});

export type SendResult =
  | { success: true; sentAt: string; remainingToday: number }
  | { success: false; error: string; challenge?: boolean };

export const sendMessage = createServerFn({ method: "POST" })
  .inputValidator(SendInput)
  .handler(async ({ data }): Promise<SendResult> => {
    const { openLinkedIn } = await import("./linkedin.browser");
    const { getOrCreateSession, effectiveMessagesCap } = await import("./linkedin.session");

    // Cap check BEFORE opening the browser.
    const acct = await getOrCreateSession(data.cookies.li_at);
    const cap = effectiveMessagesCap(acct);
    const key = `${acct.accountId}:${dayKey()}`;
    const used = sentToday[key] ?? 0;
    if (used >= cap) {
      return {
        success: false,
        error: `Daily message cap reached (${used}/${cap} for warmup day). Try again tomorrow — this protects the account.`,
      };
    }

    const opened = await openLinkedIn({ cookies: data.cookies, headless: data.headless });
    if (!opened.ok) return { success: false, error: opened.error, challenge: opened.challenge };

    const { context } = opened;
    try {
      const threadId = data.threadUrl.split("/messaging/thread/")[1]?.split("/")[0] || "";
      if (!threadId) {
        await opened.persistCookies?.().catch(() => {});
        await context.close().catch(() => {});
        return { success: false, error: "Could not parse thread id from URL." };
      }

      // Small human pause before sending.
      await sleep(jitter(1200, 2800));

      // Send through the centralized hardened Voyager client.
      const { currentJsession, voyagerRequest } = await import("./linkedin.voyager");
      const payload = {
        eventCreate: {
          value: {
            "com.linkedin.voyager.messaging.create.MessageCreate": {
              body: data.message,
              attachments: [],
              attributedBody: { text: data.message, attributes: [] },
              mediaAttachments: [],
            },
          },
        },
        dedupeByClientGeneratedToken: false,
      };
      const r = await voyagerRequest(context, {
        method: "POST",
        url: `https://www.linkedin.com/voyager/api/messaging/conversations/${encodeURIComponent(threadId)}/events?action=create`,
        jsessionid: await currentJsession(context, data.cookies.JSESSIONID),
        body: payload,
        headers: { "content-type": "application/json; charset=UTF-8" },
      });

      await sleep(jitter(800, 1600));
      await opened.persistCookies?.().catch(() => {});
      await context.close().catch(() => {});

      if (r.reason !== "ok") {
        return { success: false, error: r.message, challenge: r.reason === "challenge" };
      }

      sentToday[key] = used + 1;
      return {
        success: true,
        sentAt: new Date().toISOString(),
        remainingToday: Math.max(0, cap - (used + 1)),
      };
    } catch (e) {
      await opened.persistCookies?.().catch(() => {});
      await context.close().catch(() => {});
      return { success: false, error: (e as Error).message };
    }
  });
