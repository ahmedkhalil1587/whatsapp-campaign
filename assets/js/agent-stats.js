/**
 * agent-stats.js
 * Admin-only page: lets management pick a date range and see each
 * customer-service agent's share of outbound replies in that period —
 * for performance reviews — with a bar/doughnut chart and an Excel
 * export. Backed by the "inbox.agentStatsRange" action (see Code.gs),
 * which is intentionally NOT in AGENT_ALLOWED_ACTIONS_ so agents can't
 * pull this on themselves or each other.
 */

let lastStatsResult = null; // kept around so the Excel export always matches what's on screen
let repliesChartInstance, shareChartInstance;

function t(key, vars) {
  let str = I18N.t(key) || key;
  if (vars) Object.keys(vars).forEach((k) => { str = str.replace(`{${k}}`, vars[k]); });
  return str;
}

function toDateInputValue(date) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD, what <input type="date"> expects
}

function setDefaultRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 29); // last 30 days, inclusive, is a sensible default review window
  document.getElementById("agentStatsFrom").value = toDateInputValue(from);
  document.getElementById("agentStatsTo").value = toDateInputValue(to);
}

function renderCharts(rows) {
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const labels = rows.map((r) => r.username);
  const counts = rows.map((r) => r.replies); // raw message volume — the bar chart
  const customersCounts = rows.map((r) => r.customersReplied); // distinct customers handled — the doughnut/share chart
  const palette = [cssVar("--mc-primary"), cssVar("--mc-accent"), "#E8A33D", "#5B8DEF", "#D64550", "#7C5CFC", "#2FB6A6"];
  const colors = rows.map((_, i) => palette[i % palette.length]);

  const barCtx = document.getElementById("agentStatsChart");
  repliesChartInstance && repliesChartInstance.destroy();
  repliesChartInstance = new Chart(barCtx, {
    type: "bar",
    data: { labels, datasets: [{ label: I18N.t("agentStats.replies"), data: counts, backgroundColor: colors, borderRadius: 6 }] },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });

  const shareCtx = document.getElementById("agentShareChart");
  shareChartInstance && shareChartInstance.destroy();
  shareChartInstance = new Chart(shareCtx, {
    type: "doughnut",
    data: { labels, datasets: [{ data: customersCounts, backgroundColor: colors, borderWidth: 0 }] },
    options: {
      responsive: true,
      cutout: "62%",
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10, usePointStyle: true } } },
    },
  });
}

function renderTable(rows) {
  const body = document.getElementById("agentStatsRangeBody");
  if (!rows || rows.length === 0) {
    body.innerHTML = `<tr><td colspan="4" class="text-center text-secondary py-4">${I18N.t("dashboard.agents.empty")}</td></tr>`;
    return;
  }
  const numFmt = new Intl.NumberFormat(I18N.lang === "ar" ? "ar-EG" : "en-US");
  body.innerHTML = rows.map((r) => `
    <tr>
      <td class="fw-semibold">${r.username}</td>
      <td>${numFmt.format(r.replies)}</td>
      <td>${numFmt.format(r.customersReplied)}</td>
      <td>${r.percentage}%</td>
    </tr>`).join("");
}

function renderSummary(stats) {
  const el = document.getElementById("agentStatsSummary");
  const numFmt = new Intl.NumberFormat(I18N.lang === "ar" ? "ar-EG" : "en-US");
  el.textContent = t("agentStats.summary", {
    received: numFmt.format(stats.totalInbound || 0),
    coverage: stats.coveragePercentage || 0,
    agents: numFmt.format((stats.rows || []).length),
  });
}

async function loadAgentStats() {
  const from = document.getElementById("agentStatsFrom").value;
  const to = document.getElementById("agentStatsTo").value;
  const exportBtn = document.getElementById("agentStatsExportBtn");
  const loadBtn = document.getElementById("agentStatsLoadBtn");

  if (!MCApi.isConfigured()) { MCApp.toast(I18N.t("common.error"), "error"); return; }

  loadBtn.disabled = true;
  try {
    const res = await MCApi.Inbox.agentStatsRange(from, to);
    lastStatsResult = res.stats;
    renderCharts(lastStatsResult.rows || []);
    renderTable(lastStatsResult.rows || []);
    renderSummary(lastStatsResult);
    exportBtn.disabled = !(lastStatsResult.rows && lastStatsResult.rows.length);
  } catch (err) {
    MCApp.toast(err.message || I18N.t("common.error"), "error");
  } finally {
    loadBtn.disabled = false;
  }
}

function exportToExcel() {
  if (!lastStatsResult || !lastStatsResult.rows || !lastStatsResult.rows.length) return;
  const sheetRows = lastStatsResult.rows.map((r) => ({
    [I18N.t("dashboard.agents.agent")]: r.username,
    [I18N.t("agentStats.replies")]: r.replies,
    [I18N.t("agentStats.customersReplied")]: r.customersReplied,
    [I18N.t("agentStats.share")]: `${r.percentage}%`,
  }));
  const ws = XLSX.utils.json_to_sheet(sheetRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Agent Activity");
  const from = document.getElementById("agentStatsFrom").value || "start";
  const to = document.getElementById("agentStatsTo").value || "end";
  XLSX.writeFile(wb, `agent-activity_${from}_to_${to}.xlsx`);
}

document.addEventListener("DOMContentLoaded", () => {
  setDefaultRange();
  document.getElementById("agentStatsLoadBtn").addEventListener("click", loadAgentStats);
  document.getElementById("agentStatsExportBtn").addEventListener("click", exportToExcel);
  // Wait for i18n's first paint before the initial auto-load, same pattern as dashboard.js.
  setTimeout(loadAgentStats, 60);
});
I18N.onChange(() => {
  if (lastStatsResult) {
    renderCharts(lastStatsResult.rows || []);
    renderTable(lastStatsResult.rows || []);
    renderSummary(lastStatsResult);
  }
});
