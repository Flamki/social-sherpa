/**
 * linkedin.session.ts — Botdog-style anti-ban session layer (SERVER ONLY).
 *
 * The single biggest anti-ban trick is: keep the {fingerprint + proxy IP} pair
 * STABLE for a given account, forever. LinkedIn fingerprints the IP→account pair.
 * If you rotate the IP or the browser fingerprint between sessions, you trip a
 * security challenge. So we persist both to disk, keyed by the account, and reuse
 * them on every run.
 *
 * This file is imported lazily from inside server functions only — never from the
 * client bundle (Playwright + node:fs would crash the browser build).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { runtimeDataDir } from "@/lib/config.server";

export type ProxyConfig = {
  /** e.g. "brd.superproxy.io" */
  host: string;
  port: number;
  username?: string;
  password?: string;
};

export type StoredCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

export type Fingerprint = {
  userAgent: string;
  viewport: { width: number; height: number };
  locale: string;
  timezoneId: string;
  /** seconds offset used by X-Li-Track and Intl spoofing */
  deviceMemory: number;
  hardwareConcurrency: number;
};

export type AccountSession = {
  /** stable id derived from li_at so the same account always maps to the same profile dir */
  accountId: string;
  fingerprint: Fingerprint;
  proxy?: ProxyConfig;
  proxySource?: "manual" | "auto";
  proxySessionNonce?: string;
  proxySessionRotatedAt?: string;
  /** the saved auth cookies — lets any engine reuse the session without re-pasting */
  cookies?: { li_at: string; JSESSIONID: string };
  /** full linkedin.com cookie jar captured after validation */
  cookieJar?: StoredCookie[];
  /** captured browser UA at link time, for reference */
  capturedUserAgent?: string;
  createdAt: string;
  lastUsedAt: string;
  /** ISO date the warmup ramp started; null = not started */
  warmupStartedAt: string | null;
};

const DATA_DIR = path.join(runtimeDataDir(), "sessions");

/** Stable, non-reversible account id from the li_at token. */
export function accountIdFromCookie(li_at: string): string {
  return crypto.createHash("sha256").update(li_at.trim()).digest("hex").slice(0, 16);
}

/** Per-account persistent Chromium profile dir (cookies, cache, localStorage). */
export function profileDirFor(accountId: string): string {
  return path.join(DATA_DIR, accountId, "chrome-profile");
}

function makeProxySessionNonce(accountId: string): string {
  return `${accountId.slice(0, 8)}${Math.random().toString(36).slice(2, 8)}`
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 16);
}

const IPROYAL_SESSIONS = [
  "9bm9Cef7",
  "JYBS8SKG",
  "Ar3WEqsc",
  "Gwumq4mj",
  "s1SfwGSe",
  "rsHo4PfB",
  "jgTDhwSO",
  "hzg2otl6",
  "ut1xomEu",
  "01HeRKhA",
];

const GEO_FINGERPRINTS: Record<string, Pick<Fingerprint, "locale" | "timezoneId">> = {
  IN: { locale: "en-IN", timezoneId: "Asia/Kolkata" },
  US: { locale: "en-US", timezoneId: "America/New_York" },
  GB: { locale: "en-GB", timezoneId: "Europe/London" },
};

function configuredGeo() {
  const envCountry = process.env.LINKEDIN_ACCOUNT_COUNTRY?.trim().toUpperCase();
  const envTimezone = process.env.LINKEDIN_ACCOUNT_TIMEZONE?.trim();
  const envLocale = process.env.LINKEDIN_ACCOUNT_LOCALE?.trim();

  if (envTimezone || envLocale) {
    return {
      locale: envLocale || GEO_FINGERPRINTS[envCountry || ""]?.locale || "en-US",
      timezoneId:
        envTimezone || GEO_FINGERPRINTS[envCountry || ""]?.timezoneId || "America/New_York",
    };
  }

  const proxyText = [
    process.env.LINKEDIN_PROXY_USERNAME,
    process.env.LINKEDIN_PROXY_PASSWORD,
    process.env.LINKEDIN_PROXY_HOST,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (envCountry && GEO_FINGERPRINTS[envCountry]) return GEO_FINGERPRINTS[envCountry];
  if (/(^|[_-])country[_-]?in\b|city[_-]?mumbai\b|india/.test(proxyText))
    return GEO_FINGERPRINTS.IN;

  try {
    const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detectedTz === "Asia/Kolkata") return GEO_FINGERPRINTS.IN;
  } catch {
    /* ignore */
  }

  return null;
}

function alignFingerprintToGeo(fingerprint: Fingerprint): Fingerprint {
  const geo = configuredGeo();
  if (!geo) return fingerprint;
  if (fingerprint.timezoneId === geo.timezoneId && fingerprint.locale === geo.locale) {
    return fingerprint;
  }
  return {
    ...fingerprint,
    locale: geo.locale,
    timezoneId: geo.timezoneId,
  };
}

function stableProxySessionId(accountId: string, stickyId?: string): string {
  const baseIndex = parseInt(accountId.slice(0, 8), 16) || 0;
  const offset = stickyId
    ? parseInt(crypto.createHash("sha256").update(stickyId).digest("hex").slice(0, 8), 16) || 0
    : 0;
  const index = (baseIndex + offset) % IPROYAL_SESSIONS.length;
  return IPROYAL_SESSIONS[index];
}

function renderProxyTemplate(
  value: string | undefined,
  accountId: string,
  stickyId?: string,
): string | undefined {
  if (!value) return undefined;
  const sessionId = stableProxySessionId(accountId, stickyId);
  return value
    .replaceAll("{accountId}", accountId)
    .replaceAll("{sessionId}", sessionId)
    .replaceAll("{stickyId}", sessionId);
}

/** Honor LINKEDIN_DISABLE_PROXY=true — run direct on the user's own IP (right for local use,
 *  and the fix when the configured proxy is down/unreachable). */
export function proxyDisabled(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.LINKEDIN_DISABLE_PROXY || "").trim());
}

function autoProxyFor(accountId: string, stickyId?: string): ProxyConfig | undefined {
  if (proxyDisabled()) return undefined;
  const host = process.env.LINKEDIN_PROXY_HOST?.trim();
  const port = Number(process.env.LINKEDIN_PROXY_PORT);
  if (!host || !Number.isInteger(port) || port <= 0) return undefined;

  return {
    host,
    port,
    username: renderProxyTemplate(process.env.LINKEDIN_PROXY_USERNAME?.trim(), accountId, stickyId),
    password: renderProxyTemplate(process.env.LINKEDIN_PROXY_PASSWORD?.trim(), accountId, stickyId),
  };
}

// A small pool of realistic, internally-consistent desktop fingerprints.
// We pick ONE per account at creation and never change it.
const FINGERPRINT_POOL: Fingerprint[] = [
  {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    locale: "en-US",
    timezoneId: "America/New_York",
    deviceMemory: 8,
    hardwareConcurrency: 8,
  },
  {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    deviceMemory: 16,
    hardwareConcurrency: 10,
  },
  {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-GB",
    timezoneId: "Europe/London",
    deviceMemory: 8,
    hardwareConcurrency: 12,
  },
  // India fingerprint — matches your server location & LinkedIn account geo
  {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
    deviceMemory: 8,
    hardwareConcurrency: 8,
  },
];

export function pickFingerprint(accountId: string): Fingerprint {
  // Deterministic pick from the account id so it's stable even if the file is lost.
  const n = parseInt(accountId.slice(0, 8), 16);
  // Guard against a non-hex id (parseInt → NaN) so we never index out of the pool.
  const poolIndex = Number.isFinite(n)
    ? ((n % FINGERPRINT_POOL.length) + FINGERPRINT_POOL.length) % FINGERPRINT_POOL.length
    : 0;

  return alignFingerprintToGeo(FINGERPRINT_POOL[poolIndex]);
}

async function sessionFile(accountId: string): Promise<string> {
  const dir = path.join(DATA_DIR, accountId);
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, "session.json");
}

async function readSessionByAccountId(accountId: string): Promise<AccountSession | null> {
  const file = await sessionFile(accountId);
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as AccountSession;
  } catch {
    return null;
  }
}

async function writeSessionByAccountId(accountId: string, session: AccountSession) {
  const file = await sessionFile(accountId);
  await fs.writeFile(file, JSON.stringify(session, null, 2));
}

function cleanCookieJar(cookieJar: StoredCookie[]): StoredCookie[] {
  const byKey = new Map<string, StoredCookie>();
  for (const raw of cookieJar) {
    if (!raw?.name || !raw?.value || !raw?.domain) continue;
    if (!/linkedin\.com$/i.test(raw.domain.replace(/^\./, ""))) continue;
    const cookie: StoredCookie = {
      name: raw.name,
      value: raw.value,
      domain: raw.domain,
      path: raw.path || "/",
      expires: raw.expires,
      httpOnly: raw.httpOnly,
      secure: raw.secure,
      sameSite: raw.sameSite,
    };
    byKey.set(`${cookie.name}|${cookie.domain}|${cookie.path}`, cookie);
  }
  return Array.from(byKey.values());
}

/**
 * Load the persistent session for an account, creating (and persisting) a stable
 * fingerprint on first use. Proxy is attached/updated separately via saveProxy().
 */
export async function getOrCreateSession(li_at: string): Promise<AccountSession> {
  const accountId = accountIdFromCookie(li_at);
  const file = await sessionFile(accountId);

  try {
    const raw = await fs.readFile(file, "utf8");
    const existing = JSON.parse(raw) as AccountSession;
    existing.lastUsedAt = new Date().toISOString();
    existing.fingerprint = alignFingerprintToGeo(existing.fingerprint);
    const autoProxy = autoProxyFor(accountId, existing.proxySessionNonce);
    const shouldApplyAutoProxy =
      !!autoProxy &&
      (!existing.proxy ||
        existing.proxySource === "auto" ||
        (!existing.proxySource &&
          existing.proxy.host === autoProxy.host &&
          existing.proxy.port === autoProxy.port));
    if (shouldApplyAutoProxy) {
      existing.proxy = autoProxy;
      existing.proxySource = "auto";
    }
    // Proxy turned off (or down): drop any saved proxy so we run direct on the user's IP.
    if (proxyDisabled()) {
      existing.proxy = undefined;
      existing.proxySource = undefined;
    }
    await fs.writeFile(file, JSON.stringify(existing, null, 2));
    return existing;
  } catch {
    const now = new Date().toISOString();
    const autoProxy = autoProxyFor(accountId);
    const fresh: AccountSession = {
      accountId,
      fingerprint: pickFingerprint(accountId),
      proxy: autoProxy,
      proxySource: autoProxy ? "auto" : undefined,
      createdAt: now,
      lastUsedAt: now,
      warmupStartedAt: null,
    };
    await fs.writeFile(file, JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

/**
 * Adopt a credential-login session. The SAME persistent profile that just authenticated
 * becomes the account's profile, with the SAME fingerprint and NO proxy — so every later
 * action (import, message, invite) runs from the exact browser context + IP the session was
 * issued to. Without this, the session is replayed from a different profile/IP/fingerprint and
 * LinkedIn rejects the API calls with 401 "session expired".
 */
export async function adoptCredentialLogin(
  li_at: string,
  JSESSIONID: string,
  fingerprint: Fingerprint,
  loginProfileDir: string,
): Promise<AccountSession> {
  const accountId = accountIdFromCookie(li_at);
  const dest = profileDirFor(accountId);
  // Move the just-authenticated profile into the account's slot so the live session is reused.
  try {
    if (path.resolve(loginProfileDir) !== path.resolve(dest)) {
      await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(loginProfileDir, dest);
    }
  } catch {
    // Cross-device or still-locked profile dir → leave it; openLinkedIn will re-seed cookies.
  }
  const now = new Date().toISOString();
  const session: AccountSession = {
    accountId,
    fingerprint,
    proxy: undefined,
    proxySource: "manual", // stops auto-proxy from attaching a different IP than login used
    cookies: { li_at, JSESSIONID },
    createdAt: now,
    lastUsedAt: now,
    warmupStartedAt: now,
  };
  const file = await sessionFile(accountId);
  await fs.writeFile(file, JSON.stringify(session, null, 2));
  return session;
}

export async function saveProxy(li_at: string, proxy?: ProxyConfig): Promise<AccountSession> {
  const s = await getOrCreateSession(li_at);
  s.proxy = proxy;
  s.proxySource = proxy ? "manual" : undefined;
  s.proxySessionNonce = undefined;
  s.proxySessionRotatedAt = undefined;
  const file = await sessionFile(s.accountId);
  await fs.writeFile(file, JSON.stringify(s, null, 2));
  return s;
}

export async function rotateAutoProxySession(accountId: string): Promise<ProxyConfig | undefined> {
  const s = await readSessionByAccountId(accountId);
  if (!s || s.proxySource !== "auto") return undefined;
  const nonce = `${accountId.slice(0, 6)}${Date.now().toString(36).slice(-6)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const proxy = autoProxyFor(accountId, nonce);
  if (!proxy) return undefined;
  s.proxy = proxy;
  s.proxySource = "auto";
  s.proxySessionNonce = nonce;
  s.proxySessionRotatedAt = new Date().toISOString();
  s.lastUsedAt = new Date().toISOString();
  await writeSessionByAccountId(accountId, s);
  return proxy;
}

export async function pinAutoProxyForFreshCookies(li_at: string): Promise<AccountSession> {
  const s = await getOrCreateSession(li_at);
  const auto = autoProxyFor(s.accountId);
  if (!auto) return s;

  const nonce =
    process.env.LINKEDIN_PROXY_RESET_ON_CONNECT === "false" && s.proxySessionNonce
      ? s.proxySessionNonce
      : makeProxySessionNonce(s.accountId);
  const proxy = autoProxyFor(s.accountId, nonce);
  if (!proxy) return s;

  s.proxy = proxy;
  s.proxySource = "auto";
  s.proxySessionNonce = nonce;
  s.proxySessionRotatedAt = undefined;
  s.lastUsedAt = new Date().toISOString();
  await writeSessionByAccountId(s.accountId, s);
  return s;
}

/** Persist the auth cookies (and optional captured UA) so any engine can reuse them. */
export async function saveCookies(
  li_at: string,
  JSESSIONID: string,
  capturedUserAgent?: string,
  cookieJar?: StoredCookie[],
): Promise<AccountSession> {
  const s = await getOrCreateSession(li_at);
  s.cookies = { li_at: li_at.trim(), JSESSIONID: JSESSIONID.trim() };
  if (cookieJar?.length) s.cookieJar = cleanCookieJar(cookieJar);
  if (capturedUserAgent) s.capturedUserAgent = capturedUserAgent;
  const file = await sessionFile(s.accountId);
  await fs.writeFile(file, JSON.stringify(s, null, 2));
  return s;
}

export async function saveCookiesForAccount(
  accountId: string,
  cookies: { li_at?: string; JSESSIONID?: string },
  capturedUserAgent?: string,
  cookieJar?: StoredCookie[],
): Promise<AccountSession | null> {
  const s = await readSessionByAccountId(accountId);
  if (!s) return null;

  const li_at = cookies.li_at?.trim() || s.cookies?.li_at;
  const JSESSIONID = cookies.JSESSIONID?.trim() || s.cookies?.JSESSIONID;
  if (li_at && JSESSIONID) {
    s.cookies = { li_at, JSESSIONID };
  }
  if (cookieJar?.length) s.cookieJar = cleanCookieJar(cookieJar);
  if (capturedUserAgent) s.capturedUserAgent = capturedUserAgent;
  s.lastUsedAt = new Date().toISOString();
  await writeSessionByAccountId(accountId, s);
  return s;
}

export async function startWarmup(li_at: string): Promise<AccountSession> {
  const s = await getOrCreateSession(li_at);
  if (!s.warmupStartedAt) {
    s.warmupStartedAt = new Date().toISOString();
    const file = await sessionFile(s.accountId);
    await fs.writeFile(file, JSON.stringify(s, null, 2));
  }
  return s;
}

/** Day index in the 14-day warmup ramp (0 = not started, 1..14). */
export function warmupDay(s: AccountSession): number {
  if (!s.warmupStartedAt) return 0;
  const days = Math.floor((Date.now() - new Date(s.warmupStartedAt).getTime()) / 86_400_000);
  return Math.min(14, days + 1);
}

/**
 * Human-shaped daily action cap. Botdog throttles HARD to keep accounts alive:
 * day 1-3 view only, 4-7 light, 8-14 ramp, then steady ~20-25 imports of leads
 * per "page" but conservative action budget. We expose the import cap here.
 */
export function dailyImportCap(s: AccountSession): number {
  const day = warmupDay(s);
  if (day === 0) return 0; // must start warmup explicitly
  if (day <= 3) return 25; // gentle — just looking around
  if (day <= 7) return 60;
  if (day <= 14) return 120;
  return 250; // steady-state ceiling per run
}

/**
 * Messages-per-day cap, ramped over the 14-day warmup. Messaging is higher-risk
 * than reading, so it's deliberately conservative (Botdog stays ~20-25/day).
 */
export function effectiveMessagesCap(s: AccountSession): number {
  const day = warmupDay(s);
  if (day === 0) return 0;
  if (day <= 3) return 5;
  if (day <= 7) return 12;
  if (day <= 14) return 20;
  return 25;
}

/** Are we inside the account's "active hours" (9am-6pm in its timezone)? */
export function withinActiveHours(s: AccountSession): boolean {
  try {
    const hour = Number(
      new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hour12: false,
        timeZone: s.fingerprint.timezoneId,
      }).format(new Date()),
    );
    return hour >= 9 && hour < 18;
  } catch {
    return true;
  }
}
