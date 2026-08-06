/**
 * history.js
 * Read-only feed of every message ever sent, joined with campaign and
 * customer names by the backend (history.list -> buildHistoryRows_).
 * Search/filter/pagination happen client-side.
 */

const PAGE_SIZE = 15;
let allHistory = [];
let filteredHistory = [];
let currentPage = 1;

function t(key, vars) {
  let str = I18N.t(key) || key;
  if (vars) Object.keys(vars).forEach((k) => { str = str.replace(`{${k}}`, vars[k]); });
  return str;
}

function escapeHtml(str) {
  if (str === undefined || str === null) return "";
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function statusClass(status) {
  const s = String(status || "");
  if (s === "sent" || s === "delivered" || s === "read") return "completed";
  if (s.indexOf("failed") === 0) return "draft";
  return "scheduled";
}

async function loadHistory() {
  const note = document.getElementById("notConnectedNote");
  if (!MCApi.isConfigured()) {
    note.classList.remove("d-none");
    allHistory = [];
    applyFilters();
    return;
  }
  note.classList.add("d-none");
  try {
    const res = await MCApi.History.list();
    allHistory = res.rows || [];
    applyFilters();
  } catch (err) {
    MCApp.toast(I18N.t("common.error"), "error");
    applyFilters();
  }
}

function applyFilters() {
  const q = document.getElementById("searchInput").value.trim().toLowerCase();
  const status = document.getElementById("statusFilter").value;
  filteredHistory = allHistory.filter((r) => {
    const matchesQ = !q
      || String(r.CustomerName || "").toLowerCase().includes(q)
      || String(r.MobileNumber || "").includes(q)
      || String(r.CampaignName || "").toLowerCase().includes(q);
    const matchesStatus = !status || (status === "failed" ? String(r.Status || "").indexOf("failed") === 0 : r.Status === status);
    return matchesQ && matchesStatus;
  });
  currentPage = 1;
  renderTable();
}

function renderTable() {
  const body = document.getElementById("historyBody");
  const totalPages = Math.max(1, Math.ceil(filteredHistory.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageRows = filteredHistory.slice(start, start + PAGE_SIZE);

  if (pageRows.length === 0) {
    body.innerHTML = `<tr><td colspan="5" class="text-center text-secondary py-4">${I18N.t("history.empty")}</td></tr>`;
  } else {
    const dateFmt = new Intl.DateTimeFormat(I18N.lang === "ar" ? "ar-EG" : "en-US", { dateStyle: "short", timeStyle: "short" });
    body.innerHTML = pageRows.map((r) => `
      <tr>
        <td class="text-secondary">${r.Timestamp ? dateFmt.format(new Date(r.Timestamp)) : "—"}</td>
        <td class="fw-semibold">${escapeHtml(r.CampaignName) || "—"}</td>
        <td>${escapeHtml(r.CustomerName) || "—"}</td>
        <td dir="ltr" class="text-secondary">${escapeHtml(r.MobileNumber)}</td>
        <td><span class="badge-status ${statusClass(r.Status)}">${escapeHtml(r.Status)}</span></td>
      </tr>`).join("");
  }

  document.getElementById("pageInfo").textContent = t("history.pageOf", { current: currentPage, total: totalPages });
  document.getElementById("prevPageBtn").disabled = currentPage <= 1;
  document.getElementById("nextPageBtn").disabled = currentPage >= totalPages;
}

function exportToExcel() {
  const rows = filteredHistory.map((r) => ({
    Time: r.Timestamp, Campaign: r.CampaignName, Customer: r.CustomerName, Mobile: r.MobileNumber, Status: r.Status,
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "History");
  XLSX.writeFile(wb, `${I18N.t("history.exportFileName")}.xlsx`);
}

document.addEventListener("DOMContentLoaded", () => {
  setTimeout(loadHistory, 60);
  document.getElementById("searchInput").addEventListener("input", applyFilters);
  document.getElementById("statusFilter").addEventListener("change", applyFilters);
  document.getElementById("prevPageBtn").addEventListener("click", () => { currentPage--; renderTable(); });
  document.getElementById("nextPageBtn").addEventListener("click", () => { currentPage++; renderTable(); });
  document.getElementById("exportBtn").addEventListener("click", exportToExcel);
});

I18N.onChange(() => renderTable());
