/**
 * linkedin.session.fn.ts — server functions for the global "Connect LinkedIn" flow.
 * The header dialog calls validateAndSaveSession() with the pasted cookies; we open
 * a stealth browser, confirm the session is live, persist the cookies server-side,
 * and return the account's display name so the UI can show who's connected.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const CookieInput = z.object({
  li_at: z.string().min(10),
  JSESSIONID: z.string().min(3),
  userAgent: z.string().optional(),
});

export type ValidateResult =
  | { success: true; accountId: string; displayName: string; warmupDay: number }
  | { success: false; error: string; challenge?: boolean };

export const validateAndSaveSession = createServerFn({ method: "POST" })
  .inputValidator(CookieInput)
  .handler(async ({ data }): Promise<ValidateResult> => {
    const { openLinkedIn, sleep } = await import("./linkedin.browser");
    const { pinAutoProxyForFreshCookies, warmupDay } = await import("./linkedin.session");

    await pinAutoProxyForFreshCookies(data.li_at);

    const opened = await openLinkedIn({
      cookies: { li_at: data.li_at, JSESSIONID: data.JSESSIONID },
      headless: true,
    });

    if (!opened.ok) {
      return { success: false, error: opened.error, challenge: opened.challenge };
    }

    const { context, page, account } = opened;
    try {
      // Pull the logged-in member's name from the feed nav (best-effort).
      await sleep(800);
      const displayName: string = await page.evaluate(() => {
        const candidates = [
          document.querySelector<HTMLImageElement>("img.global-nav__me-photo")?.alt,
          document.querySelector<HTMLElement>(".feed-identity-module__actor-meta a")?.innerText,
          document.querySelector<HTMLImageElement>("img[alt][width='48']")?.alt,
        ];
        const hit = candidates.find((c) => c && c.trim() && !/logo/i.test(c));
        return (hit || "").trim();
      });

      await opened.persistCookies();
      await context.close().catch(() => {});

      return {
        success: true,
        accountId: account.accountId,
        displayName: displayName || "LinkedIn account",
        warmupDay: warmupDay(account),
      };
    } catch (e) {
      await context.close().catch(() => {});
      return { success: false, error: (e as Error).message };
    }
  });
