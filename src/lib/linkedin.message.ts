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

    try {
      const threadId = data.threadUrl.split("/messaging/thread/")[1]?.split("/")[0] || "";
      if (!threadId) {
        return { success: false, error: "Could not parse thread id from URL." };
      }

      // Voyager messaging can reject a valid browser login with 403. Use the real LinkedIn
      // message composer instead, from the same persisted session profile.
      await sleep(jitter(1200, 2800));
      const { sendLinkedInMessageViaThreadUi } = await import("./linkedin.message.ui");
      const result = await sendLinkedInMessageViaThreadUi({
        cookies: data.cookies,
        headless: data.headless,
        threadUrl: data.threadUrl,
        body: data.message,
      });

      if (!result.ok) {
        return { success: false, error: result.error };
      }

      sentToday[key] = used + 1;
      return {
        success: true,
        sentAt: new Date().toISOString(),
        remainingToday: Math.max(0, cap - (used + 1)),
      };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  });
