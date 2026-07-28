/**
 * dashboard.js
 * Renders stat cards, charts, and the recent-campaigns table.
 * Pulls live numbers from MCApi.Dashboard.stats() when a backend URL is
 * configured; otherwise shows clearly-labeled demo data so the UI is
 * always presentable while the Apps Script backend is being wired up.
 */

const DEMO_STATS = {
  totalDoctors: 4820,
  totalCampaigns: 37,
  messagesSent: 15230,
  delivered: 14710,
  read: 11890,
  failed: 320,
  performance: {
    labels: ["C1", "C2", "C3", "C4", "C5", "C6", "C7"],
    sent: [1200, 1900, 1400, 2100, 1750, 2400, 2200],
    delivered: [1150, 1830, 1350, 2050, 1690, 2320, 2140],
  },
  recent: [
    { name: "Cairo Cardiology Summit", date: "2026-07-20", recipients: 1200, delivered: 1150, status: "completed" },
    { name: "Radiology Update Webinar", date: "2026-07-18", recipients: 860, delivered: 790, status: "inProgress" },
    { name: "Pediatrics Conference Reminder", date: "2026-07-25", recipients: 640, delivered: 0, status: "scheduled" },
    { name: "Oncology Certificate Ready", date: "2026-07-10", recipients: 410, delivered: 402, status: "completed" },
    { name: "Dermatology Last Chance", date: "2026-07-05", recipients: 980, delivered: 915, status: "completed" },
  ],
};

const STAT_DEFS = [
  { key: "totalDoctors", icon: "bi-person-badge-fill", color: "var(--mc-primary)", bg: "var(--mc-primary-light)" },
  { key: "totalCampaigns", icon: "bi-megaphone-fill", color: "#9C6B18", bg: "rgba(232,163,61,.16)" },
  { key: "messagesSent", icon: "bi-send-fill", color: "var(--mc-accent-dark)", bg: "rgba(31,182,166,.14)" },
  { key: "delivered", icon: "bi-check2-circle", color: "var(--mc-accent-dark)", bg: "rgba(31,182,166,.14)" },
  { key: "read", icon: "bi-eye-fill", color: "var(--mc-primary)", bg: "var(--mc-primary-light)" },
  { key: "failed", icon: "bi-exclamation-triangle-fill", color: "var(--mc-danger)", bg: "rgba(214,69,80,.12)" },
];

function renderSkeletonCards() {
  const row = document.getElementById("statCardsRow");
  row.innerHTML = STAT_DEFS.map(() => `
    <div class="col-6 col-lg-2">
      <div class="stat-card">
        <div class="skeleton" style="width:42px;height:42px;border-radius:11px;margin-bottom:10px;"></div>
        <div class="skeleton" style="width:70%;height:22px;margin-bottom:6px;"></div>
        <div class="skeleton" style="width:50%;height:12px;"></div>
      </div>
    </div>`).join("");
}

function renderStatCards(stats) {
  const row = document.getElementById("statCardsRow");
  const fmt = (n) => new Intl.NumberFormat(I18N.lang === "ar" ? "ar-EG" : "en-US").format(n);
  row.innerHTML = STAT_DEFS.map((def) => `
    <div class="col-6 col-lg-2">
      <div class="stat-card">
        <div class="stat-icon" style="background:${def.bg};color:${def.color};"><i class="bi ${def.icon}"></i></div>
        <div class="stat-value">${fmt(stats[def.key] ?? 0)}</div>
        <div class="stat-label" data-i18n="dashboard.stats.${def.key}">${I18N.t(`dashboard.stats.${def.key}`)}</div>
      </div>
    </div>`).join("");
}

function renderRecentCampaigns(rows) {
  const body = document.getElementById("recentCampaignsBody");
  if (!rows || rows.length === 0) {
    body.innerHTML = `<tr><td colspan="5" class="text-center text-secondary py-4">${I18N.t("dashboard.empty")}</td></tr>`;
    return;
  }
  const dateFmt = new Intl.DateTimeFormat(I18N.lang === "ar" ? "ar-EG" : "en-US", { year: "numeric", month: "short", day: "numeric" });
  const numFmt = new Intl.NumberFormat(I18N.lang === "ar" ? "ar-EG" : "en-US");
  body.innerHTML = rows.map((c) => `
    <tr>
      <td class="fw-semibold">${c.name}</td>
      <td class="text-secondary">${dateFmt.format(new Date(c.date))}</td>
      <td>${numFmt.format(c.recipients)}</td>
      <td>${numFmt.format(c.delivered)}</td>
      <td><span class="badge-status ${c.status}" data-i18n="dashboard.status.${c.status}">${I18N.t(`dashboard.status.${c.status}`)}</span></td>
    </tr>`).join("");
}

let performanceChartInstance, statusChartInstance;

function renderCharts(stats) {
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const gridColor = document.documentElement.getAttribute("data-theme") === "dark" ? "rgba(255,255,255,.06)" : "rgba(15,45,56,.06)";

  const perfCtx = document.getElementById("performanceChart");
  performanceChartInstance && performanceChartInstance.destroy();
  performanceChartInstance = new Chart(perfCtx, {
    type: "line",
    data: {
      labels: stats.performance.labels,
      datasets: [
        { label: I18N.t("dashboard.charts.sent"), data: stats.performance.sent, borderColor: cssVar("--mc-primary"), backgroundColor: "transparent", tension: .35, pointRadius: 3 },
        { label: I18N.t("dashboard.charts.delivered"), data: stats.performance.delivered, borderColor: cssVar("--mc-accent"), backgroundColor: "transparent", tension: .35, pointRadius: 3 },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10, usePointStyle: true } } },
      scales: { x: { grid: { display: false } }, y: { grid: { color: gridColor } } },
    },
  });

  const statusCtx = document.getElementById("statusChart");
  statusChartInstance && statusChartInstance.destroy();
  statusChartInstance = new Chart(statusCtx, {
    type: "doughnut",
    data: {
      labels: [I18N.t("dashboard.charts.delivered"), I18N.t("dashboard.charts.read"), I18N.t("dashboard.charts.failed")],
      datasets: [{
        data: [stats.delivered - stats.read, stats.read, stats.failed],
        backgroundColor: [cssVar("--mc-primary"), cssVar("--mc-accent"), cssVar("--mc-danger")],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      cutout: "68%",
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10, usePointStyle: true } } },
    },
  });
}

async function loadDashboard() {
  renderSkeletonCards();
  let stats = DEMO_STATS;
  if (typeof MCApi !== "undefined" && MCApi.isConfigured()) {
    try {
      const res = await MCApi.Dashboard.stats();
      stats = res.stats;
    } catch (err) {
      MCApp.toast(I18N.t("common.error"), "error");
    }
  }
  renderStatCards(stats);
  renderRecentCampaigns(stats.recent);
  renderCharts(stats);
}

document.addEventListener("DOMContentLoaded", () => {
  // Wait for i18n to finish its first paint, then draw data-driven content.
  setTimeout(loadDashboard, 60);
});
I18N.onChange(() => loadDashboard());
