/**
 * i18n.js — lightweight translation engine
 * - No page reload on language switch
 * - Persists choice in localStorage ("mc_lang")
 * - Falls back to browser language on first visit
 * - Flips Bootstrap between LTR / RTL builds automatically
 */

const I18N = (() => {
  const STORAGE_KEY = "mc_lang";
  const SUPPORTED = ["en", "ar"];
  const BOOTSTRAP_LTR = "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css";
  const BOOTSTRAP_RTL = "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.rtl.min.css";

  let currentLang = "en";
  let dict = {};
  const listeners = [];

  function detectInitialLang() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED.includes(saved)) return saved;
    const browserLang = (navigator.language || "en").slice(0, 2).toLowerCase();
    return SUPPORTED.includes(browserLang) ? browserLang : "en";
  }

  function get(path) {
    return path.split(".").reduce((obj, key) => (obj && obj[key] !== undefined ? obj[key] : undefined), dict);
  }

  function applyBootstrapDirection(lang) {
    const link = document.getElementById("bootstrap-css");
    if (!link) return;
    link.href = lang === "ar" ? BOOTSTRAP_RTL : BOOTSTRAP_LTR;
  }

  function applyDomDirection(lang) {
    const dir = lang === "ar" ? "rtl" : "ltr";
    document.documentElement.setAttribute("lang", lang);
    document.documentElement.setAttribute("dir", dir);
  }

  function translateDom() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const value = get(el.getAttribute("data-i18n"));
      if (value !== undefined) el.textContent = value;
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      const value = get(el.getAttribute("data-i18n-placeholder"));
      if (value !== undefined) el.setAttribute("placeholder", value);
    });
    document.querySelectorAll("[data-i18n-html]").forEach((el) => {
      const value = get(el.getAttribute("data-i18n-html"));
      if (value !== undefined) el.innerHTML = value;
    });
    document.title = get("meta.appName") || document.title;
  }

  function updateLangToggleUI() {
    document.querySelectorAll("[data-lang-option]").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-lang-option") === currentLang);
    });
  }

  async function loadDict(lang) {
    const res = await fetch(`assets/lang/${lang}.json`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load language file: ${lang}`);
    return res.json();
  }

  async function setLang(lang, { silent = false } = {}) {
    if (!SUPPORTED.includes(lang)) lang = "en";
    dict = await loadDict(lang);
    currentLang = lang;
    localStorage.setItem(STORAGE_KEY, lang);
    applyDomDirection(lang);
    applyBootstrapDirection(lang);
    translateDom();
    updateLangToggleUI();
    if (!silent) listeners.forEach((fn) => fn(lang));
  }

  function onChange(fn) {
    listeners.push(fn);
  }

  async function init() {
    const lang = detectInitialLang();
    await setLang(lang, { silent: true });
    document.querySelectorAll("[data-lang-option]").forEach((btn) => {
      btn.addEventListener("click", () => setLang(btn.getAttribute("data-lang-option")));
    });
  }

  return {
    init,
    setLang,
    t: get,
    onChange,
    get lang() { return currentLang; },
  };
})();

document.addEventListener("DOMContentLoaded", () => I18N.init());
