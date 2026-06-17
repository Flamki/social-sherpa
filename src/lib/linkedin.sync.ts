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
  /** user explicitly requested a larger read-only import than the warmup recommendation */
  bypassWarmupImportCap: z.boolean().default(false),
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
  /** Profile photo URL, built from LinkedIn's VectorImage packet. Free — already in the data. */
  picture?: string;
  /** Banner/cover image URL behind the profile. Free — already in the data. */
  backgroundImage?: string;
  /** Epoch ms of when you connected (when LinkedIn includes it on the record). */
  connectedAt?: number;
  /** LinkedIn flag for a deceased member's account. */
  memorialized?: boolean;
  /** LinkedIn internal IDs — only useful for making further LinkedIn calls, not for display. */
  entityUrn?: string;
  objectUrn?: string;
  trackingId?: string;
};

export type ImportDiagnostic = {
  source: "voyager" | "visible";
  stopReason: string;
  pagesVisited: number;
  uniqueFound: number;
  lastPageAdded?: number;
  lastParsedCount?: number;
  lastAnchorCount?: number;
  lastUrl?: string;
  details?: string;
};

export type SyncProgress = {
  items: Lead[];
  importedCount: number;
  requestedCount: number;
  pagesVisited: number;
  source: "voyager" | "visible";
};

type SyncProgressHandler = (progress: SyncProgress) => void | Promise<void>;

export type SyncResult =
  | {
      success: true;
      count: number;
      items: Lead[];
      cappedAt: number;
      warmupDay: number;
      totalAvailable?: number;
      requestedCount?: number;
      effectiveLimit?: number;
      capBypassed?: boolean;
      diagnostic?: ImportDiagnostic;
    }
  | { success: false; error: string; challenge?: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (min: number, max: number) => min + Math.random() * (max - min);

function text(v: any): string {
  if (typeof v === "string") return v.trim();
  if (typeof v?.text === "string") return v.text.trim();
  if (typeof v?.value === "string") return v.value.trim();
  return "";
}

function nameFromProfile(p: any): string {
  const parts = [text(p?.firstName), text(p?.lastName)].filter(Boolean);
  return (
    parts.join(" ") || text(p?.name) || text(p?.title) || text(p?.actorName) || "LinkedIn member"
  );
}

function publicIdFromUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const match = value.match(/(?:https?:\/\/(?:[\w-]+\.)?linkedin\.com)?\/in\/([^/?#]+)/i);
  if (!match?.[1]) return "";
  try {
    return decodeURIComponent(match[1]).trim();
  } catch {
    return match[1].trim();
  }
}

// Pull a clean company name out of a headline like "Senior Engineer at NVIDIA | PMP | AWS"
// or "Co-Founder & CEO at NodeOps. Building CreateOS...". We take the text after the FIRST
// " at " and cut at the first separator (pipe, dot/bullet, dash, sentence break, paren) so
// the company cell holds just "NVIDIA" / "NodeOps", not the rest of the tagline.
function companyFromHeadline(headline: string): string {
  if (!headline) return "";
  const m = headline.match(/\s+at\s+(.+)/i);
  if (!m) return "";
  const tail = m[1].split(/\s*[|·•\n]\s*|\s[—–-]\s|\.\s|\s*\(/)[0] || "";
  return tail.replace(/[\s,;.|·•—–-]+$/, "").trim();
}

// LinkedIn ships images as a "VectorImage": a rootUrl plus size variants (artifacts).
// The usable URL is rootUrl + a variant's path segment. We prefer ~200px, falling back to
// the next-best available size. Returns "" when no image is present.
function vectorImageUrl(img: any): string {
  const v = img?.["com.linkedin.common.VectorImage"] || img;
  const root = text(v?.rootUrl);
  const artifacts = Array.isArray(v?.artifacts) ? v.artifacts : [];
  if (!root || artifacts.length === 0) return "";
  const pick =
    artifacts.find((a: any) => a?.width === 200) ||
    artifacts.find((a: any) => a?.width === 100) ||
    artifacts[artifacts.length - 1];
  const segment = text(pick?.fileIdentifyingUrlPathSegment);
  return segment ? root + segment : "";
}

// LinkedIn's people-search results carry a degree badge ("Name • 1st") and the search
// walker can pick up a blob that mashes several result cards together. Strip the badge
// from names, and detect a headline that is actually a multi-card blob so we don't store it.
const DEGREE_BADGE = /\s*[•·]\s*(1st|2nd|3rd)\b/gi;
function stripDegreeBadge(name: string): string {
  return name.replace(DEGREE_BADGE, " ").replace(/\s+/g, " ").trim();
}
function headlineLooksCorrupt(headline: string): boolean {
  if (!headline) return false;
  return (
    /\bmutual connections?\b/i.test(headline) ||
    /[•·]\s*(1st|2nd|3rd)\b/i.test(headline) || // a degree badge inside a headline = concatenated cards
    headline.length > 300
  );
}

function profileToLead(p: any): Lead | null {
  const publicId =
    text(p?.publicIdentifier) ||
    text(p?.publicIdentifierV2) ||
    text(p?.miniProfile?.publicIdentifier) ||
    text(p?.profile?.publicIdentifier) ||
    publicIdFromUrl(p?.navigationUrl) ||
    publicIdFromUrl(p?.profileUrl) ||
    publicIdFromUrl(p?.url) ||
    publicIdFromUrl(p?.actionTarget) ||
    publicIdFromUrl(p?.deeplink) ||
    "";
  if (!publicId) return null;

  const profile = p?.miniProfile || p?.profile || p;
  const name = stripDegreeBadge(nameFromProfile(profile));
  const rawHeadline =
    text(profile?.occupation) ||
    text(profile?.headline) ||
    text(p?.headline) ||
    text(p?.subtitle) ||
    text(p?.primarySubtitle);
  // A corrupt (multi-card) headline contaminates the row — drop it rather than store garbage.
  // The person is still saved cleanly via name + profile link.
  const headline = headlineLooksCorrupt(rawHeadline) ? "" : rawHeadline;
  const rawLocation =
    text(profile?.geoLocationName) ||
    text(profile?.locationName) ||
    text(profile?.geoLocation?.defaultLocalizedName) ||
    text(profile?.location?.basicLocation?.city) ||
    text(profile?.location) ||
    text(p?.location);
  const location = headlineLooksCorrupt(rawLocation) ? "" : rawLocation;

  const picture = vectorImageUrl(profile?.picture) || vectorImageUrl(p?.picture);
  const backgroundImage =
    vectorImageUrl(profile?.backgroundImage) || vectorImageUrl(p?.backgroundImage);
  const rawConnectedAt = Number(p?.createdAt ?? profile?.createdAt);
  const connectedAt = Number.isFinite(rawConnectedAt) ? rawConnectedAt : undefined;

  return {
    id: publicId,
    publicId,
    name,
    headline,
    company: companyFromHeadline(headline),
    location,
    profileUrl: `https://www.linkedin.com/in/${publicId}`,
    tags: [],
    picture,
    backgroundImage,
    connectedAt,
    memorialized: Boolean(profile?.memorialized),
    entityUrn: text(profile?.entityUrn) || text(p?.entityUrn),
    objectUrn: text(profile?.objectUrn) || text(p?.objectUrn),
    trackingId: text(profile?.trackingId) || text(p?.trackingId),
  };
}

function parseVoyagerConnections(raw: any, limit: number): Lead[] {
  const leads = new Map<string, Lead>();
  const visited = new Set<object>();
  const queue: Array<{ value: unknown; depth: number }> = [{ value: raw, depth: 0 }];

  // Voyager normalizes responses differently across accounts. Profiles can be
  // direct objects, typed-key wrappers, or nested under connection/member
  // entities. Walk the response tree instead of binding imports to one shape.
  while (queue.length > 0 && leads.size < limit) {
    const current = queue.shift()!;
    if (!current.value || typeof current.value !== "object") continue;
    if (visited.has(current.value as object)) continue;
    visited.add(current.value as object);

    if (!Array.isArray(current.value)) {
      const lead = profileToLead(current.value);
      if (lead && !leads.has(lead.publicId)) leads.set(lead.publicId, lead);
    }

    if (current.depth >= 8) continue;
    for (const child of Array.isArray(current.value)
      ? current.value
      : Object.values(current.value)) {
      if (child && typeof child === "object") {
        queue.push({ value: child, depth: current.depth + 1 });
      }
    }
  }

  return Array.from(leads.values()).slice(0, limit);
}

function voyagerShape(raw: any): string {
  const root = raw?.data || raw || {};
  const elements = root?.elements;
  const included = raw?.included || root?.included;
  const samples = [
    ...(Array.isArray(elements) ? elements.slice(0, 2) : []),
    ...(Array.isArray(included) ? included.slice(0, 2) : []),
  ];
  const sampleKeys = samples
    .map((item) =>
      item && typeof item === "object" ? Object.keys(item).slice(0, 8).join(",") : typeof item,
    )
    .filter(Boolean)
    .join(" | ");
  return [
    `rootKeys=${Object.keys(root).slice(0, 12).join(",") || "none"}`,
    `elements=${Array.isArray(elements) ? elements.length : "n/a"}`,
    `included=${Array.isArray(included) ? included.length : "n/a"}`,
    sampleKeys ? `sampleKeys=${sampleKeys}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

async function currentJsession(context: any, fallback: string): Promise<string> {
  try {
    const jar = await context.cookies("https://www.linkedin.com");
    return jar.find((c: any) => c.name === "JSESSIONID")?.value?.replace(/^"|"$/g, "") || fallback;
  } catch {
    return fallback;
  }
}

async function reportProgress(onProgress: SyncProgressHandler | undefined, progress: SyncProgress) {
  if (!onProgress) return;
  try {
    await onProgress(progress);
  } catch (error) {
    console.warn("[connections-import] Progress reporting failed:", (error as Error).message);
  }
}

async function gotoLinkedInPage(page: any, url: string): Promise<boolean> {
  try {
    await page.goto(url, { waitUntil: "commit", timeout: 20_000 });
    await sleep(jitter(2500, 4500));
    return true;
  } catch {
    try {
      const current = page.url();
      const usable = await page
        .evaluate(() => {
          const body = document.body?.innerText || "";
          return (
            body.length > 500 ||
            document.querySelectorAll("a[href*='/in/'], button, main").length > 0
          );
        })
        .catch(() => false);
      return /linkedin\.com/i.test(current) && usable;
    } catch {
      return false;
    }
  }
}

async function fetchConnectionsViaVoyager(
  context: any,
  jsessionid: string,
  limit: number,
  onProgress?: SyncProgressHandler,
) {
  const { voyagerRequest } = await import("./linkedin.voyager");
  const endpointFor = [
    (start: number, count: number) =>
      `https://www.linkedin.com/voyager/api/relationships/connections?count=${count}&start=${start}`,
    (start: number, count: number) =>
      `https://www.linkedin.com/voyager/api/relationships/connections?count=${count}&sortType=RECENTLY_ADDED&start=${start}`,
    (start: number, count: number) =>
      `https://www.linkedin.com/voyager/api/relationships/connections?q=search&count=${count}&start=${start}`,
    (start: number, count: number) =>
      `https://www.linkedin.com/voyager/api/relationships/dash/connections?q=search&count=${count}&start=${start}`,
  ];

  const failures: string[] = [];
  const allById = new Map<string, Lead>();
  let bestDiagnostic: ImportDiagnostic | undefined;
  // LinkedIn reports the account's full connection total on each page (paging.total).
  // Capture the largest seen so the UI can offer an exact "import all" count.
  let bestReportedTotal: number | undefined;
  for (const buildUrl of endpointFor) {
    const byId = new Map<string, Lead>();
    // LinkedIn often returns roughly 20 connection records even when asked for
    // more. Advancing by a requested count of 40 can skip records, and stopping
    // on a short page can incorrectly end at ~20 imports.
    const pageSize = Math.min(20, limit);
    let stagnantPages = 0;
    let pagesVisited = 0;
    let stopReason = "requested-limit-reached";
    let lastPageAdded = 0;
    let lastParsedCount = 0;
    let lastUrl = "";
    let reportedTotal: number | undefined;
    const maxSourceRows = Math.max(limit * 3, limit + 40);

    for (let start = 0; start < maxSourceRows && byId.size < limit && stagnantPages < 2; ) {
      const url = buildUrl(start, pageSize);
      lastUrl = url;
      const r = await voyagerRequest(context, {
        url,
        jsessionid,
        retries: 1,
      });
      pagesVisited++;
      if (r.reason !== "ok") {
        stopReason = "voyager-request-failed";
        failures.push(`${r.reason}:${r.status}:${r.message}`);
        break;
      }

      const pageItems = parseVoyagerConnections(r.data, pageSize);
      lastParsedCount = pageItems.length;
      if (pageItems.length === 0) {
        stopReason = "voyager-returned-empty-page";
        const shape = voyagerShape(r.data);
        failures.push(`ok-but-empty:${shape}`);
        console.warn(`[connections-import] Voyager returned no parsed profiles: ${shape}`);
        break;
      }
      const before = byId.size;
      for (const item of pageItems) {
        byId.set(item.publicId, item);
        allById.set(item.publicId, item);
      }
      lastPageAdded = byId.size - before;
      stagnantPages = byId.size === before ? stagnantPages + 1 : 0;
      await reportProgress(onProgress, {
        items: Array.from(allById.values()).slice(0, limit),
        importedCount: Math.min(allById.size, limit),
        requestedCount: limit,
        pagesVisited,
        source: "voyager",
      });
      const paging = r.data?.paging || r.data?.data?.paging;
      const pagingCount = Number(paging?.count);
      const pagingTotal = Number(paging?.total);
      if (Number.isFinite(pagingTotal) && pagingTotal >= 0) {
        reportedTotal = pagingTotal;
        bestReportedTotal = Math.max(bestReportedTotal ?? 0, pagingTotal);
      }
      const sourceStep =
        pageItems.length ||
        (Number.isFinite(pagingCount) && pagingCount > 0 ? pagingCount : 0) ||
        pageSize;
      start += Math.max(1, sourceStep);
      if (
        reportedTotal !== undefined &&
        start >= reportedTotal &&
        reportedTotal >= limit &&
        pageItems.length < pageSize
      ) {
        stopReason = "voyager-total-reached";
        break;
      }
      await sleep(pagesVisited >= 5 ? jitter(2500, 5000) : jitter(900, 1800));
    }

    if (byId.size > 0) {
      if (stagnantPages >= 2) stopReason = "voyager-pages-were-duplicates";
      if (byId.size >= limit) stopReason = "requested-limit-reached";
      const diagnostic: ImportDiagnostic = {
        source: "voyager",
        stopReason,
        pagesVisited,
        uniqueFound: byId.size,
        lastPageAdded,
        lastParsedCount,
        lastUrl,
        details: [
          reportedTotal !== undefined ? `reportedTotal=${reportedTotal}` : "",
          failures.at(-1) || "",
        ]
          .filter(Boolean)
          .join("; "),
      };
      if (!bestDiagnostic || diagnostic.uniqueFound > bestDiagnostic.uniqueFound) {
        bestDiagnostic = diagnostic;
      }
      if (allById.size >= limit) break;
    }
  }

  if (allById.size > 0) {
    return {
      success: true as const,
      items: Array.from(allById.values()).slice(0, limit),
      total: bestReportedTotal,
      diagnostic: {
        ...(bestDiagnostic || {
          source: "voyager" as const,
          stopReason: "voyager-endpoints-exhausted",
          pagesVisited: 0,
          uniqueFound: allById.size,
        }),
        uniqueFound: allById.size,
        stopReason:
          allById.size >= limit
            ? "requested-limit-reached"
            : bestDiagnostic?.stopReason || "voyager-endpoints-exhausted",
      },
    };
  }

  return {
    success: false as const,
    error:
      "Visible LinkedIn pages redirected, and Voyager fallback did not return connections. " +
      failures.join(" | "),
    diagnostic: {
      source: "voyager" as const,
      stopReason: failures.some((failure) => failure.startsWith("ok-but-empty"))
        ? "voyager-returned-empty-page"
        : "voyager-request-failed",
      pagesVisited: 0,
      uniqueFound: 0,
      details: failures.join(" | "),
    },
  };
}

async function fetchConnectionsViaSearchVoyager(
  context: any,
  jsessionid: string,
  limit: number,
  seed: Lead[],
  onProgress?: SyncProgressHandler,
) {
  const { voyagerRequest } = await import("./linkedin.voyager");
  const filters = encodeURIComponent("List(resultType->PEOPLE,network->F)");
  const query = encodeURIComponent(
    "(flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:resultType,value:List(PEOPLE)),(key:network,value:List(F))),includeFiltersInResponse:false)",
  );
  const endpointFor = [
    (start: number, count: number) =>
      `https://www.linkedin.com/voyager/api/search/blended?count=${count}&filters=${filters}&origin=MEMBER_PROFILE_CANNED_SEARCH&q=all&start=${start}`,
    (start: number, count: number) =>
      `https://www.linkedin.com/voyager/api/search/dash/clusters?count=${count}&origin=MEMBER_PROFILE_CANNED_SEARCH&q=all&query=${query}&start=${start}`,
  ];

  const byId = new Map<string, Lead>();
  for (const item of seed) byId.set(item.publicId, item);

  const failures: string[] = [];
  let pagesVisited = 0;
  let stopReason = "requested-limit-reached";
  let lastPageAdded = 0;
  let lastParsedCount = 0;
  let lastUrl = "";
  let bestUnique = byId.size;

  for (const buildUrl of endpointFor) {
    let stagnantPages = 0;
    const pageSize = 20;
    const maxSourceRows = Math.max(limit * 2, limit + 80);
    for (let start = 0; start < maxSourceRows && byId.size < limit && stagnantPages < 4; ) {
      const url = buildUrl(start, pageSize);
      lastUrl = url;
      const r = await voyagerRequest(context, {
        url,
        jsessionid,
        retries: 1,
      });
      pagesVisited++;
      if (r.reason !== "ok") {
        stopReason = "voyager-search-request-failed";
        failures.push(`${r.reason}:${r.status}:${r.message}`);
        break;
      }

      const pageItems = parseVoyagerConnections(r.data, pageSize);
      lastParsedCount = pageItems.length;
      if (pageItems.length === 0) {
        stopReason = "voyager-search-returned-empty-page";
        failures.push(`empty:${voyagerShape(r.data)}`);
        break;
      }

      const before = byId.size;
      for (const item of pageItems) {
        if (byId.size >= limit) break;
        byId.set(item.publicId, item);
      }
      lastPageAdded = byId.size - before;
      bestUnique = Math.max(bestUnique, byId.size);
      stagnantPages = lastPageAdded === 0 ? stagnantPages + 1 : 0;
      await reportProgress(onProgress, {
        items: Array.from(byId.values()).slice(0, limit),
        importedCount: Math.min(byId.size, limit),
        requestedCount: limit,
        pagesVisited,
        source: "voyager",
      });
      if (byId.size >= limit) {
        stopReason = "requested-limit-reached";
        break;
      }
      start += pageItems.length || pageSize;
      await sleep(pagesVisited >= 8 ? jitter(1600, 3200) : jitter(700, 1400));
    }
    if (byId.size >= limit) break;
  }

  return {
    success: byId.size > seed.length,
    items: Array.from(byId.values()).slice(0, limit),
    diagnostic: {
      source: "voyager" as const,
      stopReason: byId.size >= limit ? "requested-limit-reached" : stopReason,
      pagesVisited,
      uniqueFound: bestUnique,
      lastPageAdded,
      lastParsedCount,
      lastUrl,
      details: failures.join(" | "),
    },
  };
}

function partialImportResult({
  items,
  cap,
  warmupDayValue,
  requestedCount,
  effectiveLimit,
  capBypassed,
  diagnostic,
  reason,
}: {
  items: Lead[];
  cap: number;
  warmupDayValue: number;
  requestedCount: number;
  effectiveLimit: number;
  capBypassed: boolean;
  diagnostic?: ImportDiagnostic;
  reason: string;
}): Extract<SyncResult, { success: true }> {
  return {
    success: true,
    count: items.length,
    items,
    cappedAt: cap,
    warmupDay: warmupDayValue,
    requestedCount,
    effectiveLimit,
    capBypassed,
    diagnostic: {
      source: diagnostic?.source || "voyager",
      stopReason: "partial-import-kept",
      pagesVisited: diagnostic?.pagesVisited || 0,
      uniqueFound: items.length,
      lastPageAdded: diagnostic?.lastPageAdded,
      lastParsedCount: diagnostic?.lastParsedCount,
      lastAnchorCount: diagnostic?.lastAnchorCount,
      lastUrl: diagnostic?.lastUrl,
      details: [reason, diagnostic?.details].filter(Boolean).join("; "),
    },
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

export async function runLinkedInSync(
  data: SyncInput,
  onProgress?: SyncProgressHandler,
): Promise<SyncResult> {
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
  const capBypassed = data.bypassWarmupImportCap && data.limit > cap;
  const requestedLimit = capBypassed ? data.limit : Math.min(data.limit, cap);
  console.log(
    `[connections-import] requested=${data.limit} effective=${requestedLimit} warmupCap=${cap}` +
      `${capBypassed ? " capBypassed=true" : ""}`,
  );

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
  let apiDiagnostic: ImportDiagnostic | undefined;
  let searchApiDiagnostic: ImportDiagnostic | undefined;
  // LinkedIn's reported full connection total (paging.total), surfaced so the UI's
  // "import all" button can use the exact number instead of a flat maximum.
  let connectionTotal: number | undefined;

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

    // Fetch the account's actual first-degree connection collection first.
    // A visible people-search page can recycle results after several pages;
    // the connection collection is the authoritative source for a bulk import.
    const api = await fetchConnectionsViaVoyager(
      context,
      await currentJsession(context, JSESSIONID),
      requestedLimit,
      onProgress,
    );
    if (api.success) {
      apiDiagnostic = api.diagnostic;
      if (typeof api.total === "number") connectionTotal = api.total;
      items.push(...api.items);
      if (items.length >= requestedLimit) {
        await opened.persistCookies().catch(() => {});
        await context.close();
        return {
          success: true,
          count: items.length,
          items,
          cappedAt: cap,
          warmupDay: warmupDay(acct),
          requestedCount: data.limit,
          effectiveLimit: requestedLimit,
          capBypassed,
          totalAvailable: connectionTotal,
          diagnostic: api.diagnostic,
        };
      }
      console.log(
        `[connections-import] Voyager found ${items.length}/${requestedLimit}; trying search API for remaining connections.`,
      );
      const searchApi = await fetchConnectionsViaSearchVoyager(
        context,
        await currentJsession(context, JSESSIONID),
        requestedLimit,
        items,
        onProgress,
      );
      searchApiDiagnostic = searchApi.diagnostic;
      if (searchApi.items.length > items.length) {
        items.length = 0;
        items.push(...searchApi.items);
        apiDiagnostic = searchApi.diagnostic;
        console.log(
          `[connections-import] Search Voyager expanded import to ${items.length}/${requestedLimit}.`,
        );
        if (items.length >= requestedLimit) {
          await opened.persistCookies().catch(() => {});
          await context.close();
          return {
            success: true,
            count: items.length,
            items,
            cappedAt: cap,
            warmupDay: warmupDay(acct),
            requestedCount: data.limit,
            effectiveLimit: requestedLimit,
            capBypassed,
            totalAvailable: connectionTotal,
            diagnostic: searchApi.diagnostic,
          };
        }
      }
    } else {
      apiDiagnostic = api.diagnostic;
    }

    if (items.length > 0) {
      await reportProgress(onProgress, {
        items: items.slice(0, requestedLimit),
        importedCount: Math.min(items.length, requestedLimit),
        requestedCount: requestedLimit,
        pagesVisited: apiDiagnostic?.pagesVisited || 0,
        source: "voyager",
      });
    }

    let visibleStartUrl = targetUrl;
    if (items.length > 0) {
      try {
        const u = new URL(visibleStartUrl);
        if (u.pathname.includes("/search/")) {
          const nextLikelyPage = Math.max(
            Number(u.searchParams.get("page") || 1),
            Math.floor(items.length / 20) + 1,
          );
          u.searchParams.set("page", String(nextLikelyPage));
          visibleStartUrl = u.toString();
          console.log(
            `[connections-import] Visible fallback starting at search page ${nextLikelyPage} after ${items.length} API imports.`,
          );
        }
      } catch {
        /* keep original visible URL */
      }
    }

    const initialPageLoaded = await gotoLinkedInPage(page, visibleStartUrl);
    if (!initialPageLoaded) {
      await opened.persistCookies().catch(() => {});
      await context.close();
      if (items.length > 0) {
        return partialImportResult({
          items,
          cap,
          warmupDayValue: warmupDay(acct),
          requestedCount: data.limit,
          effectiveLimit: requestedLimit,
          capBypassed,
          diagnostic: apiDiagnostic,
          reason:
            "Voyager import succeeded partially, but the search/visible fallback could not add more. Kept the successful API results instead of failing the run.",
        });
      }
      return {
        success: false,
        error:
          "LinkedIn search page could not load. The pasted cookies are probably stale, or LinkedIn wants a fresh browser session.",
      };
    }
    const domTotal = await page
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
    // The Voyager connection total (paging.total) is authoritative; fall back to the
    // DOM "About N results" count only when the API didn't report one.
    const totalAvailable = connectionTotal ?? domTotal;
    const limit = totalAvailable ? Math.min(requestedLimit, totalAvailable) : requestedLimit;
    const seen = new Set(items.map((item) => item.publicId || item.profileUrl || item.id));
    let stagnantPages = 0;
    let diag = "";
    let pagesVisited = 0;
    let lastPageAdded = 0;
    let lastParsedCount = 0;
    let lastAnchorCount = 0;
    let stopReason = "requested-limit-reached";

    while (items.length < limit && stagnantPages < 2) {
      pagesVisited++;
      // Human-like incremental scroll to trigger lazy loading.
      const steps = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < steps; i++) {
        await page.mouse.wheel(0, 400 + Math.random() * 300);
        await sleep(jitter(400, 900));
      }

      // Resilient extraction: LinkedIn rotates/obfuscates class names, so we DON'T
      // rely on them. We anchor on the stable thing — anchor tags to /in/ profiles —
      // and walk up to a reasonable container to read the surrounding text lines.
      const { batch, anchorCount, anchorSignature } = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href*='/in/']"));
        const byId = new Map<string, any>();
        const anchorIds = new Set<string>();

        // UI chrome / action labels that must never be treated as name/headline/location.
        const NOISE =
          /^(message|connect|follow|pending|view profile|view |• |· |\d+ (mutual|connection)|status is|premium|open the|more|save|·)/i;
        const clean = (s: string) => s.replace(/\s+/g, " ").trim();
        // Same company extraction as the Voyager path: text after the first " at ",
        // cut at the first separator so we keep just the company name.
        const companyFrom = (h: string) => {
          const m = h.match(/\s+at\s+(.+)/i);
          if (!m) return "";
          const tail = m[1].split(/\s*[|·•\n]\s*|\s[—–-]\s|\.\s|\s*\(/)[0] || "";
          return tail.replace(/[\s,;.|·•—–-]+$/, "").trim();
        };

        for (const a of anchors) {
          const href = a.href.split("?")[0];
          const publicId = href.split("/in/")[1]?.split("/")[0] || "";
          if (!publicId) continue;
          anchorIds.add(publicId);

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

          // Profile photo: the avatar img in this result row, skipping logos/banners.
          const avatar = scope.querySelector<HTMLImageElement>("img[alt]");
          const picture =
            avatar?.src && !/logo|background/i.test(avatar.alt || "") ? avatar.src : "";

          if (!byId.has(publicId)) {
            byId.set(publicId, {
              publicId,
              name,
              headline,
              location,
              company: companyFrom(headline),
              profileUrl: href,
              picture,
            });
          }
        }
        return {
          batch: Array.from(byId.values()),
          anchorCount: anchors.length,
          anchorSignature: Array.from(anchorIds).sort().join("|"),
        };
      });

      lastParsedCount = batch.length;
      lastAnchorCount = anchorCount;
      diag = `anchors=${anchorCount} parsed=${batch.length} url=${page.url().slice(0, 80)}`;
      console.log("Server: scrape pass —", diag);

      let added = 0;
      for (const p of batch) {
        const key = p.publicId || p.profileUrl || p.name;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        // Same sanitation as the API path: strip the "• 1st" degree badge from the name,
        // and blank a headline/company that turned out to be a multi-card blob.
        const cleanName = stripDegreeBadge(p.name || "");
        const cleanHeadline = headlineLooksCorrupt(p.headline || "") ? "" : p.headline || "";
        items.push({
          id: key,
          tags: [],
          ...p,
          name: cleanName,
          headline: cleanHeadline,
          company: headlineLooksCorrupt(p.headline || "") ? "" : p.company || "",
          location: headlineLooksCorrupt(p.location || "") ? "" : p.location || "",
        });
        added++;
        if (items.length >= limit) break;
      }

      lastPageAdded = added;
      stagnantPages = added === 0 ? stagnantPages + 1 : 0;
      await reportProgress(onProgress, {
        items: items.slice(0, limit),
        importedCount: Math.min(items.length, limit),
        requestedCount: limit,
        pagesVisited,
        source: "visible",
      });
      if (items.length >= limit) {
        stopReason = "requested-limit-reached";
        break;
      }
      if (stagnantPages >= 2) {
        stopReason = "visible-pages-were-duplicates";
        break;
      }

      // Prefer LinkedIn's real Next control, but verify that the result set
      // actually changes. LinkedIn sometimes accepts the click while leaving
      // the SPA on the same page, which previously caused repeated results.
      const beforeUrl = page.url();
      const currentPageNumber = (() => {
        try {
          const value = Number(new URL(beforeUrl).searchParams.get("page") || pagesVisited);
          return Number.isFinite(value) && value > 0 ? value : pagesVisited;
        } catch {
          return pagesVisited;
        }
      })();
      const hasNext = await page
        .evaluate(() => {
          const candidates = Array.from(
            document.querySelectorAll<HTMLElement>(
              "button[aria-label*='Next' i], a[aria-label*='Next' i], button, a",
            ),
          ).filter((el) => {
            const label = `${el.getAttribute("aria-label") || ""} ${el.innerText || ""}`;
            return /\bnext\b/i.test(label);
          });
          const next = candidates.find((el) => {
            const ariaDisabled = el.getAttribute("aria-disabled") === "true";
            const disabled = el instanceof HTMLButtonElement && el.disabled;
            const hidden = el.offsetParent === null;
            return !ariaDisabled && !disabled && !hidden;
          });
          if (!next) return false;
          next.scrollIntoView({ block: "center", inline: "center" });
          next.click();
          return true;
        })
        .catch(() => false);

      let pageAdvanced = false;
      if (hasNext) {
        await sleep(jitter(1800, 3200));
        for (let attempt = 0; attempt < 12; attempt++) {
          const nextSignature = await page
            .evaluate(() => {
              const ids = new Set<string>();
              for (const a of Array.from(
                document.querySelectorAll<HTMLAnchorElement>("a[href*='/in/']"),
              )) {
                const publicId = a.href.split("?")[0].split("/in/")[1]?.split("/")[0] || "";
                if (publicId) ids.add(publicId);
              }
              return Array.from(ids).sort().join("|");
            })
            .catch(() => "");
          if (nextSignature && nextSignature !== anchorSignature) {
            pageAdvanced = true;
            break;
          }
          await sleep(750);
        }
      }

      // If the SPA click stalled or LinkedIn omitted the button, navigate to
      // the next search page explicitly. This is still a normal visible-page
      // request and avoids restarting another 25-item import from page one.
      if (!pageAdvanced) {
        try {
          const nextUrl = new URL(beforeUrl);
          nextUrl.searchParams.set("page", String(currentPageNumber + 1));
          await sleep(jitter(1800, 3200));
          const loaded = await gotoLinkedInPage(page, nextUrl.toString());
          if (!loaded) throw new Error("LinkedIn page did not load");
          const fallbackSignature = await page
            .evaluate(() => {
              const ids = new Set<string>();
              for (const a of Array.from(
                document.querySelectorAll<HTMLAnchorElement>("a[href*='/in/']"),
              )) {
                const publicId = a.href.split("?")[0].split("/in/")[1]?.split("/")[0] || "";
                if (publicId) ids.add(publicId);
              }
              return Array.from(ids).sort().join("|");
            })
            .catch(() => "");
          pageAdvanced = Boolean(fallbackSignature && fallbackSignature !== anchorSignature);
        } catch {
          pageAdvanced = false;
        }
      }

      if (!pageAdvanced) {
        stopReason = hasNext ? "linkedin-page-did-not-advance" : "linkedin-showed-no-next-page";
        break;
      }
    }

    const finalUrl = page.url();
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
    if (items.length < requestedLimit && apiDiagnostic?.source === "voyager") {
      return partialImportResult({
        items,
        cap,
        warmupDayValue: warmupDay(acct),
        requestedCount: data.limit,
        effectiveLimit: requestedLimit,
        capBypassed,
        diagnostic: {
          source: "visible",
          stopReason,
          pagesVisited,
          uniqueFound: items.length,
          lastPageAdded,
          lastParsedCount,
          lastAnchorCount,
          lastUrl: finalUrl,
          details: [
            `API seed ${apiDiagnostic.uniqueFound}`,
            searchApiDiagnostic
              ? `search API ${searchApiDiagnostic.stopReason}, unique ${searchApiDiagnostic.uniqueFound}${
                  searchApiDiagnostic.details ? ` (${searchApiDiagnostic.details})` : ""
                }`
              : "",
            `visible ${diag}`,
          ]
            .filter(Boolean)
            .join("; "),
        },
        reason:
          "LinkedIn stopped returning additional unique visible results after the API import.",
      });
    }
    return {
      success: true,
      count: items.length,
      items,
      cappedAt: cap,
      warmupDay: warmupDay(acct),
      totalAvailable,
      requestedCount: data.limit,
      effectiveLimit: requestedLimit,
      capBypassed,
      diagnostic: {
        source: "visible",
        stopReason,
        pagesVisited,
        uniqueFound: items.length,
        lastPageAdded,
        lastParsedCount,
        lastAnchorCount,
        lastUrl: finalUrl,
        details: apiDiagnostic
          ? `API ${apiDiagnostic.stopReason}, seed ${apiDiagnostic.uniqueFound}${
              apiDiagnostic.details ? ` (${apiDiagnostic.details})` : ""
            }; visible ${diag}`
          : diag,
      },
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

// Parse people out of a Voyager people-search response, reusing the connection tree-walk
// + sanitizer. Exported for the prospect-discovery server function (linkedin.discover.ts),
// which must live in its own module so its node-only imports never reach the client bundle.
export function parseVoyagerPeople(raw: unknown, limit: number): Lead[] {
  return parseVoyagerConnections(raw, limit);
}
