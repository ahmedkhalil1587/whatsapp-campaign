/**
 * requests.js
 * Admin-only page (enforced by auth.js's role check + the backend's
 * signups.* actions being admin-only). Lists pending/approved signup
 * requests and lets the admin pick a role and approve (which emails a
 * 6-digit activation code) or reject.
 */

let allRequests = [];

function escapeHtml(str) {
  if (str === undefined || str === null) return "";
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function loadRequests() {
  const note = document.getElementById("notConnectedNote");
  if (!MCApi.isConfigured()) {
    note.classList.remove("d-none");
    allRequests = [];
    renderRequests();
    return;
  }
  note.classList.add("d-none");
  try {
    const res = await MCApi.Signups.list();
    allRequests = res.rows || [];
    renderRequests();
  } catch (err) {
    MCApp.toast(I18N.t("common.error"), "error");
    renderRequests();
  }
}

function renderRequests() {
  const body = document.getElementById("requestsBody");
  if (allRequests.length === 0) {
    body.innerHTML = `<tr><td colspan="5" class="text-center text-secondary py-4">${I18N.t("requests.empty")}</td></tr>`;
    return;
  }
  body.innerHTML = allRequests.map((r) => `
    <tr>
      <td class="fw-semibold">${escapeHtml(r.Name)}</td>
      <td dir="ltr">${escapeHtml(r.Email)}</td>
      <td><span class="badge-status ${r.Status === "approved" ? "scheduled" : "draft"}">${r.Status === "approved" ? I18N.t("requests.statusApproved") : I18N.t("requests.statusPending")}</span></td>
      <td>
        <select class="form-select form-select-sm role-select" data-id="${r.ID}" style="max-width:160px;" ${r.Status === "approved" ? "disabled" : ""}>
          <option value="agent" ${r.Role === "agent" ? "selected" : ""}>${I18N.t("requests.roleAgent")}</option>
          <option value="admin" ${r.Role === "admin" ? "selected" : ""}>${I18N.t("requests.roleAdmin")}</option>
        </select>
      </td>
      <td class="text-nowrap">
        ${r.Status === "pending" ? `<button class="btn btn-sm btn-mc-primary approve-btn" data-id="${r.ID}">${I18N.t("requests.approve")}</button>` : `<span class="small text-secondary">${I18N.t("requests.awaitingActivation")}</span>`}
        <button class="btn btn-sm btn-outline-danger reject-btn" data-id="${r.ID}">${I18N.t("requests.reject")}</button>
      </td>
    </tr>`).join("");

  document.querySelectorAll(".approve-btn").forEach((btn) => btn.addEventListener("click", () => approveRequest(btn.getAttribute("data-id"))));
  document.querySelectorAll(".reject-btn").forEach((btn) => btn.addEventListener("click", () => rejectRequest(btn.getAttribute("data-id"))));
}

async function approveRequest(id) {
  const select = document.querySelector(`.role-select[data-id="${id}"]`);
  const role = select ? select.value : "agent";
  try {
    await MCApi.Signups.approve(id, role);
    MCApp.toast(I18N.t("requests.approvedToast"));
    await loadRequests();
  } catch (err) {
    MCApp.toast(I18N.t("common.error"), "error");
  }
}

async function rejectRequest(id) {
  if (!confirm(I18N.t("requests.confirmReject"))) return;
  try {
    await MCApi.Signups.reject(id);
    MCApp.toast(I18N.t("requests.rejectedToast"));
    await loadRequests();
  } catch (err) {
    MCApp.toast(I18N.t("common.error"), "error");
  }
}

document.addEventListener("DOMContentLoaded", () => setTimeout(loadRequests, 60));
I18N.onChange(() => renderRequests());
