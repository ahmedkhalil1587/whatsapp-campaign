/**
 * auth.js
 * Simple session handling. If a Google Apps Script backend URL is
 * configured (Settings page), credentials are verified against the
 * "Users" sheet via auth.login. Otherwise it falls back to a local demo
 * account (admin / admin123) so the UI is fully clickable before the
 * backend is wired up.
 */

const MCAuth = (() => {
  const SESSION_KEY = "mc_session";
  const DEMO_USER = { username: "admin", password: "admin123", name: "Admin" };

  function getSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY)); }
    catch { return null; }
  }

  function isLoggedIn() {
    return !!getSession();
  }

  async function login(username, password, remember) {
    let user = null;

    if (typeof MCApi !== "undefined" && MCApi.isConfigured()) {
      const res = await MCApi.call("auth.login", { username, password });
      user = res.user;
      if (user) user.token = res.token;
    } else if (username === DEMO_USER.username && password === DEMO_USER.password) {
      user = { username: DEMO_USER.username, name: DEMO_USER.name, role: "admin" };
    }

    if (!user) throw new Error("invalid");

    const payload = JSON.stringify({ ...user, loggedInAt: Date.now() });
    (remember ? localStorage : sessionStorage).setItem(SESSION_KEY, payload);
    return user;
  }

  function logout() {
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    window.location.href = "login.html";
  }

  // Pages a non-admin role is allowed to see. Deny-by-default: any role
  // other than "admin" (including missing/unrecognized roles) only gets
  // this restricted set. Add more roles here later if needed.
  const ROLE_ALLOWED_PAGES = {
    agent: ["doctors", "inbox"],
  };
  const FALLBACK_PAGE = "doctors.html";

  function currentRole() {
    const session = getSession();
    return (session && session.role) || "admin";
  }

  function isAdmin() {
    return currentRole() === "admin";
  }

  /** Hides sidebar links the current role isn't allowed to see. Safe to call on every page. */
  function applyRoleUI() {
    if (isAdmin()) return;
    const allowed = ROLE_ALLOWED_PAGES[currentRole()] || [];
    document.querySelectorAll(".sidebar .nav-link[data-page]").forEach((link) => {
      if (!allowed.includes(link.getAttribute("data-page"))) link.style.display = "none";
    });
  }

  /** Redirects away if the current role isn't allowed on this page. Safe to call on every page. */
  function enforcePageAccess() {
    if (isAdmin()) return;
    const allowed = ROLE_ALLOWED_PAGES[currentRole()] || [];
    const page = document.body.getAttribute("data-page");
    if (page && !allowed.includes(page)) window.location.href = FALLBACK_PAGE;
  }

  /** Call at the top of every protected page. */
  function guard() {
    if (!isLoggedIn()) { window.location.href = "login.html"; return; }
    enforcePageAccess();
    applyRoleUI();
  }

  return { login, logout, guard, isLoggedIn, getSession, isAdmin, currentRole };
})();
