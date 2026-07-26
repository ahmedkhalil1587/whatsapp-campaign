/**
 * settings.js
 * Handles the three forms on settings.html: backend URL, WhatsApp Cloud
 * API credentials, and branding. WhatsApp secrets are only ever read as
 * "is a token saved?" — the actual token is never sent back to the browser
 * (see backend/Code.gs getPublicSettings_).
 */

const BRAND_KEY = "mc_brand";

function refreshConnectionBadge() {
  const badge = document.getElementById("connectionBadge");
  const configured = MCApi.isConfigured();
  badge.classList.toggle("alert-warning", !configured);
  badge.classList.toggle("alert-success", configured);
  badge.querySelector("span").textContent = configured
    ? MCApi.getBaseUrl()
    : I18N.t("settings.notConfiguredYet");
}

async function loadSettingsForm() {
  document.getElementById("backendUrl").value = MCApi.getBaseUrl();
  refreshConnectionBadge();

  if (!MCApi.isConfigured()) return;
  try {
    const res = await MCApi.Settings.get();
    const s = res.settings || {};
    document.getElementById("phoneNumberId").value = s.phoneNumberId || "";
    document.getElementById("businessId").value = s.businessId || "";
    document.getElementById("webhookToken").value = s.webhookVerifyToken || "";
    const tokenBadge = document.getElementById("tokenBadge");
    tokenBadge.textContent = I18N.t(s.hasAccessToken ? "settings.tokenSavedBadge" : "settings.tokenMissingBadge");
    tokenBadge.className = "badge-status mt-2 d-inline-block " + (s.hasAccessToken ? "completed" : "draft");
  } catch (err) {
    MCApp.toast(I18N.t("common.error"), "error");
  }
}

function loadBrandForm() {
  try {
    const brand = JSON.parse(localStorage.getItem(BRAND_KEY) || "{}");
    if (brand.logo) document.getElementById("companyLogo").value = brand.logo;
    if (brand.color) document.getElementById("primaryColor").value = brand.color;
  } catch { /* ignore */ }
}

document.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => { loadSettingsForm(); loadBrandForm(); }, 60);

  document.getElementById("backendForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const url = document.getElementById("backendUrl").value.trim();
    if (!url) return;
    MCApi.setBaseUrl(url);
    refreshConnectionBadge();
    MCApp.toast(I18N.t("settings.savedToast"));
  });

  document.getElementById("testConnectionBtn").addEventListener("click", async () => {
    const url = document.getElementById("backendUrl").value.trim();
    const result = document.getElementById("testResult");
    const btn = document.getElementById("testConnectionBtn");
    if (!url) return;

    const previousUrl = MCApi.getBaseUrl();
    MCApi.setBaseUrl(url); // test against whatever is currently typed, even if not saved yet
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = I18N.t("settings.testing");
    result.className = "small mt-2";
    result.textContent = "";

    try {
      await MCApi.call("settings.get");
      result.classList.add("text-success");
      result.textContent = "✓ " + I18N.t("settings.testOk");
    } catch (err) {
      result.classList.add("text-danger");
      result.textContent = "✗ " + I18N.t("settings.testFail");
      MCApi.setBaseUrl(previousUrl || "");
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
      refreshConnectionBadge();
    }
  });

  document.getElementById("waForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!MCApi.isConfigured()) { MCApp.toast(I18N.t("common.error"), "error"); return; }
    const payload = {
      phoneNumberId: document.getElementById("phoneNumberId").value.trim(),
      businessId: document.getElementById("businessId").value.trim(),
      webhookVerifyToken: document.getElementById("webhookToken").value.trim(),
    };
    const token = document.getElementById("accessToken").value.trim();
    if (token) payload.accessToken = token;

    try {
      await MCApi.Settings.save(payload);
      document.getElementById("accessToken").value = "";
      MCApp.toast(I18N.t("settings.savedToast"));
      loadSettingsForm();
    } catch (err) {
      MCApp.toast(I18N.t("common.error"), "error");
    }
  });

  document.getElementById("brandForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const brand = {
      logo: document.getElementById("companyLogo").value.trim(),
      color: document.getElementById("primaryColor").value,
    };
    localStorage.setItem(BRAND_KEY, JSON.stringify(brand));
    document.documentElement.style.setProperty("--mc-primary", brand.color);
    MCApp.toast(I18N.t("settings.savedToast"));
  });
});
