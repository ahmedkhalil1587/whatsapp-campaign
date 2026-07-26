/**
 * doctors.js
 * Manages the contact list (doctors, clients, or anyone else — Specialty
 * and Hospital are optional so this doubles as a generic contact module).
 * Talks to MCApi.Doctors, which maps to the "Doctors" sheet/tab in
 * backend/Code.gs. Search, filter, and pagination happen client-side
 * since the backend returns the full list in one call.
 */

const PAGE_SIZE = 10;
let allDoctors = [];
let filteredDoctors = [];
let currentPage = 1;
let selectedIds = new Set();
let doctorModal;

function t(key, vars) {
  let str = I18N.t(key) || key;
  if (vars) Object.keys(vars).forEach((k) => { str = str.replace(`{${k}}`, vars[k]); });
  return str;
}

// ---------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------

async function loadDoctors() {
  const note = document.getElementById("notConnectedNote");
  if (!MCApi.isConfigured()) {
    note.classList.remove("d-none");
    allDoctors = [];
    applyFilters();
    return;
  }
  note.classList.add("d-none");
  try {
    const res = await MCApi.Doctors.list();
    allDoctors = res.rows || [];
    applyFilters();
  } catch (err) {
    MCApp.toast(I18N.t("common.error"), "error");
  }
}

function applyFilters() {
  const q = document.getElementById("searchInput").value.trim().toLowerCase();
  const status = document.getElementById("statusFilter").value;
  filteredDoctors = allDoctors.filter((d) => {
    const matchesQ = !q || String(d.Name || "").toLowerCase().includes(q) || String(d.Mobile || "").includes(q);
    const matchesStatus = !status || d.Status === status;
    return matchesQ && matchesStatus;
  });
  currentPage = 1;
  renderTable();
}

// ---------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------

function renderTable() {
  const body = document.getElementById("doctorsBody");
  const totalPages = Math.max(1, Math.ceil(filteredDoctors.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageRows = filteredDoctors.slice(start, start + PAGE_SIZE);

  if (pageRows.length === 0) {
    body.innerHTML = `<tr><td colspan="8" class="text-center text-secondary py-4">${I18N.t("doctors.empty")}</td></tr>`;
  } else {
    body.innerHTML = pageRows.map((d) => `
      <tr>
        <td><input type="checkbox" class="row-checkbox" value="${d.ID}" ${selectedIds.has(String(d.ID)) ? "checked" : ""}></td>
        <td class="fw-semibold">${escapeHtml(d.Name)}</td>
        <td dir="ltr" class="text-secondary">${escapeHtml(d.Mobile)}</td>
        <td>${escapeHtml(d.Specialty) || "—"}</td>
        <td>${escapeHtml(d.Hospital) || "—"}</td>
        <td>${escapeHtml(d.City) || "—"}</td>
        <td><span class="badge-status ${d.Status === "Active" ? "completed" : "draft"}">${d.Status === "Active" ? I18N.t("doctors.filterActive") : I18N.t("doctors.filterInactive")}</span></td>
        <td>
          <button class="btn btn-sm btn-outline-secondary edit-btn" data-id="${d.ID}" title="${I18N.t('common.save')}"><i class="bi bi-pencil"></i></button>
          <button class="btn btn-sm btn-outline-danger delete-btn" data-id="${d.ID}" title="${I18N.t('common.close')}"><i class="bi bi-trash"></i></button>
        </td>
      </tr>`).join("");
  }

  document.getElementById("pageInfo").textContent = t("doctors.pageOf", { current: currentPage, total: totalPages });
  document.getElementById("prevPageBtn").disabled = currentPage <= 1;
  document.getElementById("nextPageBtn").disabled = currentPage >= totalPages;
  updateBulkBar();
  bindRowEvents();
}

function escapeHtml(str) {
  if (str === undefined || str === null) return "";
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function bindRowEvents() {
  document.querySelectorAll(".row-checkbox").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) selectedIds.add(cb.value); else selectedIds.delete(cb.value);
      updateBulkBar();
    });
  });
  document.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => openEditModal(btn.getAttribute("data-id")));
  });
  document.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", () => deleteOne(btn.getAttribute("data-id")));
  });
}

function updateBulkBar() {
  const btn = document.getElementById("bulkDeleteBtn");
  const label = document.getElementById("bulkDeleteLabel");
  if (selectedIds.size > 0) {
    btn.classList.remove("d-none");
    btn.classList.add("d-inline-flex");
    label.textContent = t("doctors.bulkDelete") + ` (${selectedIds.size})`;
  } else {
    btn.classList.add("d-none");
    btn.classList.remove("d-inline-flex");
  }
  const selectAll = document.getElementById("selectAllCheckbox");
  const rowBoxes = document.querySelectorAll(".row-checkbox");
  selectAll.checked = rowBoxes.length > 0 && Array.from(rowBoxes).every((cb) => cb.checked);
}

// ---------------------------------------------------------------
// Add / Edit modal
// ---------------------------------------------------------------

function openAddModal() {
  document.getElementById("doctorForm").reset();
  document.getElementById("doctorId").value = "";
  document.getElementById("fieldStatus").value = "Active";
  document.getElementById("doctorModalTitle").setAttribute("data-i18n", "doctors.modal.addTitle");
  document.getElementById("doctorModalTitle").textContent = I18N.t("doctors.modal.addTitle");
  doctorModal.show();
}

function openEditModal(id) {
  const d = allDoctors.find((x) => String(x.ID) === String(id));
  if (!d) return;
  document.getElementById("doctorId").value = d.ID;
  document.getElementById("fieldName").value = d.Name || "";
  document.getElementById("fieldMobile").value = d.Mobile || "";
  document.getElementById("fieldSpecialty").value = d.Specialty || "";
  document.getElementById("fieldHospital").value = d.Hospital || "";
  document.getElementById("fieldCity").value = d.City || "";
  document.getElementById("fieldCountry").value = d.Country || "";
  document.getElementById("fieldStatus").value = d.Status || "Active";
  document.getElementById("fieldNotes").value = d.Notes || "";
  document.getElementById("doctorModalTitle").textContent = I18N.t("doctors.modal.editTitle");
  doctorModal.show();
}

async function saveDoctorForm(e) {
  e.preventDefault();
  if (!MCApi.isConfigured()) { MCApp.toast(I18N.t("common.error"), "error"); return; }

  const id = document.getElementById("doctorId").value;
  const payload = {
    Name: document.getElementById("fieldName").value.trim(),
    Mobile: document.getElementById("fieldMobile").value.trim(),
    Specialty: document.getElementById("fieldSpecialty").value.trim(),
    Hospital: document.getElementById("fieldHospital").value.trim(),
    City: document.getElementById("fieldCity").value.trim(),
    Country: document.getElementById("fieldCountry").value.trim(),
    Status: document.getElementById("fieldStatus").value,
    Notes: document.getElementById("fieldNotes").value.trim(),
  };
  if (!payload.Name || !payload.Mobile) return;

  try {
    if (id) await MCApi.Doctors.update(id, payload);
    else await MCApi.Doctors.create(payload);
    doctorModal.hide();
    MCApp.toast(I18N.t("doctors.savedToast"));
    await loadDoctors();
  } catch (err) {
    MCApp.toast(I18N.t("common.error"), "error");
  }
}

// ---------------------------------------------------------------
// Delete
// ---------------------------------------------------------------

async function deleteOne(id) {
  if (!confirm(I18N.t("doctors.confirmDeleteOne"))) return;
  try {
    await MCApi.Doctors.remove(id);
    MCApp.toast(I18N.t("doctors.deletedToast"));
    await loadDoctors();
  } catch (err) {
    MCApp.toast(I18N.t("common.error"), "error");
  }
}

async function deleteBulk() {
  if (selectedIds.size === 0) return;
  if (!confirm(t("doctors.confirmDeleteMany", { n: selectedIds.size }))) return;
  try {
    await Promise.all(Array.from(selectedIds).map((id) => MCApi.Doctors.remove(id)));
    selectedIds.clear();
    MCApp.toast(I18N.t("doctors.deletedToast"));
    await loadDoctors();
  } catch (err) {
    MCApp.toast(I18N.t("common.error"), "error");
  }
}

// ---------------------------------------------------------------
// Excel import / export (SheetJS, client-side)
// ---------------------------------------------------------------

function handleImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (evt) => {
    try {
      const wb = XLSX.read(evt.target.result, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      const mapped = rows.map((r) => ({
        Name: r.Name || r.name || "",
        Mobile: String(r.Mobile || r.mobile || ""),
        Specialty: r.Specialty || r.specialty || "",
        Hospital: r.Hospital || r.hospital || "",
        City: r.City || r.city || "",
        Country: r.Country || r.country || "",
        Status: r.Status || r.status || "Active",
        Notes: r.Notes || r.notes || "",
      })).filter((r) => r.Name && r.Mobile);

      if (mapped.length === 0) throw new Error("empty");
      await MCApi.Doctors.bulkImport(mapped);
      MCApp.toast(t("doctors.importSuccess", { n: mapped.length }));
      await loadDoctors();
    } catch (err) {
      MCApp.toast(I18N.t("doctors.importError"), "error");
    } finally {
      e.target.value = "";
    }
  };
  reader.readAsArrayBuffer(file);
}

function exportToExcel() {
  const rows = filteredDoctors.map((d) => ({
    ID: d.ID, Name: d.Name, Mobile: d.Mobile, Specialty: d.Specialty,
    Hospital: d.Hospital, City: d.City, Country: d.Country, Status: d.Status, Notes: d.Notes,
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Doctors");
  XLSX.writeFile(wb, `${I18N.t("doctors.exportFileName")}.xlsx`);
}

// ---------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  doctorModal = new bootstrap.Modal(document.getElementById("doctorModal"));

  setTimeout(loadDoctors, 60);

  document.getElementById("searchInput").addEventListener("input", applyFilters);
  document.getElementById("statusFilter").addEventListener("change", applyFilters);
  document.getElementById("addBtn").addEventListener("click", openAddModal);
  document.getElementById("doctorForm").addEventListener("submit", saveDoctorForm);
  document.getElementById("prevPageBtn").addEventListener("click", () => { currentPage--; renderTable(); });
  document.getElementById("nextPageBtn").addEventListener("click", () => { currentPage++; renderTable(); });
  document.getElementById("bulkDeleteBtn").addEventListener("click", deleteBulk);
  document.getElementById("selectAllCheckbox").addEventListener("change", (e) => {
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageRows = filteredDoctors.slice(start, start + PAGE_SIZE);
    pageRows.forEach((d) => { if (e.target.checked) selectedIds.add(String(d.ID)); else selectedIds.delete(String(d.ID)); });
    renderTable();
  });

  document.getElementById("importBtn").addEventListener("click", () => document.getElementById("importFileInput").click());
  document.getElementById("importFileInput").addEventListener("change", handleImportFile);
  document.getElementById("exportBtn").addEventListener("click", exportToExcel);
});

I18N.onChange(() => renderTable());
