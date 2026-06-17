/**
 * Browser-driven LinkedIn messaging.
 *
 * LinkedIn's Voyager messaging endpoints now reject some otherwise-valid browser sessions.
 * This helper uses the logged-in browser profile instead: open profile/thread, type into the
 * real composer, click Send, and only report success after the composer clears.
 */

type Cookies = { li_at: string; JSESSIONID: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (min: number, max: number) => min + Math.random() * (max - min);

async function closeOpened(opened: { persistCookies?: () => Promise<void>; context: any }) {
  await opened.persistCookies?.().catch(() => {});
  await opened.context.close().catch(() => {});
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

async function readBody(page: any, timeout = 5_000) {
  return page
    .locator("body")
    .innerText({ timeout })
    .catch(() => "");
}

async function clickVisible(locators: any[], timeout = 5_000) {
  for (const loc of locators) {
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 8); i++) {
      const item = loc.nth(i);
      if (await item.isVisible().catch(() => false)) {
        try {
          await item.click({ timeout });
          return true;
        } catch {
          /* try next visible match */
        }
      }
    }
  }
  return false;
}

async function visibleEditor(page: any) {
  const candidates = [
    page.locator(".msg-overlay-conversation-bubble--is-active .msg-form__contenteditable"),
    page.locator(".msg-form__contenteditable[contenteditable='true']"),
    page.locator(".msg-form__msg-content-container [contenteditable='true']"),
    page.locator("[role='textbox'][contenteditable='true']"),
    page.locator("textarea[name='message']"),
  ];
  for (const loc of candidates) {
    const n = await loc.count().catch(() => 0);
    for (let i = n - 1; i >= 0; i--) {
      const item = loc.nth(i);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return null;
}

async function clickMessageByDom(page: any) {
  return page
    .evaluate(() => {
      const visible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || "1") > 0
        );
      };
      const textOf = (el: Element) => (el.textContent || "").replace(/\s+/g, " ").trim();
      const labelOf = (el: Element) => el.getAttribute("aria-label") || "";
      const interactiveSelector = "button,a,[role='button'],[role='menuitem']";
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          `${interactiveSelector}, .artdeco-dropdown__content li, .artdeco-dropdown__content div`,
        ),
      )
        .filter(visible)
        .map((el) => {
          const interactive = (el.closest(interactiveSelector) as HTMLElement | null) || el;
          return { el: interactive, text: textOf(el), label: labelOf(interactive) || labelOf(el) };
        })
        .filter(
          ({ el, text, label }, index, arr) =>
            arr.findIndex((candidate) => candidate.el === el) === index &&
            visible(el) &&
            (/^Message\b/i.test(text) || /^Message\b/i.test(label)),
        )
        .sort((a, b) => {
          const aMenu = a.el.closest(".artdeco-dropdown__content") ? 0 : 1;
          const bMenu = b.el.closest(".artdeco-dropdown__content") ? 0 : 1;
          return aMenu - bMenu;
        });
      const target = candidates[0]?.el;
      if (!target) return false;
      target.click();
      return true;
    })
    .catch(() => false);
}

async function clickComposerSendByDom(page: any) {
  return page
    .evaluate(() => {
      const visible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || "1") > 0
        );
      };
      const disabled = (el: HTMLElement) =>
        el.hasAttribute("disabled") ||
        el.getAttribute("aria-disabled") === "true" ||
        el.classList.contains("disabled");
      const textOf = (el: Element) => (el.textContent || "").replace(/\s+/g, " ").trim();
      const labelOf = (el: Element) => el.getAttribute("aria-label") || "";
      const editors = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".msg-form__contenteditable[contenteditable='true'], [role='textbox'][contenteditable='true'], textarea[name='message']",
        ),
      ).filter(visible);
      const editor = editors[editors.length - 1];
      const scope =
        editor?.closest("form") ||
        editor?.closest(".msg-form") ||
        editor?.closest(".msg-overlay-conversation-bubble") ||
        document.body;
      const buttons = Array.from(scope.querySelectorAll<HTMLElement>("button,[role='button']"));
      const target = buttons.find((button) => {
        if (!visible(button) || disabled(button)) return false;
        const text = textOf(button);
        const label = labelOf(button);
        return /^Send$/i.test(text) || /^Send$/i.test(label) || /send message/i.test(label);
      });
      if (!target) return false;
      target.click();
      return true;
    })
    .catch(() => false);
}

async function typeAndSendFromComposer(page: any, body: string) {
  const editor = await visibleEditor(page);
  if (!editor) {
    return { ok: false, error: "Message composer did not open." };
  }

  await editor.click({ timeout: 8_000 });
  await editor.fill("").catch(() => {});
  const filled = await editor.fill(body).then(
    () => true,
    () => false,
  );
  if (!filled) {
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.type(body, { delay: Math.round(jitter(18, 42)) });
  }

  await sleep(jitter(600, 1_100));
  const beforeSend = cleanText((await editor.innerText().catch(() => "")) || "");
  if (!beforeSend.includes(cleanText(body).slice(0, 40))) {
    return { ok: false, error: "Could not type the message into LinkedIn's composer." };
  }

  let sent = await clickVisible(
    [
      page.locator("button.msg-form__send-button:not([disabled])"),
      page.getByRole("button", { name: /^Send$/i }),
      page.locator("button[aria-label='Send']"),
      page.locator("button[aria-label*='Send']"),
      page.locator(".msg-form button").filter({ hasText: /^Send$/i }),
    ],
    6_000,
  );
  if (!sent) sent = await clickComposerSendByDom(page);
  if (!sent)
    return { ok: false, error: "Message composer opened, but no Send button was available." };

  await sleep(jitter(1_200, 2_200));
  const pageText = await readBody(page, 4_000);
  if (/couldn'?t send|failed to send|not sent|try again/i.test(pageText)) {
    return { ok: false, error: "LinkedIn showed a send failure in the message composer." };
  }

  const afterEditor = cleanText((await editor.innerText().catch(() => "")) || "");
  if (afterEditor.includes(cleanText(body).slice(0, 40))) {
    return {
      ok: false,
      error: "Clicked Send, but LinkedIn kept the message in the composer.",
    };
  }
  return { ok: true };
}

async function validateLinkedInPage(page: any) {
  const url = page.url();
  if (/\/checkpoint/i.test(url))
    return "LinkedIn checkpoint appeared. Clear it manually, then retry.";
  if (/\/login|\/uas\/login|\/authwall/i.test(url)) {
    return "LinkedIn session expired while opening the message page. Reconnect.";
  }
  return "";
}

export async function sendLinkedInMessageViaProfileUi(opts: {
  cookies: Cookies;
  headless: boolean;
  profileUrl: string;
  body: string;
}) {
  const targetUrl = opts.profileUrl.trim();
  const body = opts.body.trim().slice(0, 2_000);
  if (!/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/(in|pub)\//i.test(targetUrl)) {
    return {
      ok: false,
      error:
        "DM needs the connection's full LinkedIn profile URL. Re-import this connection so the profile URL is stored.",
    };
  }
  if (!body) return { ok: false, error: "Message action missing body." };

  const { openLinkedIn } = await import("./linkedin.browser");
  const opened = await openLinkedIn({ cookies: opts.cookies, headless: opts.headless });
  if (!opened.ok) return { ok: false, error: opened.error };
  const { page } = opened;

  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await sleep(jitter(1_800, 3_000));
    const pageError = await validateLinkedInPage(page);
    if (pageError) {
      await closeOpened(opened);
      return { ok: false, error: pageError };
    }

    let clickedMessage = await clickVisible([
      page.getByRole("button", { name: /^Message\b/i }),
      page.getByRole("link", { name: /^Message\b/i }),
      page.locator("button[aria-label^='Message']"),
      page.locator("a[aria-label^='Message']"),
      page.locator("button").filter({ hasText: /^Message\b/i }),
    ]);
    if (!clickedMessage) clickedMessage = await clickMessageByDom(page);
    if (!clickedMessage) {
      const openedMore = await clickVisible([
        page.getByRole("button", { name: /^More/i }),
        page.locator("button[aria-label*='More actions']"),
        page.locator("button").filter({ hasText: /^More$/i }),
      ]);
      if (openedMore) {
        await sleep(jitter(600, 1_100));
        clickedMessage = await clickVisible([
          page.getByRole("menuitem", { name: /^Message\b/i }),
          page.locator("[role='menuitem']").filter({ hasText: /^Message\b/i }),
          page.locator(".artdeco-dropdown__content button").filter({ hasText: /^Message\b/i }),
          page.locator(".artdeco-dropdown__content li").filter({ hasText: /^Message\b/i }),
        ]);
        if (!clickedMessage) clickedMessage = await clickMessageByDom(page);
      }
    }
    if (!clickedMessage) {
      await closeOpened(opened);
      return {
        ok: false,
        error: "No Message button found. LinkedIn may not allow DMs to this profile.",
      };
    }
    await sleep(jitter(1_000, 1_800));

    const result = await typeAndSendFromComposer(page, body);
    await closeOpened(opened);
    return result;
  } catch (e) {
    await closeOpened(opened);
    return { ok: false, error: (e as Error).message };
  }
}

export async function sendLinkedInMessageViaThreadUi(opts: {
  cookies: Cookies;
  headless: boolean;
  threadUrl: string;
  body: string;
}) {
  const threadUrl = opts.threadUrl.trim();
  const body = opts.body.trim().slice(0, 2_000);
  if (!/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/messaging\/thread\//i.test(threadUrl)) {
    return { ok: false, error: "Could not parse thread id from message action." };
  }
  if (!body) return { ok: false, error: "Message action missing body." };

  const { openLinkedIn } = await import("./linkedin.browser");
  const opened = await openLinkedIn({ cookies: opts.cookies, headless: opts.headless });
  if (!opened.ok) return { ok: false, error: opened.error };
  const { page } = opened;

  try {
    await page.goto(threadUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await sleep(jitter(2_000, 3_500));
    const pageError = await validateLinkedInPage(page);
    if (pageError) {
      await closeOpened(opened);
      return { ok: false, error: pageError };
    }
    const result = await typeAndSendFromComposer(page, body);
    await closeOpened(opened);
    return result;
  } catch (e) {
    await closeOpened(opened);
    return { ok: false, error: (e as Error).message };
  }
}
