/**
 * api.js — single point of contact with the backend.
 * The backend URL can be overridden per-device on the Settings page (stored
 * in localStorage under "mc_gas_url"), and ships with a hardcoded
 * DEFAULT_GAS_URL below so that public pages like signup.html / login.html
 * work for visitors who have never logged in (and so never had a chance to
 * save anything to their browser's localStorage).
 *
 * Self-healing default: every device auto-adopts DEFAULT_GAS_URL whenever
 * DEFAULT_URL_VERSION is bumped below, even if that device previously saved
 * a different (now-stale) URL on the Settings page. This is how a backend
 * move (like this Apps Script -> Cloudflare Worker migration) reaches every
 * device automatically, with nobody needing to open Settings on each one.
 * To move the backend again in the future: change DEFAULT_GAS_URL AND bump
 * DEFAULT_URL_VERSION by 1 -- that's it, every device self-migrates on its
 * next page load. A manually-saved override still works in between moves.
 *
 * Every request goes through this wrapper so auth headers / error handling
 * stay in one place.
 */

const MCApi = (() => {
  const URL_KEY = "mc_gas_url";
  const URL_VERSION_KEY = "mc_gas_url_v";
  // Current backend URL. Bump DEFAULT_URL_VERSION below whenever this changes.
  const DEFAULT_GAS_URL = "https://whatsapp-campaign-api.madlouh.workers.dev";
  const DEFAULT_URL_VERSION = "2"; // bump this +1 every time DEFAULT_GAS_URL changes

  function getBaseUrl() {
    if (localStorage.getItem(URL_VERSION_KEY) !== DEFAULT_URL_VERSION) {
      // Stale or first-ever visit: adopt the current default and remember
      // that this device is now caught up to DEFAULT_URL_VERSION.
      localStorage.setItem(URL_KEY, DEFAULT_GAS_URL);
      localStorage.setItem(URL_VERSION_KEY, DEFAULT_URL_VERSION);
      return DEFAULT_GAS_URL;
    }
    return localStorage.getItem(URL_KEY) || DEFAULT_GAS_URL;
  }

  function setBaseUrl(url) {
    localStorage.setItem(URL_KEY, url.trim());
    localStorage.setItem(URL_VERSION_KEY, DEFAULT_URL_VERSION); // manual save counts as caught up
  }

  function isConfigured() {
    return !!getBaseUrl();
  }

  /**
   * Apps Script Web Apps only reliably accept GET and POST, so every
   * action is sent as POST with an "action" field describing the intended
   * operation (mirrors REST verbs without needing PUT/DELETE support).
   * The session token (issued at login) rides along automatically so the
   * backend can verify identity and role on every request — not just the
   * UI hiding buttons.
   */
  async function call(action, payload = {}) {
    const base = getBaseUrl();
    if (!base) throw new Error("Backend URL is not configured yet. Go to Settings first.");

    const session = (typeof MCAuth !== "undefined" && MCAuth.getSession) ? MCAuth.getSession() : null;
    const token = session && session.token;

    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // avoids CORS preflight on Apps Script
      body: JSON.stringify({ action, token, ...payload }),
    });

    if (!res.ok) throw new Error(`Backend request failed (${res.status})`);
    const data = await res.json();
    // NOTE: an automatic "force logout on session-expired error" used to
    // live here. It caused more harm than good — a transient hiccup (a
    // slow request, several calls landing at once when switching chats,
    // etc.) could get misread as a dead session and boot someone out of
    // an active session, mid-work, for no real reason. Removed — a
    // failed call just surfaces its error like any other; only an
    // actual expired/invalid session (caught by MCAuth.guard() on the
    // next page load) sends someone back to login.
    if (data && data.ok === false) throw new Error(data.error || "Backend returned an error");
    return data;
  }

  // ---- Convenience methods matching the Apps Script router (see backend/Code.gs) ----
  const Doctors = {
    list: (params = {}) => call("doctors.list", params),
    create: (doctor) => call("doctors.create", { doctor }),
    update: (id, doctor) => call("doctors.update", { id, doctor }),
    remove: (id) => call("doctors.delete", { id }),
    bulkImport: (rows) => call("doctors.bulkImport", { rows }),
  };

  const Campaigns = {
    list: (params = {}) => call("campaigns.list", params),
    create: (campaign) => call("campaigns.create", { campaign }),
    send: (id) => call("campaigns.send", { id }),
    retryFailed: (id) => call("campaigns.retryFailed", { id }),
    logs: (id) => call("campaigns.logs", { id }),
    pause: (id) => call("campaigns.pause", { id }),
    resume: (id) => call("campaigns.resume", { id }),
  };

  const Templates = {
    list: () => call("templates.list"),
    create: (template) => call("templates.create", { template }),
    update: (id, template) => call("templates.update", { id, template }),
    remove: (id) => call("templates.delete", { id }),
  };

  const Dashboard = {
    stats: () => call("dashboard.stats"),
  };

  const History = {
    list: () => call("history.list"),
  };

  const Inbox = {
    list: () => call("inbox.list"),
    thread: (mobile) => call("inbox.thread", { mobile }),
    send: (mobile, text) => call("inbox.send", { mobile, text }),
    sendMedia: (mobile, mediaUrl, mediaType, caption, filename) => call("inbox.sendMedia", { mobile, mediaUrl, mediaType, caption, filename }),
    markRead: (mobile, timestamp) => call("inbox.markRead", { mobile, timestamp }),
    agentStatsRange: (startDate, endDate) => call("inbox.agentStatsRange", { startDate, endDate }),
    startNewConversation: (mobile) => call("inbox.startNewConversation", { mobile }),
    sendQrSeha: (mobile) => call("inbox.sendQrSeha", { mobile }),
    sendReportRequest: (mobile) => call("inbox.sendReportRequest", { mobile }),
    search: (query) => call("inbox.search", { query }),
    pin: (mobile) => call("inbox.pin", { mobile }),
    unpin: (mobile) => call("inbox.unpin", { mobile }),
  };

  const Settings = {
    get: () => call("settings.get"),
    save: (settings) => call("settings.save", { settings }),
  };

  const Media = {
    upload: (filename, mimeType, base64) => call("media.upload", { filename, mimeType, base64 }),
  };

  const AuthApi = {
    register: (name, email, password) => call("auth.register", { name, email, password }),
    verify: (email, code) => call("auth.verify", { email, code }),
  };

  const Signups = {
    list: () => call("signups.list"),
    approve: (id, role) => call("signups.approve", { id, role }),
    reject: (id) => call("signups.reject", { id }),
  };

  return { call, getBaseUrl, setBaseUrl, isConfigured, Doctors, Campaigns, Templates, Dashboard, History, Inbox, Settings, Media, AuthApi, Signups };
})();
