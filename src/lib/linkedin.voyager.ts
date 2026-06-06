/**
 * linkedin.voyager.ts — the SINGLE hardened Voyager API client (SERVER ONLY).
 *
 * This is the chokepoint. Every engine (inbox, message, sync, connect, requests)
 * makes its LinkedIn API calls through `voyagerRequest()`. Fix a header / a bot
 * detection rule / a retry policy HERE and it's fixed everywhere. This is the
 * pattern PhantomBuster/Botdog use to stay reliable.
 *
 * Responsibilities owned here (so no engine reimplements them):
 *   - CSRF token derivation from JSESSIONID
 *   - Full required header set (Restli version, accept, lang, track)
 *   - Classification of every failure into a typed reason:
 *       ok | challenge | expired | rate_limited | blocked(999) | server | network
 *   - Retry with exponential backoff for transient failures (429/5xx/network)
 *   - NEVER auto-retries a challenge or expiry (those need human action)
 */

export type VoyagerReason =
  | "ok"
  | "challenge"
  | "expired"
  | "rate_limited"
  | "blocked"
  | "server"
  | "network";

export type VoyagerResult<T = any> = {
  reason: VoyagerReason;
  status: number;
  data?: T;
  /** human-facing explanation, already actionable */
  message: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sanitizeCsrf(jsessionid: string): string {
  return (jsessionid || "").trim().replace(/^"|"$/g, "");
}

/** The canonical header set LinkedIn's web client sends. */
export function voyagerHeaders(jsessionid: string, extra?: Record<string, string>) {
  return {
    accept: "application/vnd.linkedin.normalized+json+2.1",
    "csrf-token": sanitizeCsrf(jsessionid),
    "x-restli-protocol-version": "2.0.0",
    "x-li-lang": "en_US",
    "x-li-track":
      '{"clientVersion":"1.13.0","mpVersion":"1.13.0","osName":"web","timezoneOffset":0,"deviceFormFactor":"DESKTOP"}',
    ...(extra || {}),
  };
}

function humanMessage(reason: VoyagerReason, status: number): string {
  switch (reason) {
    case "challenge":
      return "LinkedIn security checkpoint. Clear it manually in a normal browser, then reconnect.";
    case "expired":
      return "Session expired (cookies stale). Grab a fresh li_at + JSESSIONID and reconnect.";
    case "rate_limited":
      return "Rate limited by LinkedIn — backing off. Slow down action volume.";
    case "blocked":
      return (
        "HTTP 999: LinkedIn anti-bot soft-block. This fires on automated requests from a " +
        "flagged/datacenter/home IP. Fix: attach a residential proxy in Stealth & Safety and " +
        "run non-headless. Code is correct — this is an environment block."
      );
    case "server":
      return `LinkedIn server error (HTTP ${status}).`;
    case "network":
      return "Network error reaching LinkedIn.";
    default:
      return "OK";
  }
}

function classify(status: number, location = ""): VoyagerReason {
  if (status >= 200 && status < 300) return "ok";
  if (status >= 300 && status < 400) {
    if (/\/login|\/uas\/login|\/authwall|\/signup/i.test(location)) return "expired";
    if (/\/checkpoint/i.test(location)) return "challenge";
    return "expired";
  }
  if (status === 999) return "blocked";
  if (status === 401 || status === 403) return "expired";
  if (status === 429) return "rate_limited";
  if (status === 451 || status === 999) return "blocked";
  if (status >= 500) return "server";
  // 4xx that often means a checkpoint redirect landing
  return "server";
}

export async function currentJsession(ctx: any, fallback: string): Promise<string> {
  try {
    const jar = await ctx.cookies("https://www.linkedin.com");
    return jar.find((c: any) => c.name === "JSESSIONID")?.value?.replace(/^"|"$/g, "") || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Make a hardened Voyager request through a Playwright context.request.
 * `ctx` is a Playwright BrowserContext (we use ctx.request — shares the cookie
 * jar, bypasses page CSP, not subject to the page's bot context).
 */
export async function voyagerRequest<T = any>(
  ctx: any,
  opts: {
    method?: "GET" | "POST";
    url: string;
    jsessionid: string;
    body?: any;
    headers?: Record<string, string>;
    /** max attempts for TRANSIENT failures (default 3) */
    retries?: number;
  },
): Promise<VoyagerResult<T>> {
  const method = opts.method ?? "GET";
  const maxAttempts = opts.retries ?? 3;
  const headers = voyagerHeaders(opts.jsessionid, opts.headers);

  let lastStatus = 0;
  let lastReason: VoyagerReason = "network";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res =
        method === "POST"
          ? await ctx.request.post(opts.url, { headers, data: opts.body, maxRedirects: 0 })
          : await ctx.request.get(opts.url, { headers, maxRedirects: 0 });

      const status = res.status();
      const reason = classify(status, res.headers()["location"] || "");
      lastStatus = status;
      lastReason = reason;

      if (reason === "ok") {
        let data: any = undefined;
        try {
          data = await res.json();
        } catch {
          data = undefined;
        }
        return { reason: "ok", status, data, message: "OK" };
      }

      // Non-retryable: human action required → fail immediately.
      if (reason === "challenge" || reason === "expired" || reason === "blocked") {
        return { reason, status, message: humanMessage(reason, status) };
      }

      // Retryable (rate_limited / server): backoff and try again.
      if (attempt < maxAttempts) {
        const backoff = 800 * 2 ** (attempt - 1) + Math.random() * 600;
        await sleep(backoff);
        continue;
      }
      return { reason, status, message: humanMessage(reason, status) };
    } catch (e) {
      // Network-level failure (DNS, TLS, ERR_TOO_MANY_REDIRECTS at API, etc.).
      lastReason = "network";
      lastStatus = 0;
      if (attempt < maxAttempts) {
        await sleep(700 * attempt);
        continue;
      }
      return {
        reason: "network",
        status: 0,
        message: "Network error: " + (e as Error).message.slice(0, 120),
      };
    }
  }
  return { reason: lastReason, status: lastStatus, message: humanMessage(lastReason, lastStatus) };
}
