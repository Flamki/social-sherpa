const $ = (id) => document.getElementById(id);
const status = (msg, cls) => {
  const el = $("status");
  el.className = "status " + cls;
  el.textContent = msg;
};

chrome.storage.local.get(["endpoint"], ({ endpoint }) => {
  if (endpoint) $("endpoint").value = endpoint;
});

$("capture").addEventListener("click", async () => {
  const endpoint = $("endpoint").value.trim().replace(/\/$/, "");
  if (!endpoint) return status("Enter your workspace URL first.", "err");
  await chrome.storage.local.set({ endpoint });
  status("Reading LinkedIn cookies…", "ok");
  try {
    const names = ["li_at", "JSESSIONID", "bcookie", "li_rm"];
    const cookies = {};
    for (const name of names) {
      const c = await chrome.cookies.get({ url: "https://www.linkedin.com", name });
      if (c) cookies[name] = c.value;
    }
    if (!cookies.li_at) return status("li_at not found. Log in to linkedin.com first.", "err");
    const res = await fetch(endpoint + "/api/public/link-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cookies,
        capturedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
      }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    status("Linked. You can close this and return to the app.", "ok");
  } catch (e) {
    status("Capture failed: " + e.message, "err");
  }
});
