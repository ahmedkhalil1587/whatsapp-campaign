/**
 * templates.js
 * A simple reusable-message library. Talks to MCApi.Templates (backed by
 * the "Templates" sheet). "Use in campaign" stores the chosen body in
 * sessionStorage and hands off to campaigns.html, which picks it up and
 * opens the builder pre-filled (see the prefill check in campaigns.js).
 */

let allTemplates = [];
let templateModal;

function escapeHtml(str) {
  if (str === undefined || str === null) return "";
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function loadTemplates() {
  const note = document.getElementById("notConnectedNote");
  if (!MCApi.isConfigured()) {
    note.classList.remove("d-none");
    allTemplates = [];
    renderTemplates();
    return;
  }
  note.classList.add("d-none");
  try {
    const res = await MCApi.Templates.list();
    allTemplates = res.rows || [];
    renderTemplates();
  } catch (err) {
    MCApp.toast(I18N.t("common.error"), "error");
    renderTemplates();
  }
}

function renderTemplates() {
  const body = document.getElementById("templatesBody");
  if (allTemplates.length === 0) {
    body.innerHTML = `<tr><td colspan="3" class="text-center text-secondary py-4">${I18N.t("templates.empty")}</td></tr>`;
    return;
  }
  body.innerHTML = allTemplates.map((t) => `
    <tr>
      <td class="fw-semibold">${escapeHtml(t.Name)}</td>
      <td><div class="template-body-preview">${escapeHtml(t.Body)}</div></td>
      <td class="text-nowrap">
        <button class="btn btn-sm btn-mc-primary use-btn" data-id="${t.ID}">${I18N.t("templates.useInCampaign")}</button>
        <button class="btn btn-sm btn-outline-secondary edit-btn" data-id="${t.ID}"><i class="bi bi-pencil"></i></button>
        <button class="btn btn-sm btn-outline-danger delete-btn" data-id="${t.ID}"><i class="bi bi-trash"></i></button>
      </td>
    </tr>`).join("");

  document.querySelectorAll(".use-btn").forEach((btn) => btn.addEventListener("click", () => useInCampaign(btn.getAttribute("data-id"))));
  document.querySelectorAll(".edit-btn").forEach((btn) => btn.addEventListener("click", () => openEditModal(btn.getAttribute("data-id"))));
  document.querySelectorAll(".delete-btn").forEach((btn) => btn.addEventListener("click", () => deleteTemplate(btn.getAttribute("data-id"))));
}

function useInCampaign(id) {
  const tpl = allTemplates.find((t) => String(t.ID) === String(id));
  if (!tpl) return;
  sessionStorage.setItem("mc_prefill_message", tpl.Body || "");
  MCApp.toast(I18N.t("templates.usedToast"));
  window.location.href = "campaigns.html?prefill=1";
}

function openAddModal() {
  document.getElementById("templateForm").reset();
  document.getElementById("templateId").value = "";
  document.getElementById("templateModalTitle").textContent = I18N.t("templates.modal.addTitle");
  templateModal.show();
}

function openEditModal(id) {
  const tpl = allTemplates.find((t) => String(t.ID) === String(id));
  if (!tpl) return;
  document.getElementById("templateId").value = tpl.ID;
  document.getElementById("fieldTemplateName").value = tpl.Name || "";
  document.getElementById("fieldTemplateBody").value = tpl.Body || "";
  document.getElementById("templateModalTitle").textContent = I18N.t("templates.modal.editTitle");
  templateModal.show();
}

async function saveTemplateForm(e) {
  e.preventDefault();
  if (!MCApi.isConfigured()) { MCApp.toast(I18N.t("common.error"), "error"); return; }
  const id = document.getElementById("templateId").value;
  const payload = {
    Name: document.getElementById("fieldTemplateName").value.trim(),
    Body: document.getElementById("fieldTemplateBody").value.trim(),
  };
  if (!payload.Name || !payload.Body) return;

  try {
    if (id) await MCApi.Templates.update(id, payload);
    else await MCApi.Templates.create(payload);
    templateModal.hide();
    MCApp.toast(I18N.t("templates.savedToast"));
    await loadTemplates();
  } catch (err) {
    MCApp.toast(I18N.t("common.error"), "error");
  }
}

async function deleteTemplate(id) {
  if (!confirm(I18N.t("templates.confirmDelete"))) return;
  try {
    await MCApi.Templates.remove(id);
    MCApp.toast(I18N.t("templates.deletedToast"));
    await loadTemplates();
  } catch (err) {
    MCApp.toast(I18N.t("common.error"), "error");
  }
}

async function loadDefaultTemplates() {
  if (!MCApi.isConfigured()) { MCApp.toast(I18N.t("common.error"), "error"); return; }
  if (!confirm(I18N.t("templates.loadDefaultsConfirm"))) return;

  const defaults = [
    { Name: I18N.t("templates.defaults.invitationName"), Body: I18N.t("templates.defaults.invitationBody") },
    { Name: I18N.t("templates.defaults.reminderName"), Body: I18N.t("templates.defaults.reminderBody") },
    { Name: I18N.t("templates.defaults.lastChanceName"), Body: I18N.t("templates.defaults.lastChanceBody") },
    { Name: I18N.t("templates.defaults.certificateName"), Body: I18N.t("templates.defaults.certificateBody") },
    { Name: I18N.t("templates.defaults.thankYouName"), Body: I18N.t("templates.defaults.thankYouBody") },
  ];

  try {
    for (const tpl of defaults) {
      await MCApi.Templates.create(tpl);
    }
    MCApp.toast(I18N.t("templates.loadDefaultsDone"));
    await loadTemplates();
  } catch (err) {
    MCApp.toast(I18N.t("common.error"), "error");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  templateModal = new bootstrap.Modal(document.getElementById("templateModal"));
  setTimeout(loadTemplates, 60);

  document.getElementById("addBtn").addEventListener("click", openAddModal);
  document.getElementById("templateForm").addEventListener("submit", saveTemplateForm);
  document.getElementById("loadDefaultsBtn").addEventListener("click", loadDefaultTemplates);

  document.querySelectorAll(".var-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const textarea = document.getElementById("fieldTemplateBody");
      const varText = btn.getAttribute("data-var");
      const start = textarea.selectionStart || textarea.value.length;
      const end = textarea.selectionEnd || textarea.value.length;
      textarea.value = textarea.value.slice(0, start) + varText + textarea.value.slice(end);
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = start + varText.length;
    });
  });
});

I18N.onChange(() => renderTemplates());
