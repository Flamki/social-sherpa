/**
 * linkedin.login.ts — email/password login (SERVER ONLY).
 *
 * Inspired by the OpenOutreach flow: instead of asking the user to dig cookies out of
 * DevTools, we drive LinkedIn's real login page in a VISIBLE browser window. The user types
 * their email + password (passed once to this server function, never stored or logged); we
 * fill the form, submit, and then wait while the user clears any 2FA / CAPTCHA / email-code
 * challenge in that same window. Once the session is authenticated we read the resulting
 * `li_at` + `JSESSIONID` cookies and hand them straight to the existing cookie pipeline —
 * so import, messaging, and everything else work unchanged.
 *
 * Notes:
 *  - Visible window ⇒ this is a LOCAL feature (the server machine == the user's machine in
 *    `npm run dev`). On a headless/hosted deploy, use the Unipile connector instead.
 *  - We log in from the user's own IP (no proxy) — that's what LinkedIn expects for a human
 *    login and is the least suspicious. Per-account automation proxies stay as-is downstream.
 *  - The password is used transiently to fill the form and is never persisted or logged.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(512),
});

const AUTHED = /linkedin\.com\/(feed|in\/|mynetwork|messaging|jobs)/i;
const NOT_AUTHED = /\/(login|uas\/login|authwall|signup|checkpoint)\b/i;

export const loginWithLinkedIn = createServerFn({ method: "POST" })
  .inputValidator(LoginSchema)
  .handler(async ({ data }) => {
    const { chromium } = await import("playwright");
    const crypto = await import("node:crypto");
    const { promises: fsp } = await import("node:fs");
    const { profileDirFor, pickFingerprint, adoptCredentialLogin } =
      await import("./linkedin.session");

    // Persistent profile keyed by email, so a repeat login reuses the warmed-up browser
    // (and usually skips the challenge the second time).
    const emailHash = crypto
      .createHash("sha256")
      .update(data.email.trim().toLowerCase())
      .digest("hex")
      .slice(0, 16);
    const loginId = "login-" + emailHash;
    const userDataDir = profileDirFor(loginId);
    await fsp.mkdir(userDataDir, { recursive: true });

    // Launch the LOGIN browser with the same fingerprint the account will use for actions,
    // so the session is issued to — and later used from — one consistent context.
    // (pickFingerprint expects a hex id, so pass the raw hash, not the "login-" prefixed dir id.)
    const fp = pickFingerprint(emailHash);

    let context: any;
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        channel: process.env.LINKEDIN_BROWSER_CHANNEL || "chrome",
        headless: false, // visible — the user may need to solve 2FA / CAPTCHA here
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
          "--disable-dev-shm-usage",
        ],
        userAgent: fp.userAgent,
        viewport: fp.viewport,
        locale: fp.locale,
        timezoneId: fp.timezoneId,
      });
    } catch (e: any) {
      return {
        success: false as const,
        error:
          "Could not open the login browser. Make sure Chrome is installed and you're running locally. (" +
          String(e?.message || e).slice(0, 120) +
          ")",
      };
    }

    const page = context.pages()[0] ?? (await context.newPage());
    const looksAuthed = () => AUTHED.test(page.url()) && !NOT_AUTHED.test(page.url());

    try {
      // If this email's profile is already logged in, capture immediately.
      await page
        .goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 30_000 })
        .catch(() => {});

      if (!looksAuthed()) {
        await page.goto("https://www.linkedin.com/login", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await page.fill("#username", data.email.trim()).catch(() => {});
        await page.fill("#password", data.password).catch(() => {});
        await page.click("button[type='submit']").catch(() => {});
      }

      // Wait up to 3 minutes for an authenticated session. This window is where the user
      // completes any 2FA / CAPTCHA / email-verification LinkedIn throws up.
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        if (looksAuthed()) break;
        await new Promise((r) => setTimeout(r, 2_000));
      }

      if (!looksAuthed()) {
        const url = page.url();
        await context.close().catch(() => {});
        return {
          success: false as const,
          challenge: NOT_AUTHED.test(url),
          error:
            "Login didn't finish. If LinkedIn asked for a verification code or CAPTCHA, complete it in the window that opened, then try again. (stopped at " +
            url.slice(0, 70) +
            ")",
        };
      }

      // Read the session cookies with a short retry — li_at is httpOnly, can live on
      // .www.linkedin.com, and sometimes lags the feed render by a second or two. We read the
      // FULL cookie jar (no domain filter) and retry until both cookies appear.
      let li_at = "";
      let JSESSIONID = "";
      for (let i = 0; i < 8; i++) {
        const jar = await context.cookies();
        li_at = jar.find((c: any) => c.name === "li_at" && c.value)?.value || "";
        JSESSIONID = (
          jar.find((c: any) => c.name === "JSESSIONID" && c.value)?.value || ""
        ).replace(/^"|"$/g, "");
        if (li_at && JSESSIONID) break;
        await new Promise((r) => setTimeout(r, 1_500));
      }
      await context.close().catch(() => {});

      if (!li_at || !JSESSIONID) {
        return {
          success: false as const,
          error: "Logged in, but couldn't read the session cookies. Try the cookie method instead.",
        };
      }

      // Adopt this exact logged-in profile (same fingerprint, no proxy) as the account's
      // profile, so every later action runs from the same context the session was issued to.
      await new Promise((r) => setTimeout(r, 1_200)); // let Chromium release the profile lock
      try {
        await adoptCredentialLogin(li_at, JSESSIONID, fp, userDataDir);
      } catch {
        /* non-fatal — falls back to cookie re-seed in the account profile */
      }
      return { success: true as const, cookies: { li_at, JSESSIONID } };
    } catch (e: any) {
      await context.close().catch(() => {});
      return {
        success: false as const,
        error: "Login failed: " + String(e?.message || e).slice(0, 140),
      };
    }
  });
