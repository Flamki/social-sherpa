import type { ProxyConfig } from "./linkedin.session";

type BrowserProxy = {
  server: string;
  username?: string;
  password?: string;
};

function proxyServer(proxy: ProxyConfig) {
  return /^\w+:\/\//.test(proxy.host)
    ? `${proxy.host}:${proxy.port}`
    : `http://${proxy.host}:${proxy.port}`;
}

function upstreamUrl(proxy: ProxyConfig) {
  const server = proxyServer(proxy);
  const url = new URL(server);
  if (proxy.username || proxy.password) {
    url.username = proxy.username || "";
    url.password = proxy.password || "";
  }
  return url.toString();
}

/**
 * Chromium can be unreliable with authenticated HTTP proxies on Windows.
 * proxy-chain exposes a local unauthenticated proxy and forwards to the
 * credentialed upstream proxy, so Playwright/Patchright only sees localhost.
 */
export async function browserProxyFor(proxy?: ProxyConfig): Promise<{
  proxy?: BrowserProxy;
  cleanup: () => Promise<void>;
}> {
  if (!proxy) return { cleanup: async () => {} };
  if (!proxy.username && !proxy.password) {
    return { proxy: { server: proxyServer(proxy) }, cleanup: async () => {} };
  }

  const { anonymizeProxy, closeAnonymizedProxy } = await import("proxy-chain");
  const localProxyUrl = await anonymizeProxy(upstreamUrl(proxy));
  return {
    proxy: { server: localProxyUrl },
    cleanup: async () => {
      await closeAnonymizedProxy(localProxyUrl, true).catch(() => {});
    },
  };
}

export function attachProxyCleanup(context: any, cleanup: () => Promise<void>) {
  const originalClose = context.close.bind(context);
  let closed = false;
  context.close = async (...args: any[]) => {
    try {
      return await originalClose(...args);
    } finally {
      if (!closed) {
        closed = true;
        await cleanup();
      }
    }
  };
}
