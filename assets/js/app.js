/**
 * app.js — shared shell behavior used across every dashboard page:
 * theme (light/dark), sidebar toggle on mobile, toast notifications,
 * and active-link highlighting.
 */

const MCApp = (() => {
  const THEME_KEY = "mc_theme";

  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY) || "light";
    document.documentElement.setAttribute("data-theme", saved);
    updateThemeIcon(saved);
  }

  function toggleTheme() {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(THEME_KEY, next);
    updateThemeIcon(next);
  }

  function updateThemeIcon(theme) {
    const icon = document.getElementById("themeToggleIcon");
    if (icon) icon.className = theme === "dark" ? "bi bi-sun" : "bi bi-moon-stars";
  }

  function initSidebar() {
    const sidebar = document.getElementById("sidebar");
    const backdrop = document.getElementById("sidebarBackdrop");
    const openBtn = document.getElementById("sidebarOpenBtn");
    if (!sidebar) return;
    const close = () => { sidebar.classList.remove("open"); backdrop && backdrop.classList.remove("show"); };
    const open = () => { sidebar.classList.add("open"); backdrop && backdrop.classList.add("show"); };
    openBtn && openBtn.addEventListener("click", open);
    backdrop && backdrop.addEventListener("click", close);
  }

  function markActiveNav() {
    const page = document.body.getAttribute("data-page");
    if (!page) return;
    document.querySelectorAll(".sidebar .nav-link[data-page]").forEach((link) => {
      link.classList.toggle("active", link.getAttribute("data-page") === page);
    });
  }

  function toast(messageKeyOrText, type = "success") {
    let stack = document.querySelector(".toast-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "toast-stack";
      document.body.appendChild(stack);
    }
    const el = document.createElement("div");
    el.className = `mc-toast ${type}`;
    el.textContent = messageKeyOrText;
    stack.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity .2s ease";
      setTimeout(() => el.remove(), 200);
    }, 3200);
  }

  function init() {
    initTheme();
    initSidebar();
    markActiveNav();
    const themeBtn = document.getElementById("themeToggleBtn");
    themeBtn && themeBtn.addEventListener("click", toggleTheme);
  }

  return { init, toast, toggleTheme };
})();

document.addEventListener("DOMContentLoaded", () => MCApp.init());
