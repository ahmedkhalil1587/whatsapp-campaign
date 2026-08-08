/**
 * api.js — single point of contact with the Google Apps Script backend.
 * The Apps Script Web App URL is saved by the user on the Settings page
 * and stored in localStorage under "mc_gas_url". Every request goes
 * through this wrapper so auth headers / error handling stay in one place.
 */

const MCApi = (() => {
  const URL_KEY = "mc_gas_url";

  function getBaseUrl() {
    return localStorage.getItem(URL_KEY) || "";
  }

  function setBaseUrl(url) {
    localStorage.setItem(URL_KEY, url.trim());
  }

  function isConfigured() {
    return !!getBaseUrl();
  }

  /**
   * Apps Script Web Apps only reliably accept GET and POST, so every
   * action is sent as POST with an "action" field describing the intended
   * operation (mirrors REST verbs without needing PUT/DELETE support).
   */
  async function call(action, payload = {}) {
    const base = getBaseUrl();
    if (!base) throw new Error("Backend URL is not configured yet. Go to Settings first.");

    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // avoids CORS preflight on Apps Script
      body: JSON.stringify({ action, ...payload }),
    });

    if (!res.ok) throw new Error(`Backend request failed (${res.status})`);
    const data = await res.json();
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

  const Settings = {
    get: () => call("settings.get"),
    save: (settings) => call("settings.save", { settings }),
  };

  const Media = {
    upload: (filename, mimeType, base64) => call("media.upload", { filename, mimeType, base64 }),
  };

  return { call, getBaseUrl, setBaseUrl, isConfigured, Doctors, Campaigns, Templates, Dashboard, History, Settings, Media };
})();
