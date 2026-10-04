// Injected into the Outlook Web window. Reads the inbox list from the page and reports it to
// Flight Deck via `report_outlook_inbox`. That and hiding its own window are all this window is
// allowed to do.
// Depends on Outlook's markup (message rows carry `data-convid`, unread rows have an aria-label
// starting with "Unread", fields are placed around the time span; see readRow), so it will need
// adjusting when Microsoft changes the UI.
(function () {
  const HOSTS = ["outlook.office.com", "outlook.office365.com", "outlook.cloud.microsoft"];
  if (window.top !== window || !HOSTS.includes(location.hostname)) return;

  const MAX_MESSAGES = 60;
  let lastSent = "";

  function onInbox() {
    // /mail/, /mail/0/, /mail/inbox, /mail/0/inbox/id/... but not other folders.
    return /^\/mail(\/\d+)?\/?(inbox(\/|$)|$)/i.test(location.pathname);
  }

  function readUnreadCount() {
    for (const item of document.querySelectorAll('[role="treeitem"]')) {
      const label = item.getAttribute("aria-label") || item.getAttribute("title") || "";
      if (!/^inbox\b/i.test(label.trim())) continue;
      const m = label.match(/(\d+)\s*unread/i);
      if (m) return Number(m[1]);
      const badge = [...item.querySelectorAll("span")].map((s) => s.textContent.trim()).find((t) => /^\d+$/.test(t));
      if (badge) return Number(badge);
      return 0;
    }
    return null;
  }

  const clean = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");

  // Every row has a time span whose title is the full date ("Sun 9/27/2026 11:25 AM"). The other
  // fields sit around it: subject just before it, the sender line above it, the preview below.
  function readRow(row) {
    const timeEl = [...row.querySelectorAll("span[title]")].find((el) => /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(el.title));
    if (!timeEl) return null;
    const line = timeEl.parentElement;
    const avatar = row.querySelector('[role="img"][aria-label]');
    const sender =
      clean(line.previousElementSibling && line.previousElementSibling.firstElementChild) ||
      (avatar ? avatar.getAttribute("aria-label").trim() : "");
    return {
      // Some display names end in a dash ("Password Expire Reminder -").
      sender: sender.replace(/\s*-$/, ""),
      subject: clean(timeEl.previousElementSibling),
      time: clean(timeEl),
      preview: clean(line.nextElementSibling).slice(0, 240),
    };
  }

  function readMessages() {
    const seen = new Set();
    const messages = [];
    for (const row of document.querySelectorAll("[data-convid]")) {
      const id = row.getAttribute("data-convid");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const fields = readRow(row);
      if (!fields) continue;
      const label = (row.getAttribute("aria-label") || "").trim();
      messages.push({ id, unread: /^unread\b/i.test(label), ...fields });
      if (messages.length >= MAX_MESSAGES) break;
    }
    return messages;
  }


  function report() {
    const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (!invoke || !onInbox()) return;
    const messages = readMessages();
    const counted = readUnreadCount();
    const inbox = {
      signed_in: messages.length > 0 || counted !== null,
      unread_count: counted ?? messages.filter((m) => m.unread).length,
      messages,
    };
    const json = JSON.stringify(inbox);
    if (json === lastSent) return;
    lastSent = json;
    invoke("report_outlook_inbox", { inbox }).catch(() => {
      lastSent = "";
    });
  }

  let timer = null;
  function schedule() {
    if (!document.getElementById("flight-deck-reload")) ensureReloadButton();
    clearTimeout(timer);
    timer = setTimeout(report, 1500);
  }

  // When the page can't load (e.g. the network isn't up yet at login), Outlook's service worker
  // serves a cached offline page, often shown as raw source. Nothing on it retries by itself, so
  // reload until Outlook itself comes back.
  const OFFLINE_RETRY_MS = 15000;
  function isOfflinePage() {
    return !!document.getElementById("offlinePage") || (document.body?.textContent || "").includes('id="offlinePage"');
  }

  // The window has no browser chrome, so a small floating button (besides F5) reloads the page.
  // In a shadow root so Outlook's styles don't reach it. Built with DOM calls, not innerHTML:
  // Outlook enforces Trusted Types, which rejects HTML strings.
  const SVG_NS = "http://www.w3.org/2000/svg";
  function addReloadButton() {
    if (!document.body || document.getElementById("flight-deck-reload")) return;
    const host = document.createElement("div");
    host.id = "flight-deck-reload";
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      button {
        width: 34px; height: 34px; border-radius: 50%; border: 1px solid rgba(255,255,255,.25);
        background: rgba(15,23,42,.85); color: #fbbf24; cursor: pointer; opacity: .7;
        display: grid; place-items: center; padding: 0; box-shadow: 0 2px 8px rgba(0,0,0,.35);
        transition: opacity .15s, transform .15s;
      }
      button:hover { opacity: 1; transform: rotate(-30deg); }`;
    const button = document.createElement("button");
    button.title = "Reload Outlook (F5)";
    button.setAttribute("aria-label", "Reload Outlook");
    const svg = document.createElementNS(SVG_NS, "svg");
    for (const [k, v] of Object.entries({
      width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
      "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round",
    })) svg.setAttribute(k, v);
    for (const d of ["M21 12a9 9 0 1 1-2.64-6.36", "M21 3v6h-6"]) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    button.appendChild(svg);
    button.addEventListener("click", () => location.reload());
    root.append(style, button);
    document.body.appendChild(host);
  }
  // Never let the button break the scraper.
  function ensureReloadButton() {
    try {
      addReloadButton();
    } catch (e) {
      console.warn("flight deck: reload button", e);
    }
  }

  function start() {
    ensureReloadButton();
    if (isOfflinePage()) {
      setTimeout(() => location.reload(), OFFLINE_RETRY_MS);
      window.addEventListener("online", () => location.reload());
      return;
    }
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
    schedule();
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);

  // Ctrl+W hides the window, like closing it. F5 reloads the page, since the webview has no
  // reload shortcut of its own (Ctrl+R is left alone: it is Outlook's Reply). Capture phase so
  // Outlook's own shortcuts don't swallow them.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "F5" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        location.reload();
        return;
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        e.stopPropagation();
        const internals = window.__TAURI_INTERNALS__;
        if (internals) internals.invoke("plugin:window|hide", { label: "outlook" });
      }
    },
    true,
  );

  // Called by Flight Deck (via eval) for "Fill brief": always sends a report, even if nothing
  // changed. Goes back to the Inbox first if another folder is open, and gives a page that is
  // still loading up to 10s to show its messages before reporting it as signed out.
  window.__flightDeckReport = function () {
    if (isOfflinePage()) {
      location.reload();
      return;
    }
    if (!onInbox()) {
      location.href = "/mail/";
      return;
    }
    let attempts = 10;
    (function tryReport() {
      const ready = readMessages().length > 0 || readUnreadCount() !== null;
      if (!ready && attempts-- > 0) {
        setTimeout(tryReport, 1000);
        return;
      }
      lastSent = "";
      report();
    })();
  };

  // Called by Flight Deck (via eval) to open a message clicked on the dashboard.
  window.__flightDeckOpen = function (id) {
    const row = [...document.querySelectorAll("[data-convid]")].find((r) => r.getAttribute("data-convid") === id);
    if (row) row.click();
  };
})();
