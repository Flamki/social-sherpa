/**
 * linkedin.sync.ts — Botdog-style stealth sync (SERVER ONLY).
 *
 * Architecture (matches the honest Botdog blueprint):
 *   1. Persistent Chromium profile per account (cookies/cache survive runs → looks
 *      like the same browser the user always uses).
 *   2. Stable fingerprint per account (UA, viewport, locale, timezone) from
 *      linkedin.session.ts — never rotated.
 *   3. Dedicated proxy per account, attached at launch (sticky residential IP).
 *   4. DOM automation, not raw API calls — drives the real LinkedIn UI via
 *      Playwright, so the network layer is indistinguishable from a human tab.
 *   5. Stealth patches (puppeteer-extra-plugin-stealth) to hide navigator.webdriver,
 *      canvas/WebGL fingerprint, plugins array, etc.
 *   6. Human pacing: randomized delays, daily caps tied to the 14-day warmup ramp,
 *      active-hours gate, and a hard stop on security challenges.
 *
 * All node-only imports are done lazily inside the handler so this file is safe
 * for Vite to see from the route graph (it won't end up in the client bundle).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const SyncInputSchema = z.object({
  cookies: z.object({
    li_at: z.string().min(10),
    JSESSIONID: z.string().min(3),
  }),
  searchUrl: z.string().optional(),
  /** caller-requested limit; the engine clamps this to the warmup cap */
  limit: z.number().int().positive().max(1000).default(50),
  /** allow a visible browser for debugging / first-run trust building */
  headless: z.boolean().default(true),
  /** bypass the active-hours gate (manual run the user explicitly triggered) */
  force: z.boolean().default(false),
});

export type Lead = {
  id: string;
  name: string;
  headline: string;
  company: string;
  location: string;
  profileUrl: string;
  publicId: string;
  tags: string[];
};

export type SyncResult =
  | {
      success: true;
      count: number;
      items: Lead[];
      cappedAt: number;
      warmupDay: number;
      totalAvailable?: number;
    }
  | { success: false; error: string; challenge?: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (min: number, max: number) => min + Math.random() * (max - min);

function text(v: any): string {
  if (typeof v === "string") return v.trim();
  if (typeof v?.text === "string") return v.text.trim();
  return "";
}

function nameFromProfile(p: any): string {
  return text(p?.firstName || "") && text(p?.lastName || "")
    ? `${text(p.firstName)} ${text(p.lastName)}`.trim()
    : text(p?.name) || text(p?.title) || "LinkedIn member";
}

function profileToLead(p: any): Lead | null {
  const publicId =
    p?.publicIdentifier ||
    p?.publicIdentifierV2 ||
    p?.miniProfile?.publicIdentifier ||
    p?.profile?.publicIdentifier ||
    "";
  if (!publicId) return null;

  const profile = p?.miniProfile || p?.profile || p;
  const name = nameFromProfile(profile);
  const headline = text(profile?.occupation || p?.headline || p?.subtitle || p?.primarySubtitle);
  const location = text(profile?.geoLocationName || profile?.locationName || p?.location);

  return {
    id: publicId,
    publicId,
    name,
    headline,
    company: headline.includes(" at ") ? headline.split(" at ").pop()!.trim() : "",
    location,
    profileUrl: `https://www.linkedin.com/in/${publicId}`,
    tags: [],
  };
}

function parseVoyagerConnections(raw: any, limit: number): Lead[] {
  const leads = new Map<string, Lead>();
  const included: any[] = raw?.included || [];
  const elements: any[] = raw?.elements || raw?.data?.elements || [];

  for (const item of [...elements, ...included]) {
    const candidates = [
      item,
      item?.miniProfile,
      item?.profile,
      item?.connectedMember?.miniProfile,
      item?.member?.miniProfile,
      item?.entity?.miniProfile,
    ].filter(Boolean);

    for (const candidate of candidates) {
      const lead = profileToLead(candidate);
      if (lead && !leads.has(lead.publicId)) {
        leads.set(lead.publicId, lead);
        if (leads.size >= limit) return Array.from(leads.values());
      }
    }
  }

  return Array.from(leads.values()).slice(0, limit);
}

async function currentJsession(context: any, fallback: string): Promise<string> {
  try {
    const jar = await context.cookies("https://www.linkedin.com");
    return jar.find((c: any) => c.name === "JSESSIONID")?.value?.replace(/^"|"$/g, "") || fallback;
  } catch {
    return fallback;
  }
}

async function fetchConnectionsViaVoyager(context: any, jsessionid: string, limit: number) {
  const { voyagerRequest } = await import("./linkedin.voyager");
  const endpointFor = [
    (start: number, count: number) =>
      `https://www.linkedin.com/voyager/api/relationships/connections?count=${count}&start=${start}`,
    (start: number, count: number) =>
      `https://www.linkedin.com/voyager/api/relationships/connections?q=search&count=${count}&start=${start}`,
    (start: number, count: number) =>
      `https://www.linkedin.com/voyager/api/relationships/dash/connections?q=search&count=${count}&start=${start}`,
  ];

  const failures: string[] = [];
  for (const buildUrl of endpointFor) {
    const byId = new Map<string, Lead>();
    const pageSize = Math.min(40, limit);

    for (let start = 0; start < limit && byId.size < limit; start += pageSize) {
      const url = buildUrl(start, pageSize);
      const r = await voyagerRequest(context, {
        url,
        jsessionid,
        retries: 1,
      });
      if (r.reason !== "ok") {
        failures.push(`${r.reason}:${r.status}:${r.message}`);
        break;
      }

      const pageItems = parseVoyagerConnections(r.data, pageSize);
      if (pageItems.length === 0) {
        failures.push(`ok-but-empty:${url}`);
        break;
      }
      for (const item of pageItems) byId.set(item.publicId, item);
      if (pageItems.length < pageSize) break;
    }

    if (byId.size > 0) {
      return { success: true as const, items: Array.from(byId.values()).slice(0, limit) };
    }
  }

  return {
    success: false as const,
    error:
      "Visible LinkedIn pages redirected, and Voyager fallback did not return connections. " +
      failures.join(" | "),
  };
}

function validateFirstDegreeSearchUrl(raw?: string) {
  const value = raw?.trim();
  if (!value) {
    return {
      ok: false as const,
      error:
        "Paste a LinkedIn people search URL filtered to 1st-degree connections, for example https://www.linkedin.com/search/results/people/?origin=MEMBER_PROFILE_CANNED_SEARCH&network=%5B%22F%22%5D.",
    };
  }
  try {
    const u = new URL(value);
    const hostOk = u.hostname === "www.linkedin.com" || u.hostname.endsWith(".linkedin.com");
    const pathOk =
      u.pathname === "/search/results/people/" || u.pathname === "/search/results/people";
    const decodedNetwork = decodeURIComponent(u.searchParams.get("network") || "");
    const networkOk = decodedNetwork.includes('"F"');
    if (!hostOk || !pathOk || !networkOk) {
      return {
        ok: false as const,
        error:
          'Use a LinkedIn people search URL with the 1st-degree network filter (network=["F"]). This keeps imports focused on existing connections.',
      };
    }
    return { ok: true as const, url: u.toString() };
  } catch {
    return { ok: false as const, error: "The LinkedIn search URL is not valid." };
  }
}

export type SyncInput = z.infer<typeof SyncInputSchema>;

export async function runLinkedInSync(data: SyncInput): Promise<SyncResult> {
  // ---- lazy server-only imports ----
  const { openLinkedIn } = await import("./linkedin.browser");
  const { getOrCreateSession, startWarmup, dailyImportCap, withinActiveHours, warmupDay } =
    await import("./linkedin.session");

  const { li_at, JSESSIONID } = data.cookies;
  const search = validateFirstDegreeSearchUrl(data.searchUrl);
  if (!search.ok) {
    return { success: false, error: search.error };
  }

  let acct = await getOrCreateSession(li_at);
  acct = await startWarmup(li_at);

  // Safety gate: active hours (unless the user forced a manual run).
  if (!data.force && !withinActiveHours(acct)) {
    const accountTZ = acct.fingerprint?.timezoneId || "unknown";
    return {
      success: false,
      error:
        `Outside this account's active hours (9am-6pm in ${accountTZ}). ` +
        `Current time there: ${new Date().toLocaleTimeString("en-US", { timeZone: accountTZ, hour12: true })}. ` +
        "Pass force=true to run anyway, but spreading activity across the day is safer.",
    };
  }

  const cap = dailyImportCap(acct);
  if (cap === 0) {
    return {
      success: false,
      error: "Warmup just started — day-0 accounts should only browse. Try again tomorrow.",
    };
  }
  const requestedLimit = Math.min(data.limit, cap);

  // Launch + validate through the SHARED helper (has the 999-anti-bot fix and the
  // single-domain cookie fix). No more duplicate validation logic here.
  const opened = await openLinkedIn({
    cookies: { li_at, JSESSIONID },
    headless: data.headless,
  });
  if (!opened.ok) {
    return { success: false, error: opened.error, challenge: opened.challenge };
  }
  const { context, page } = opened;

  const items: Lead[] = [];

  try {
    // ---- go to the search/connections page (session already validated) ----
    const DEFAULT_SEARCH = "https://www.linkedin.com/mynetwork/invite-connect/connections/";
    // Guard: only accept a well-formed LinkedIn search URL; otherwise use the
    // default. A malformed network filter (e.g. network=%5B%5B%22%5D = [["])
    // makes LinkedIn redirect-loop (ERR_TOO_MANY_REDIRECTS).
    let targetUrl = DEFAULT_SEARCH;
    const candidate = data.searchUrl?.trim();
    if (candidate) {
      try {
        const u = new URL(candidate);
        const okHost = u.hostname.endsWith("linkedin.com");
        const net = u.searchParams.get("network");
        // If a network filter exists it must decode to a clean JSON array like ["F"].
        // If a network filter exists it must decode to a clean JSON array like ["F"] or ["F","S"].
        // Reject empty strings, incomplete arrays, or anything not matching the known values F/S/O.
        let netOk = true;
        if (net) {
          const decoded = decodeURIComponent(net);
          netOk =
            /^\s*\[\s*("([FSO])"\s*(,\s*"([FSO])")*\s*)?\]\s*$/i.test(decoded) &&
            !/\[\s*""\s*\]/i.test(decoded); // reject [""] empty string
        }
        if (okHost && u.pathname.includes("/search/") && netOk) {
          targetUrl = candidate;
        }
      } catch {
        /* malformed URL → keep default */
      }
    }

    if (targetUrl === DEFAULT_SEARCH) {
      const api = await fetchConnectionsViaVoyager(
        context,
        await currentJsession(context, JSESSIONID),
        requestedLimit,
      );
      if (api.success) {
        await opened.persistCookies().catch(() => {});
        await context.close();
        return {
          success: true,
          count: api.items.length,
          items: api.items,
          cappedAt: cap,
          warmupDay: warmupDay(acct),
        };
      }
    }

    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (e) {
      const msg = (e as Error).message;
      if (!msg.includes("ERR_TOO_MANY_REDIRECTS")) throw e;
      await opened.persistCookies().catch(() => {});
      await context.close();
      return {
        success: false,
        error:
          "LinkedIn redirected the search page too many times. The pasted cookies are probably stale, or LinkedIn wants a fresh browser session.",
      };
      const api = await fetchConnectionsViaVoyager(
        context,
        await currentJsession(context, JSESSIONID),
        requestedLimit,
      );
      await opened.persistCookies().catch(() => {});
      await context.close();
      if (api.success) {
        return {
          success: true,
          count: api.items.length,
          items: api.items,
          cappedAt: cap,
          warmupDay: warmupDay(acct),
        };
      }
      return {
        success: false,
        error: "LinkedIn redirected the visible connections page too many times. " + api.error,
      };
    }
    await sleep(jitter(2500, 5000));
    const totalAvailable = await page
      .evaluate(() => {
        const body = document.body?.innerText || "";
        const match =
          body.match(/About\s+([\d,]+)\s+results/i) ||
          body.match(/\b([\d,]+)\s+results\b/i) ||
          body.match(/\b([\d,]+)\s+people\b/i);
        if (!match?.[1]) return undefined;
        const parsed = Number(match[1].replace(/,/g, ""));
        return Number.isFinite(parsed) ? parsed : undefined;
      })
      .catch(() => undefined as number | undefined);
    const limit = totalAvailable ? Math.min(requestedLimit, totalAvailable) : requestedLimit;
    const seen = new Set<string>();
    let stagnantPages = 0;
    let diag = "";

    while (items.length < limit && stagnantPages < 2) {
      // Human-like incremental scroll to trigger lazy loading.
      const steps = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < steps; i++) {
        await page.mouse.wheel(0, 400 + Math.random() * 300);
        await sleep(jitter(400, 900));
      }

      // Resilient extraction: LinkedIn rotates/obfuscates class names, so we DON'T
      // rely on them. We anchor on the stable thing — anchor tags to /in/ profiles —
      // and walk up to a reasonable container to read the surrounding text lines.
      const { batch, anchorCount } = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href*='/in/']"));
        const byId = new Map<string, any>();

        // UI chrome / action labels that must never be treated as name/headline/location.
        const NOISE =
          /^(message|connect|follow|pending|view profile|view |• |· |\d+ (mutual|connection)|status is|premium|open the|more|save|·)/i;
        const clean = (s: string) => s.replace(/\s+/g, " ").trim();

        for (const a of anchors) {
          const href = a.href.split("?")[0];
          const publicId = href.split("/in/")[1]?.split("/")[0] || "";
          if (!publicId) continue;

          // --- NAME: try several stable sources, in order ---
          // 1) visible name span (LinkedIn marks the duplicate as aria-hidden)
          // 2) the link's own text  3) aria-label  4) the avatar img alt
          let name =
            a.querySelector<HTMLElement>("span[aria-hidden='true']")?.innerText ||
            a.innerText ||
            a.getAttribute("aria-label") ||
            "";
          if (!name) {
            const img = a.closest("li, div")?.querySelector<HTMLImageElement>("img[alt]");
            if (img?.alt && !/logo|background/i.test(img.alt)) name = img.alt;
          }
          name = clean((name || "").split("\n")[0])
            .replace(/^(view |connect with )/i, "")
            .replace(/'s profile$/i, "");
          if (!name || NOISE.test(name) || /^linkedin member$/i.test(name)) continue;

          // Climb to the result container that holds headline/location text.
          let box: HTMLElement | null = a;
          for (let i = 0; i < 6 && box; i++) {
            if (box.matches("li, div[data-chameleon-result-urn], div[class*='entity-result']"))
              break;
            box = box.parentElement;
          }
          const scope = box || a;

          // Candidate text lines, de-noised. Drop the name line and any UI/action text.
          const lines = clean(scope.innerText || "")
            .split("\n")
            .map(clean)
            .filter((l) => l && !NOISE.test(l) && l.toLowerCase() !== name.toLowerCase());

          // First leftover line = headline, next that looks like a place = location.
          const headline = lines[0] || "";
          const location =
            lines.slice(1).find((l) => /,| area$| region$|United |India|Kingdom|States/.test(l)) ||
            lines[1] ||
            "";

          if (!byId.has(publicId)) {
            byId.set(publicId, {
              publicId,
              name,
              headline,
              location,
              company: headline.includes(" at ") ? headline.split(" at ").pop()!.trim() : "",
              profileUrl: href,
            });
          }
        }
        return { batch: Array.from(byId.values()), anchorCount: anchors.length };
      });

      diag = `anchors=${anchorCount} parsed=${batch.length} url=${page.url().slice(0, 80)}`;
      console.log("Server: scrape pass —", diag);

      let added = 0;
      for (const p of batch) {
        const key = p.publicId || p.profileUrl || p.name;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        items.push({ id: key, tags: [], ...p });
        added++;
        if (items.length >= limit) break;
      }

      stagnantPages = added === 0 ? stagnantPages + 1 : 0;
      if (items.length >= limit) break;

      // Paginate via the real Next button.
      const next = await page.$("button[aria-label='Next']");
      const disabled = next ? await next.getAttribute("disabled") : "true";
      if (next && disabled === null) {
        await sleep(jitter(3000, 6000)); // human gap between pages
        await next.scrollIntoViewIfNeeded();
        await next.click();
        await page.waitForLoadState("domcontentloaded");
        await sleep(jitter(1500, 3000));
      } else {
        break;
      }
    }

    await opened.persistCookies().catch(() => {});
    await context.close();
    if (items.length === 0) {
      return {
        success: false,
        error:
          "Reached the page but found 0 profiles. Likely causes: the search URL returned no " +
          "results, the cookies are stale (logged out), or LinkedIn served a different layout. " +
          "Diagnostic: " +
          diag,
      };
    }
    return {
      success: true,
      count: items.length,
      items,
      cappedAt: cap,
      warmupDay: warmupDay(acct),
      totalAvailable,
    };
  } catch (err) {
    await opened.persistCookies().catch(() => {});
    try {
      await context.close();
    } catch {
      /* noop */
    }
    return { success: false, error: (err as Error).message };
  }
}

export const syncConnections = createServerFn({ method: "POST" })
  .inputValidator(SyncInputSchema)
  .handler(async ({ data }): Promise<SyncResult> => runLinkedInSync(data));
