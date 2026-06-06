import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { runtimeDataDir } from "@/lib/config.server";

type UnipileConfig = {
  enabled: boolean;
  dsn: string;
  apiKey: string;
  accountId: string;
};

type StoredProviderConfig = {
  enabled?: boolean;
  dsn?: string;
  apiKey?: string;
};

export type UnipileAccount = {
  id: string;
  provider?: string;
  type?: string;
  status?: string;
  name?: string;
  username?: string;
  object?: string;
};

export type UnipileSendResult =
  | { ok: true; provider: "unipile"; chatId?: string; messageId?: string; raw?: unknown }
  | { ok: false; provider: "unipile"; error: string; raw?: unknown };

function cleanDsn(value: string) {
  return value.trim().replace(/\/+$/, "");
}

export function unipileConfig(): UnipileConfig {
  const dsn = cleanDsn(process.env.UNIPILE_DSN || "");
  const apiKey = (process.env.UNIPILE_API_KEY || "").trim();
  const accountId = (process.env.UNIPILE_ACCOUNT_ID || "").trim();
  return {
    enabled: process.env.UNIPILE_ENABLED === "true" && !!dsn && !!apiKey && !!accountId,
    dsn,
    apiKey,
    accountId,
  };
}

function headers(config: Pick<UnipileConfig, "apiKey">) {
  return {
    "X-API-KEY": config.apiKey,
    accept: "application/json",
  };
}

function publicIdentifierFromProfileUrl(profileUrl?: string) {
  if (!profileUrl) return "";
  try {
    const url = new URL(profileUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const marker = parts.findIndex((part) => part === "in" || part === "pub");
    return marker >= 0 ? parts[marker + 1] || "" : "";
  } catch {
    return "";
  }
}

function chatIdFromThreadUrl(threadUrl?: string) {
  if (!threadUrl) return "";
  return threadUrl.split("/messaging/thread/")[1]?.split(/[/?#]/)[0] || "";
}

async function parseJson(res: Response) {
  const text = await res.text().catch(() => "");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorFrom(raw: any, fallback: string) {
  return raw?.message || raw?.error || raw?.detail || raw?.title || fallback;
}

async function storeEnv() {
  const [{ promises: fs }, path] = await Promise.all([import("node:fs"), import("node:path")]);
  const dir = path.join(runtimeDataDir(), "unipile");
  await fs.mkdir(dir, { recursive: true });
  return {
    fs,
    accountFile: path.join(dir, "account.json"),
    configFile: path.join(dir, "config.json"),
  };
}

async function readStoredProviderConfig(): Promise<StoredProviderConfig | null> {
  try {
    const { fs, configFile } = await storeEnv();
    return JSON.parse(await fs.readFile(configFile, "utf8"));
  } catch {
    return null;
  }
}

async function writeStoredProviderConfig(config: StoredProviderConfig) {
  const { fs, configFile } = await storeEnv();
  await fs.writeFile(configFile, JSON.stringify(config, null, 2));
}

async function providerConfig(): Promise<Pick<UnipileConfig, "enabled" | "dsn" | "apiKey">> {
  const env = unipileConfig();
  const stored = await readStoredProviderConfig();
  const dsn = cleanDsn(env.dsn || stored?.dsn || "");
  const apiKey = env.apiKey || (stored?.apiKey || "").trim();
  const envEnabled = process.env.UNIPILE_ENABLED === "true";
  const storedEnabled = stored?.enabled === true;
  return {
    enabled: (envEnabled || storedEnabled) && !!dsn && !!apiKey,
    dsn,
    apiKey,
  };
}

async function readStoredAccount(): Promise<Partial<UnipileAccount> | null> {
  try {
    const { fs, accountFile } = await storeEnv();
    return JSON.parse(await fs.readFile(accountFile, "utf8"));
  } catch {
    return null;
  }
}

async function writeStoredAccount(account: UnipileAccount) {
  const { fs, accountFile } = await storeEnv();
  await fs.writeFile(accountFile, JSON.stringify(account, null, 2));
}

async function runtimeConfig(accountIdOverride?: string): Promise<UnipileConfig> {
  const base = unipileConfig();
  const provider = await providerConfig();
  const stored = await readStoredAccount();
  const accountId = accountIdOverride?.trim() || base.accountId || stored?.id || "";
  return {
    ...base,
    dsn: provider.dsn,
    apiKey: provider.apiKey,
    accountId,
    enabled: provider.enabled && !!accountId,
  };
}

export async function canUseUnipileConnector(accountIdOverride?: string) {
  const config = await runtimeConfig(accountIdOverride);
  return config.enabled;
}

async function unipileFetch(path: string, init?: RequestInit) {
  const config = await providerConfig();
  if (!config.dsn || !config.apiKey) {
    throw new Error("Unipile DSN/API key missing. Save provider config in onboarding.");
  }
  return fetch(`${config.dsn}${path}`, {
    ...init,
    headers: {
      ...headers(config),
      ...(init?.headers || {}),
    },
  });
}

export const getUnipileProviderStatus = createServerFn({ method: "GET" }).handler(async () => {
  const config = await providerConfig();
  return {
    configured: config.enabled,
    dsn: config.dsn,
    hasApiKey: !!config.apiKey,
  };
});

export const saveUnipileProviderConfig = createServerFn({ method: "POST" })
  .inputValidator(z.object({ dsn: z.string().url(), apiKey: z.string().min(10) }))
  .handler(async ({ data }) => {
    const config = {
      enabled: true,
      dsn: cleanDsn(data.dsn),
      apiKey: data.apiKey.trim(),
    };
    await writeStoredProviderConfig(config);
    return { success: true as const, dsn: config.dsn };
  });

export async function listUnipileAccountsRaw(): Promise<UnipileAccount[]> {
  const res = await unipileFetch("/api/v1/accounts", { method: "GET" });
  const raw: any = await parseJson(res);
  if (!res.ok) throw new Error(errorFrom(raw, `Unipile accounts request failed (${res.status}).`));
  const items = Array.isArray(raw?.items)
    ? raw.items
    : Array.isArray(raw?.accounts)
      ? raw.accounts
      : [];
  return items
    .map((item: any) => ({
      id: item.id,
      provider: item.provider,
      type: item.type,
      status: item.status,
      name: item.name || item.display_name || item.username,
      username: item.username || item.email,
      object: item.object,
    }))
    .filter((item: UnipileAccount) => item.id);
}

export const createUnipileHostedAuthLink = createServerFn({ method: "POST" })
  .inputValidator(z.object({ origin: z.string().url().optional() }).optional())
  .handler(async ({ data }) => {
    const config = await providerConfig();
    if (!config.dsn || !config.apiKey) {
      return { success: false as const, error: "Save Unipile provider config first." };
    }
    const origin = data?.origin?.replace(/\/+$/, "");
    const expiresOn = new Date(Date.now() + 30 * 60_000).toISOString();
    const body: Record<string, unknown> = {
      type: "create",
      providers: ["LINKEDIN"],
      api_url: config.dsn,
      expiresOn,
      name: "local-recruiter",
      bypass_success_screen: true,
      disabled_options: ["cookie_auth"],
      sync_limit: {
        MESSAGING: { chats: 100, messages: 30 },
      },
    };
    if (origin) {
      body.success_redirect_url = `${origin}/onboarding?unipile=success`;
      body.failure_redirect_url = `${origin}/onboarding?unipile=failed`;
    }

    const res = await unipileFetch("/api/v1/hosted/accounts/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const raw: any = await parseJson(res);
    if (!res.ok || !raw?.url) {
      return {
        success: false as const,
        error: errorFrom(raw, `Could not create Unipile hosted auth link (${res.status}).`),
        raw,
      };
    }
    return { success: true as const, url: raw.url as string, expiresOn };
  });

export const listUnipileAccounts = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const accounts = await listUnipileAccountsRaw();
    const stored = await readStoredAccount();
    return {
      success: true as const,
      accounts,
      activeAccountId: stored?.id || unipileConfig().accountId || "",
    };
  } catch (e) {
    return {
      success: false as const,
      error: (e as Error).message,
      accounts: [] as UnipileAccount[],
    };
  }
});

export const saveUnipileAccount = createServerFn({ method: "POST" })
  .inputValidator(z.object({ accountId: z.string().min(1) }))
  .handler(async ({ data }) => {
    const accounts = await listUnipileAccountsRaw();
    const account = accounts.find((item) => item.id === data.accountId);
    if (!account) return { success: false as const, error: "Unipile account not found." };
    await writeStoredAccount(account);
    return { success: true as const, account };
  });

export async function sendLinkedInMessageWithUnipile(input: {
  text: string;
  profileUrl?: string;
  threadUrl?: string;
  accountId?: string;
}): Promise<UnipileSendResult> {
  const config = await runtimeConfig(input.accountId);
  if (!config.enabled) {
    return {
      ok: false,
      provider: "unipile",
      error:
        "Unipile is not configured. Set UNIPILE_ENABLED=true, UNIPILE_DSN, UNIPILE_API_KEY, and UNIPILE_ACCOUNT_ID.",
    };
  }

  const text = input.text.trim();
  if (!text) return { ok: false, provider: "unipile", error: "Message body is empty." };

  const existingChatId = chatIdFromThreadUrl(input.threadUrl);
  if (existingChatId) {
    const res = await fetch(
      `${config.dsn}/api/v1/chats/${encodeURIComponent(existingChatId)}/messages`,
      {
        method: "POST",
        headers: headers(config),
        body: (() => {
          const form = new FormData();
          form.set("text", text);
          return form;
        })(),
      },
    );
    const raw = await parseJson(res);
    return res.ok
      ? {
          ok: true,
          provider: "unipile",
          chatId: existingChatId,
          messageId: raw?.id || raw?.message_id,
          raw,
        }
      : {
          ok: false,
          provider: "unipile",
          error: errorFrom(raw, `Unipile send failed (${res.status}).`),
          raw,
        };
  }

  const publicId = publicIdentifierFromProfileUrl(input.profileUrl);
  if (!publicId) {
    return {
      ok: false,
      provider: "unipile",
      error: "Unipile send needs a LinkedIn profile URL or existing thread URL.",
    };
  }

  const userRes = await fetch(
    `${config.dsn}/api/v1/users/${encodeURIComponent(publicId)}?account_id=${encodeURIComponent(config.accountId)}`,
    { headers: headers(config) },
  );
  const userRaw: any = await parseJson(userRes);
  if (!userRes.ok) {
    return {
      ok: false,
      provider: "unipile",
      error: errorFrom(userRaw, `Could not resolve LinkedIn user in Unipile (${userRes.status}).`),
      raw: userRaw,
    };
  }

  const providerId = userRaw?.provider_id || userRaw?.id;
  if (!providerId) {
    return {
      ok: false,
      provider: "unipile",
      error: "Unipile profile lookup did not return provider_id.",
      raw: userRaw,
    };
  }

  const form = new FormData();
  form.set("account_id", config.accountId);
  form.set("text", text);
  form.set("attendees_ids", providerId);

  const chatRes = await fetch(`${config.dsn}/api/v1/chats`, {
    method: "POST",
    headers: headers(config),
    body: form,
  });
  const chatRaw: any = await parseJson(chatRes);
  return chatRes.ok
    ? {
        ok: true,
        provider: "unipile",
        chatId: chatRaw?.id || chatRaw?.chat_id,
        messageId: chatRaw?.message_id,
        raw: chatRaw,
      }
    : {
        ok: false,
        provider: "unipile",
        error: errorFrom(chatRaw, `Unipile start chat failed (${chatRes.status}).`),
        raw: chatRaw,
      };
}
