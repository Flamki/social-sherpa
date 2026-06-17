/**
 * linkedin.browser.ts — shared patchright launch + session-validation helper (SERVER ONLY).
 * Every engine (sync, inbox, message) goes through openLinkedIn() so the stealth
 * config, cookie injection, and the /feed login-validation (the redirect-loop fix)
 * all live in ONE place.
 */
import type { AccountSession } from "./linkedin.session";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const jitter = (min: number, max: number) => min + Math.random() * (max - min);

function cleanBrowserError(value: unknown) {
  return String(value || "Unknown browser error")
    .replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "")
    .split(/\nCall log:/i)[0]
    .trim();
}

export type OpenResult =
  | {
      ok: true;
      context: any;
      page: any;
      account: AccountSession;
      persistCookies: () => Promise<void>;
    }
  | { ok: false; error: string; challenge?: boolean };

/**
 * Launch a stealth browser for an account, inject cookies, and validate the session
 * on /feed. Returns an open context+page on success, or a typed error on failure.
 * Callers MUST close context themselves on success.
 */
export async function openLinkedIn(opts: {
  cookies: { li_at: string; JSESSIONID: string };
  headless?: boolean;
}): Promise<OpenResult> {
  const { chromium } = await import("playwright");
  const { getOrCreateSession, startWarmup, profileDirFor, saveCookiesForAccount } =
    await import("./linkedin.session");
  const { attachProxyCleanup, browserProxyFor } = await import("./proxy.bridge");
  const { promises: fsp } = await import("node:fs");

  const { li_at, JSESSIONID } = opts.cookies;

  let account = await getOrCreateSession(li_at);
  account = await startWarmup(li_at);
  // Prefer the saved account cookies. Email/password login and successful browser opens can
  // refresh LinkedIn cookies on the server, while the client may still hold an older li_at.
  // Falling back to caller cookies still supports a brand-new manual cookie connect.
  const seedLiAt = account.cookies?.li_at || li_at || "";
  const seedJSESSIONID = account.cookies?.JSESSIONID || JSESSIONID || "";
  const fp = account.fingerprint;

  let proxyToUse = account.proxy;

  // Cookie injection helper — SINGLE parent-domain cookie only. Setting li_at on
  // both .linkedin.com AND .www.linkedin.com makes the browser send a duplicate
  // (li_at=X; li_at=X) which LinkedIn's security layer rejects → redirect loop.
  async function seedCookies(ctx: any, force = false) {
    const existing = await ctx.cookies("https://www.linkedin.com");
    const hasLiAt = existing.some((c: any) => c.name === "li_at" && c.value);
    if (hasLiAt && !force) return;

    const jsessionClean = seedJSESSIONID.trim().replace(/^"|"$/g, "");
    const jar = (account.cookieJar || [])
      .filter(
        (c: any) =>
          c?.name && c?.value && /linkedin\.com$/i.test(String(c.domain || "").replace(/^\./, "")),
      )
      .filter((c: any) => c.name !== "li_at" && c.name !== "JSESSIONID")
      .map((c: any) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        expires: typeof c.expires === "number" ? c.expires : undefined,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      }));
    if (jar.length) {
      await ctx.addCookies(jar);
    }
    await ctx.addCookies([
      { name: "li_at", value: seedLiAt.trim(), domain: ".linkedin.com", path: "/" },
      { name: "JSESSIONID", value: `"${jsessionClean}"`, domain: ".linkedin.com", path: "/" },
    ]);
  }

  async function captureFreshCookies(ctx: any) {
    const jar = await ctx.cookies("https://www.linkedin.com");
    const freshLiAt = jar.find((c: any) => c.name === "li_at")?.value;
    const freshJsession = jar
      .find((c: any) => c.name === "JSESSIONID")
      ?.value?.replace(/^"|"$/g, "");
    await saveCookiesForAccount(
      account.accountId,
      {
        li_at: freshLiAt,
        JSESSIONID: freshJsession,
      },
      undefined,
      jar,
    );
  }

  // --- Launch with proxy, but gracefully fall back on AUTH failure only (407) ---
  // Tunnel failures (node down) should NOT fallback to direct — IP mismatch breaks cookies.
  let context: any = null;
  let proxyOptToUse: any = undefined;

  async function launchContext() {
    const bridge = await browserProxyFor(proxyToUse);
    proxyOptToUse = bridge.proxy;
    // PERSISTENT per-account profile (the Botdog model): the browser stays "logged in" on
    // disk across runs, so LinkedIn's rotated li_at is kept and the session self-refreshes —
    // no constant cookie re-pasting. The profile is wiped ONLY on the intentional
    // redirect-loop recovery below, never on a normal close.
    const userDataDir = profileDirFor(account.accountId);
    await fsp.mkdir(userDataDir, { recursive: true });

    const launchOptions = {
      channel: process.env.LINKEDIN_BROWSER_CHANNEL || "chrome",
      headless: opts.headless ?? true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        `--window-size=${fp.viewport.width},${fp.viewport.height}`,
      ],
      proxy: proxyOptToUse,
      userAgent: fp.userAgent,
      viewport: fp.viewport,
      locale: fp.locale,
      timezoneId: fp.timezoneId,
      deviceScaleFactor: 1,
    };

    // launchPersistentContext locks the profile dir. If another task for this account is
    // holding it, wait briefly and retry instead of failing — keeps one browser per account.
    let lastErr: any;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const ctx = await chromium.launchPersistentContext(userDataDir, launchOptions);
        attachProxyCleanup(ctx, async () => {
          await bridge.cleanup();
          // Do NOT delete userDataDir — persistence across runs is the whole point.
        });
        return ctx;
      } catch (e: any) {
        lastErr = e;
        const locked =
          /SingletonLock|ProcessSingleton|already in use|being used|EBUSY|in use by|cannot create/i.test(
            String(e?.message || e),
          );
        if (!locked || attempt === 3) break;
        await sleep(1500 + attempt * 1000);
      }
    }
    await bridge.cleanup();
    throw lastErr;
  }

  try {
    context = await launchContext();
  } catch (e: any) {
    const msg = cleanBrowserError(e?.message || e);
    return {
      ok: false,
      error:
        (proxyOptToUse
          ? "Could not launch browser with the saved proxy: "
          : "Could not launch browser: ") + msg,
    };
  }

  if (!context) {
    return { ok: false, error: "Browser launch failed (no context)" };
  }

  await seedCookies(context);
  let page = context.pages()[0] ?? (await context.newPage());

  // Navigate to /feed, with a one-time profile-wipe retry on ERR_TOO_MANY_REDIRECTS.
  // Leftover state in the persistent profile is the usual cause of a 2nd-run loop;
  // wiping the profile dir and re-launching clean fixes it.
  let resp: any = null;
  let redirectLooped = false;
  let rotatedProxyAfterTunnelFail = false;
  let recoveredAfterTunnelFail = false;

  async function recoverTimedOutNavigation(errorMessage: string) {
    if (!/Timeout \d+ms exceeded/i.test(errorMessage)) return false;
    await sleep(1500);
    const currentUrl = page.url();
    if (
      !/^https:\/\/([a-z0-9-]+\.)?linkedin\.com\//i.test(currentUrl) ||
      /\/(login|uas\/login|authwall|signup|checkpoint)\b/i.test(currentUrl)
    ) {
      return false;
    }
    return page
      .evaluate(() => {
        const bodyStarted = Boolean(document.body && document.body.childElementCount > 0);
        const authenticatedShell = Boolean(
          document.querySelector("#global-nav") ||
          document.querySelector(".global-nav__me") ||
          document.querySelector("img.global-nav__me-photo") ||
          document.querySelector("[data-control-name='nav.settings']") ||
          document.querySelector("main.scaffold-layout__main"),
        );
        return bodyStarted || authenticatedShell;
      })
      .catch(() => false);
  }

  try {
    resp = await page.goto("https://www.linkedin.com/feed/", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
  } catch (e: any) {
    const msg = cleanBrowserError(e?.message || e);
    redirectLooped = msg.includes("ERR_TOO_MANY_REDIRECTS");
    const recoveredAfterNavigationTimeout = await recoverTimedOutNavigation(msg);

    const isProxyTunnelFail =
      msg.includes("ERR_TUNNEL_CONNECTION_FAILED") ||
      msg.includes("tunnel") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("ETIMEDOUT") ||
      msg.includes("ERR_CONNECTION_TIMED_OUT");

    // Tunnel failure = proxy node issue. DO NOT fallback to direct (IP mismatch breaks cookies).
    // Surface the error so user can retry or wait for node recovery.
    if (isProxyTunnelFail) {
      if (
        process.env.LINKEDIN_PROXY_ROTATE_ON_TUNNEL_FAIL === "true" &&
        !rotatedProxyAfterTunnelFail &&
        account.proxySource === "auto"
      ) {
        rotatedProxyAfterTunnelFail = true;
        await context.close().catch(() => {});
        const { rotateAutoProxySession } = await import("./linkedin.session");
        const rotatedProxy = await rotateAutoProxySession(account.accountId);
        if (rotatedProxy) {
          proxyToUse = rotatedProxy;
          context = await launchContext();
          await seedCookies(context, true);
          page = context.pages()[0] ?? (await context.newPage());
          try {
            resp = await page.goto("https://www.linkedin.com/feed/", {
              waitUntil: "domcontentloaded",
              timeout: 45_000,
            });
            redirectLooped = false;
            recoveredAfterTunnelFail = true;
            // Recovered after rotating the sticky proxy session; continue validation below.
          } catch (retryError: any) {
            await context.close().catch(() => {});
            return {
              ok: false,
              error:
                "Proxy tunnel to LinkedIn failed even after rotating the IPRoyal sticky session. " +
                cleanBrowserError(retryError?.message || retryError).slice(0, 120),
            };
          }
        }
      }
      if (!resp) {
        await context.close().catch(() => {});
        const providerHint = proxyOptToUse
          ? "The proxy can be alive but still block LinkedIn/restricted targets; with IPRoyal this usually means identity verification is required on the proxy dashboard. I will not fall back to host IP because that changes the account's IP."
          : "The direct network could not reach LinkedIn.";
        return {
          ok: false,
          error:
            "Proxy tunnel to LinkedIn failed. " + providerHint + " (" + msg.slice(0, 100) + ")",
        };
      }
    }

    if (!redirectLooped && !recoveredAfterTunnelFail && !recoveredAfterNavigationTimeout) {
      await context.close().catch(() => {});
      return { ok: false, error: "Could not reach LinkedIn: " + msg };
    }
    if (recoveredAfterNavigationTimeout) {
      console.warn(
        `[linkedin-browser] Feed navigation exceeded 45s but loaded a usable page at ${page.url()}`,
      );
    }
  }

  if (redirectLooped) {
    // Nuke the persistent profile and try once more WITH THE SAME PROXY.
    // Redirect loop = profile state corruption, not IP issue.
    await context.close().catch(() => {});
    try {
      const { promises: fsp } = await import("node:fs");
      await fsp.rm(profileDirFor(account.accountId), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    context = await launchContext();
    await seedCookies(context, true);
    page = context.pages()[0] ?? (await context.newPage());
    try {
      resp = await page.goto("https://www.linkedin.com/feed/", {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
    } catch (e) {
      const retryMessage = cleanBrowserError((e as Error).message);
      if (await recoverTimedOutNavigation(retryMessage)) {
        console.warn(
          `[linkedin-browser] Clean-profile feed navigation exceeded 45s but loaded a usable page at ${page.url()}`,
        );
      } else {
        await context.close().catch(() => {});
        return {
          ok: false,
          error:
            "Still looping after a clean profile retry — cookies may be stale/invalid. " +
            "Grab a FRESH li_at + JSESSIONID from a logged-in linkedin.com tab and connect again. (" +
            retryMessage.slice(0, 60) +
            ")",
        };
      }
    }
  }

  await sleep(jitter(1200, 2500));

  const landed = page.url();
  if (landed.includes("/checkpoint/")) {
    await context.close().catch(() => {});
    return {
      ok: false,
      challenge: true,
      error:
        "LinkedIn presented a security checkpoint. Clear it manually in a normal browser, " +
        "then re-connect with fresh cookies.",
    };
  }
  // Login detection from the URL ONLY. Do NOT use HTTP status: LinkedIn returns
  // 999 (anti-bot) to automated requests on a perfectly valid, logged-in feed —
  // treating >=400 as logged-out was a false positive that broke valid sessions.
  const urlSaysLoggedOut =
    landed.includes("/login") ||
    landed.includes("/uas/login") ||
    landed.includes("/authwall") ||
    landed.includes("/signup");

  // Confirm with the DOM: a logged-in feed has the global nav / "me" menu.
  let domLoggedIn = false;
  try {
    domLoggedIn = await page.evaluate(() => {
      return !!(
        document.querySelector("#global-nav") ||
        document.querySelector(".global-nav__me") ||
        document.querySelector("img.global-nav__me-photo") ||
        document.querySelector("[data-control-name='nav.settings']") ||
        document.querySelector("main.scaffold-layout__main") ||
        /\/feed\/?$/.test(location.pathname)
      );
    });
  } catch {
    domLoggedIn = false;
  }

  const loggedOut = urlSaysLoggedOut || !domLoggedIn;
  if (loggedOut) {
    await context.close().catch(() => {});
    return {
      ok: false,
      error:
        "Cookies are stale / not logged in (couldn't confirm a logged-in feed). Grab a FRESH " +
        "li_at + JSESSIONID from a logged-in linkedin.com tab and connect again. Landed on: " +
        landed.slice(0, 80),
    };
  }

  await captureFreshCookies(context).catch(() => {});
  return { ok: true, context, page, account, persistCookies: () => captureFreshCookies(context) };
}

export { sleep };
