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

  /** Call at the top of every protected page. */
  function guard() {
    if (!isLoggedIn()) window.location.href = "login.html";
  }

  return { login, logout, guard, isLoggedIn, getSession };
})();
