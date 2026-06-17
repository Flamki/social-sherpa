/**
 * linkedin.discover.core.ts — prospect discovery engine (SERVER ONLY, no createServerFn).
 *
 * Holds the plain `runDiscovery` function. It must NOT be imported by any client route
 * directly — only via lazy `await import(...)` inside server functions (discoverProspects)
 * or the agent's tool loop — so its node-only chain (browser → session → node:fs) never
 * reaches the browser bundle.
 */
export type Prospect = {
  name: string;
  headline: string;
  company: string;
  location: string;
  profileUrl: string;
  publicId: string;
  picture?: string;
};

export type DiscoverResult =
  | { success: true; prospects: Prospect[] }
  | { success: false; error: string; challenge?: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (min: number, max: number) => min + Math.random() * (max - min);

function parseSearchIntent(raw: string) {
  const query = raw.trim().replace(/\s+/g, " ");
  let location = "";
  let keywords = query;
  let requiredTerms: string[] = [];
  const locationMatch = query.match(
    /\b(?:live|lives|living|located|based|reside|resides|stay|stays)\s+(?:in|near|around)\s+(.+?)(?=\s+(?:and|with|who|that|for|as|at|working|works|doing)\b|$)/i,
  );
  if (locationMatch?.[1]) {
    location = locationMatch[1].trim();
    keywords = query.replace(locationMatch[0], " ");
  }

  // Natural searches often arrive as "oracle employee in goa" or "people at oracle in goa".
  // LinkedIn treats that as broad keyword text unless we split the location out ourselves.
  if (!location) {
    const simpleLocationMatch = query.match(
      /\b(?:in|near|around|from)\s+([a-z][a-z\s,.-]{1,60}?)(?=\s+(?:and|with|who|that|for|as|at|working|works|doing)\b|$)/i,
    );
    if (simpleLocationMatch?.[1]) {
      const candidate = simpleLocationMatch[1].trim();
      const looksLikeIndustry =
        /\b(fintech|saas|startup|startups|supply chain|marketing|sales|recruiting|recruitment|engineering|software|product|design|finance|hr|human resources)\b/i.test(
          candidate,
        );
      if (!looksLikeIndustry) {
        location = candidate;
        keywords = query.replace(simpleLocationMatch[0], " ");
      }
    }
  }

  const companyMatch =
    keywords.match(
      /\b(?:at|from|working\s+at|works\s+at|employee\s+at|employees\s+at)\s+([a-z0-9][a-z0-9\s.&-]{1,60}?)(?=\s+(?:employee|employees|people|person|staff|worker|workers|who|that|with|for|as)\b|$)/i,
    ) ||
    keywords.match(
      /^\s*([a-z0-9][a-z0-9\s.&-]{1,60}?)\s+(?:employee|employees|people|person|staff|worker|workers)\b/i,
    );
  if (companyMatch?.[1]) {
    requiredTerms = tokenizeCompany(companyMatch[1]);
  }

  keywords = keywords
    .replace(/\b(?:people|persons?|profiles?|who|that|are|is)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!keywords) keywords = location || query;
  if (!requiredTerms.length) requiredTerms = tokenizeStrictKeywords(keywords);
  return { keywords, location, requiredTerms };
}

function tokenizeLocation(location: string) {
  return location
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

function tokenizeCompany(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2)
    .filter(
      (token) =>
        !/^(the|and|at|from|employee|employees|people|person|staff|worker|workers|company|companies)$/i.test(
          token,
        ),
    );
}

function tokenizeStrictKeywords(value: string) {
  // Only enforce proper-noun/company-ish searches. Role/industry searches are intentionally
  // broader because LinkedIn can phrase roles many ways.
  const companyLike = value.match(
    /^\s*([a-z0-9][a-z0-9\s.&-]{1,60}?)\s+(?:employee|employees|staff|worker|workers)\b/i,
  );
  return companyLike?.[1] ? tokenizeCompany(companyLike[1]) : [];
}

function normalizeForMatch(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

export async function runDiscovery(data: {
  cookies: { li_at: string; JSESSIONID: string };
  query: string;
  limit: number;
}): Promise<DiscoverResult> {
  const { openLinkedIn } = await import("./linkedin.browser");
  const limit = Math.max(1, Math.min(data.limit || 10, 50));
  const opened = await openLinkedIn({ cookies: data.cookies, headless: true });
  if (!opened.ok) {
    return { success: false, error: opened.error, challenge: opened.challenge };
  }
  const { context, page } = opened;

  // The Voyager REST search endpoints (blended / dash clusters) now 404; the people-search
  // RESULTS PAGE is the reliable surface, so we drive it and scrape the rendered cards.
  const BADGE = /\s*[•·]\s*(1st|2nd|3rd)\b/gi;
  const stripBadge = (n: string) => n.replace(BADGE, " ").replace(/\s+/g, " ").trim();
  const looksCorrupt = (h: string) =>
    !!h &&
    (/\bmutual connections?\b/i.test(h) || /[•·]\s*(1st|2nd|3rd)\b/i.test(h) || h.length > 300);
  const companyFrom = (h: string) => {
    const m = h.match(/\s+at\s+(.+)/i);
    if (!m) return "";
    return (m[1].split(/\s*[|·•\n]\s*|\s[—–-]\s|\.\s|\s*\(/)[0] || "")
      .replace(/[\s,;.|·•—–-]+$/, "")
      .trim();
  };

  try {
    const intent = parseSearchIntent(data.query);
    const kw = encodeURIComponent(intent.keywords);
    const locationTokens = tokenizeLocation(intent.location);
    const requiredTerms = intent.requiredTerms;
    const byId = new Map<string, Prospect>();
    const hasHardFilters = locationTokens.length > 0 || requiredTerms.length > 0;
    const maxPages = hasHardFilters ? 10 : Math.min(10, Math.ceil(limit / 10) + 2);
    let stagnant = 0;

    for (
      let pageNum = 1;
      pageNum <= maxPages && byId.size < limit && (hasHardFilters || stagnant < 2);
      pageNum++
    ) {
      const url = `https://www.linkedin.com/search/results/people/?keywords=${kw}&origin=GLOBAL_SEARCH_HEADER&page=${pageNum}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      const cur = page.url();
      if (/\/(login|uas\/login|authwall|checkpoint)/i.test(cur)) {
        await context.close().catch(() => {});
        return {
          success: false,
          error: "LinkedIn session expired — reconnect with a fresh login, then search again.",
          challenge: true,
        };
      }
      // Let results render and lazy-load.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await sleep(jitter(1500, 3000));

      const cards: Array<{
        publicId: string;
        name: string;
        headline: string;
        location: string;
        picture: string;
      }> = await page.evaluate(
        ({ targetLocationTokens }) => {
          const clean = (s: string) => (s || "").replace(/\s+/g, " ").trim();
          const normalize = (s: string) =>
            clean(s)
              .toLowerCase()
              .normalize("NFKD")
              .replace(/[\u0300-\u036f]/g, "");
          const locationMatches = (s: string) => {
            if (!targetLocationTokens.length) return true;
            const normalized = normalize(s);
            return targetLocationTokens.every((token) => normalized.includes(token));
          };
          const NOISE =
            /^(message|connect|follow|following|pending|view|status is|premium|save|more|· |• |\d+(st|nd|rd|th)\b|\d+ (mutual|connection|follower))/i;
          const out: Array<Record<string, string>> = [];
          const seen = new Set<string>();

          // Each search result is one <li> row. Anchor on the nearest <li> ancestor of a /in/
          // link so we read ONE person's data per container (name, their photo, their text) —
          // climbing by class name breaks because LinkedIn obfuscates the result classes.
          const anchors = Array.from(
            document.querySelectorAll<HTMLAnchorElement>("a[href*='/in/']"),
          );
          for (const a of anchors) {
            const href = a.href.split("?")[0];
            const m = href.match(/\/in\/([^/?#]+)/);
            const publicId = m && m[1] ? decodeURIComponent(m[1]) : "";
            if (!publicId || seen.has(publicId)) continue;

            const li = a.closest("li");
            const scope = (li ||
              a.closest(
                "[data-chameleon-result-urn], .reusable-search__result-container, .entity-result",
              ) ||
              a.parentElement) as HTMLElement | null;
            if (!scope) continue;

            // NAME — visible name span first, then link text / aria-label.
            let name =
              a.querySelector<HTMLElement>("span[aria-hidden='true']")?.innerText ||
              a.innerText ||
              a.getAttribute("aria-label") ||
              "";
            name = clean(name.split("\n")[0])
              .replace(/^(view |connect with )/i, "")
              .replace(/^view .*? profile$/i, "")
              .replace(/^view profile for /i, "")
              .replace(/'s profile$/i, "");
            if (!name || NOISE.test(name) || /^linkedin member$/i.test(name)) continue;

            // De-noised text lines from THIS person's row only.
            const lines = (scope.innerText || "")
              .split(/\n+/)
              .map(clean)
              .filter((l, i, arr) => l && arr.indexOf(l) === i)
              .filter((l) => l && !NOISE.test(l) && normalize(l) !== normalize(name));
            // Headline = first non-location line; location = a line that looks like a place.
            const isPlace = (l: string) =>
              locationMatches(l) ||
              /,|\barea\b|\bregion\b|india|united|kingdom|states|maharashtra|pune|mumbai|delhi|bengaluru|bangalore|hyderabad/i.test(
                l,
              );
            const location = lines.find(isPlace) || "";
            if (
              targetLocationTokens.length &&
              !locationMatches(location || scope.innerText || "")
            ) {
              continue;
            }
            const headline = lines.find((l) => l !== location && !isPlace(l)) || "";

            // PHOTO — the person's avatar inside THEIR row (skip logos/icons).
            let picture = "";
            const imgs = Array.from(scope.querySelectorAll<HTMLImageElement>("img"));
            const nameBits = normalize(name).split(/\s+/).filter(Boolean);
            for (const img of imgs) {
              const alt = img.alt || "";
              const altNorm = normalize(alt);
              const altMatchesName =
                !alt ||
                nameBits.some((bit) => bit.length >= 3 && altNorm.includes(bit)) ||
                /profile|photo|picture/i.test(alt);
              if (
                img.src &&
                altMatchesName &&
                !/logo|background|icon/i.test(alt) &&
                /licdn\.com|media/i.test(img.src)
              ) {
                picture = img.src;
                break;
              }
            }

            seen.add(publicId);
            out.push({ publicId, name, headline, location, picture });
          }
          return out as Array<{
            publicId: string;
            name: string;
            headline: string;
            location: string;
            picture: string;
          }>;
        },
        { targetLocationTokens: locationTokens },
      );

      const before = byId.size;
      for (const c of cards) {
        if (byId.size >= limit) break;
        if (byId.has(c.publicId)) continue;
        const cleanName = stripBadge(c.name);
        const cleanHeadline = looksCorrupt(c.headline) ? "" : c.headline;
        const company = companyFrom(cleanHeadline);
        const matchText = normalizeForMatch(
          [cleanName, cleanHeadline, company, c.location, c.publicId.replace(/-/g, " ")].join(" "),
        );
        if (requiredTerms.length && !requiredTerms.every((term) => matchText.includes(term))) {
          continue;
        }
        byId.set(c.publicId, {
          name: cleanName,
          headline: cleanHeadline,
          company,
          location: looksCorrupt(c.location) ? "" : c.location,
          profileUrl: `https://www.linkedin.com/in/${c.publicId}`,
          publicId: c.publicId,
          picture: c.picture || undefined,
        });
      }
      stagnant = byId.size === before ? stagnant + 1 : 0;
      await sleep(jitter(1200, 2500));
    }

    await opened.persistCookies?.().catch(() => {});
    await context.close().catch(() => {});

    const prospects = Array.from(byId.values()).slice(0, limit);
    if (prospects.length === 0) {
      return {
        success: false,
        error: intent.location
          ? `No strict matches for "${data.query}" (${[
              requiredTerms.length ? requiredTerms.join(" + ") : "",
              intent.location,
            ]
              .filter(Boolean)
              .join(" in ")}). Try a broader search or a different city name.`
          : 'No people matched that search. Try broader keywords (role + industry), e.g. "supply chain manager fintech".',
      };
    }
    return { success: true, prospects };
  } catch (e) {
    await context.close().catch(() => {});
    return { success: false, error: (e as Error).message };
  }
}
