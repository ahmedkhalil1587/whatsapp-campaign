/**
 * campaigns.js
 * Two views on one page: a list of existing campaigns, and a builder
 * (message + recipients + live WhatsApp-style preview + send/schedule).
 * Talks to MCApi.Campaigns (create/list/send/retryFailed) and
 * MCApi.Doctors.list() for the recipient picker.
 */

let allCampaigns = [];
let allCustomers = [];
let selectedRecipientIds = new Set();

function t(key, vars) {
  let str = I18N.t(key) || key;
  if (vars) Object.keys(vars).forEach((k) => { str = str.replace(`{${k}}`, vars[k]); });
  return str;
}

function escapeHtml(str) {
  if (str === undefined || str === null) return "";
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Strips everything except digits, so "+966 54 508 4980", "00966545084980",
 * and "966545084980" are all recognized as the same person's number when
 * matching an uploaded Excel list against the existing customer list. */
function normalizeMobile(mobile) {
  var digits = String(mobile || "").replace(/[^0-9]/g, "");
  // "00" is the international dialing prefix some people use instead of
  // "+" (e.g. "00966545084980" vs "+966545084980") — treat them the same.
  if (digits.slice(0, 2) === "00") digits = digits.slice(2);
  return digits;
}

// ---------------------------------------------------------------
// List view
// ---------------------------------------------------------------

async function loadCampaigns() {
  const note = document.getElementById("notConnectedNoteList");
  if (!MCApi.isConfigured()) {
    note.classList.remove("d-none");
    allCampaigns = [];
    renderCampaignsList();
    return;
  }
  note.classList.add("d-none");
  try {
    const res = await MCApi.Campaigns.list();
    allCampaigns = (res.rows || []).slice().reverse();
    renderCampaignsList();
  } catch (err) {
    MCApp.toast(I18N.t("common.error"), "error");
    renderCampaignsList();
  }
}

function statusBadgeClass(status) {
  if (status === "Completed") return "completed";
  if (status === "Scheduled") return "scheduled";
  if (status === "Sending" || status === "In progress") return "inProgress";
  if (status === "Paused") return "draft";
  return "draft";
}

function renderCampaignsList() {
  const body = document.getElementById("campaignsBody");
  if (allCampaigns.length === 0) {
    body.innerHTML = `<tr><td colspan="7" class="text-center text-secondary py-4">${I18N.t("campaigns.empty")}</td></tr>`;
    return;
  }
  const dateFmt = new Intl.DateTimeFormat(I18N.lang === "ar" ? "ar-EG" : "en-US", { year: "numeric", month: "short", day: "numeric" });
  body.innerHTML = allCampaigns.map((c) => `
    <tr>
      <td class="fw-semibold">${escapeHtml(c.Name)}</td>
      <td><span class="badge-status ${statusBadgeClass(c.Status)}">${escapeHtml(c.Status || "Draft")}</span></td>
      <td class="text-secondary">${c.CreatedAt ? dateFmt.format(new Date(c.CreatedAt)) : "—"}</td>
      <td>${Number(c.Sent || 0)}</td>
      <td>${Number(c.Delivered || 0)}</td>
      <td>${Number(c.Failed || 0)}</td>
      <td>
        ${c.Status === "Draft" ? `<button class="btn btn-sm btn-mc-primary continue-btn" data-id="${c.ID}">${I18N.t("campaigns.continueSending")}</button>` : ""}
        ${c.Status === "Sending" ? `<button class="btn btn-sm btn-mc-primary continue-btn" data-id="${c.ID}">${I18N.t("campaigns.continueSending")}</button><button class="btn btn-sm btn-outline-danger pause-btn" data-id="${c.ID}">${I18N.t("campaigns.pauseSending")}</button>` : ""}
        ${c.Status === "Paused" ? `<button class="btn btn-sm btn-mc-primary resume-btn" data-id="${c.ID}">${I18N.t("campaigns.resumeSending")}</button>` : ""}
        <button class="btn btn-sm btn-outline-secondary details-btn" data-id="${c.ID}">${I18N.t("campaigns.viewDetails")}</button>
        ${Number(c.Failed || 0) > 0 ? `<button class="btn btn-sm btn-outline-secondary retry-btn" data-id="${c.ID}">${I18N.t("campaigns.retryFailed")}</button>` : ""}
        <button class="btn btn-sm btn-outline-secondary duplicate-btn" data-id="${c.ID}">${I18N.t("campaigns.duplicate")}</button>
      </td>
    </tr>`).join("");

  document.querySelectorAll(".continue-btn").forEach((btn) => btn.addEventListener("click", () => continueSending(btn.getAttribute("data-id"))));
  document.querySelectorAll(".pause-btn").forEach((btn) => btn.addEventListener("click", () => pauseSending(btn.getAttribute("data-id"))));
  document.querySelectorAll(".resume-btn").forEach((btn) => btn.addEventListener("click", () => resumeSending(btn.getAttribute("data-id"))));
  document.querySelectorAll(".details-btn").forEach((btn) => btn.addEventListener("click", () => openLogsModal(btn.getAttribute("data-id"))));
  document.querySelectorAll(".retry-btn").forEach((btn) => btn.addEventListener("click", () => retryFailed(btn.getAttribute("data-id"))));
  document.querySelectorAll(".duplicate-btn").forEach((btn) => btn.addEventListener("click", () => duplicateCampaign(btn.getAttribute("data-id"))));
}

async function continueSending(id) {
  try {
    const res = await MCApi.Campaigns.send(id);
    if (res.status === "Sending") {
      MCApp.toast(t("campaigns.sendingInProgress", { sent: res.sent ?? 0, remaining: res.remaining ?? 0 }));
    } else {
      MCApp.toast(t("campaigns.sentSuccess", { sent: res.sent ?? 0, failed: res.failed ?? 0 }));
    }
    await loadCampaigns();
  } catch (err) {
    MCApp.toast(I18N.t("common.error"), "error");
  }
}

async function pauseSending(id) {
  if (!confirm(I18N.t("campaigns.confirmPause"))) return;
  try {
    await MCApi.Campaigns.pause(id);
    MCApp.toast(I18N.t("campaigns.pausedToast"));
    await loadCampaigns();
  } catch (err) {
    MCApp.toast(I18N.t("common.error"), "error");
  }
}

async function resumeSending(id) {
  try {
    const res = await MCApi.Campaigns.resume(id);
    if (res.status === "Sending") {
      MCApp.toast(t("campaigns.sendingInProgress", { sent: res.sent ?? 0, remaining: res.remaining ?? 0 }));
    } else {
      MCApp.toast(t("campaigns.sentSuccess", { sent: res.sent ?? 0, failed: res.failed ?? 0 }));
    }
    await loadCampaigns();
  } catch (err) {
    MCApp.toast(I18N.t("common.error"), "error");
  }
}

let logsModal;

function logStatusClass(status) {
  const s = String(status || "");
  if (s === "sent" || s === "delivered" || s === "read") return "completed";
  if (s.indexOf("failed") === 0) return "draft";
  return "scheduled";
}

async function openLogsModal(campaignId) {
  const body = document.getElementById("logsModalBody");
  body.innerHTML = `<tr><td colspan="3" class="text-center text-secondary py-4">${I18N.t("common.loading")}</td></tr>`;
  if (!logsModal) logsModal = new bootstrap.Modal(document.getElementById("logsModal"));
  logsModal.show();

  try {
    const res = await MCApi.Campaigns.logs(campaignId);
    const rows = res.rows || [];
    if (rows.length === 0) {
      body.innerHTML = `<tr><td colspan="3" class="text-center text-secondary py-4">${I18N.t("campaigns.logsEmpty")}</td></tr>`;
      return;
    }
    const dateFmt = new Intl.DateTimeFormat(I18N.lang === "ar" ? "ar-EG" : "en-US", { dateStyle: "short", timeStyle: "short" });
    body.innerHTML = rows.map((l) => `
      <tr>
        <td dir="ltr">${escapeHtml(l.MobileNumber)}</td>
        <td><span class="badge-status ${logStatusClass(l.Status)}">${escapeHtml(l.Status)}</span></td>
        <td class="text-secondary">${l.Timestamp ? dateFmt.format(new Date(l.Timestamp)) : "—"}</td>
      </tr>`).join("");
  } catch (err) {
    body.innerHTML = `<tr><td colspan="3" class="text-center text-danger py-4">${I18N.t("common.error")}</td></tr>`;
  }
}

async function retryFailed(id) {
  try {
    const res = await MCApi.Campaigns.retryFailed(id);
    MCApp.toast(t("campaigns.retrySuccess", { n: res.retried ?? 0 }));
    await loadCampaigns();
  } catch (err) {
    MCApp.toast(I18N.t("common.error"), "error");
  }
}

function duplicateCampaign(id) {
  const c = allCampaigns.find((x) => String(x.ID) === String(id));
  if (!c) return;
  showFormView();
  document.getElementById("fieldCampaignName").value = (c.Name || "") + " (copy)";

  if (c.MessageType === "template") {
    document.getElementById("msgTypeTemplate").checked = true;
    document.getElementById("fieldTemplateName").value = c.TemplateName || "";
    document.getElementById("fieldTemplateLang").value = c.TemplateLanguage || "ar";
    document.getElementById("fieldTemplateParamNames").value = c.TemplateParamNames || "";
    templateParamOrder = c.TemplateParams ? String(c.TemplateParams).split(",").map((s) => s.trim()).filter(Boolean) : [];
    renderTemplateParamChips();
  } else {
    document.getElementById("msgTypeText").checked = true;
    document.getElementById("fieldMessage").value = c.Message || "";
    document.getElementById("fieldImageUrl").value = c.ImageUrl || "";
    document.getElementById("fieldPdfUrl").value = c.PdfUrl || "";
  }
  toggleMessageType();

  if (c.RecipientIds) {
    document.getElementById("modeCustom").checked = true;
    selectedRecipientIds = new Set(String(c.RecipientIds).split(",").map((s) => s.trim()).filter(Boolean));
    toggleRecipientMode();
  }
  updatePreview();
  MCApp.toast(I18N.t("campaigns.duplicateToast"));
}

// ---------------------------------------------------------------
// View switching
// ---------------------------------------------------------------

function showListView() {
  document.getElementById("listView").classList.remove("d-none");
  document.getElementById("formView").classList.add("d-none");
  loadCampaigns();
}

async function showFormView() {
  document.getElementById("listView").classList.add("d-none");
  document.getElementById("formView").classList.remove("d-none");
  resetForm();
  await loadCustomersForPicker();
}

function resetForm() {
  document.getElementById("fieldCampaignName").value = "";
  document.getElementById("fieldMessage").value = "";
  document.getElementById("fieldImageUrl").value = "";
  document.getElementById("fieldPdfUrl").value = "";
  document.getElementById("msgTypeText").checked = true;
  document.getElementById("fieldTemplateName").value = "";
  document.getElementById("fieldTemplateLang").value = "ar";
  document.getElementById("fieldTemplateParamNames").value = "";
  templateParamOrder = [];
  renderTemplateParamChips();
  document.getElementById("modeAll").checked = true;
  document.getElementById("sendNowRadio").checked = true;
  document.getElementById("fieldScheduleAt").value = "";
  selectedRecipientIds.clear();
  toggleMessageType();
  toggleRecipientMode();
  toggleSendMode();
  updatePreview();
}

// ---------------------------------------------------------------
// Message type (free-form vs approved Meta template)
// ---------------------------------------------------------------

let templateParamOrder = [];
const TPL_VAR_LABELS = { doctor_name: "{{doctor_name}}", specialty: "{{specialty}}", hospital: "{{hospital}}", city: "{{city}}" };

function toggleMessageType() {
  const isTemplate = document.getElementById("msgTypeTemplate").checked;
  document.getElementById("textModeBox").classList.toggle("d-none", isTemplate);
  document.getElementById("templateModeBox").classList.toggle("d-none", !isTemplate);
  document.getElementById("imageFieldHint").textContent = isTemplate
    ? I18N.t("campaigns.imageFieldHintTemplate")
    : I18N.t("campaigns.uploadHint");
}

function renderTemplateParamChips() {
  const box = document.getElementById("templateParamChips");
  if (templateParamOrder.length === 0) {
    box.innerHTML = `<span class="small text-secondary" data-i18n="campaigns.templateParamsEmpty">${I18N.t("campaigns.templateParamsEmpty")}</span>`;
    return;
  }
  box.innerHTML = templateParamOrder.map((field, i) => `
    <span class="var-btn d-inline-flex align-items-center gap-1" style="cursor:default;">
      {{${i + 1}}} = ${TPL_VAR_LABELS[field] || field}
      <button type="button" class="btn-close btn-close-sm remove-param-btn" data-index="${i}" style="font-size:.55rem;"></button>
    </span>`).join("");
  box.querySelectorAll(".remove-param-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      templateParamOrder.splice(Number(btn.getAttribute("data-index")), 1);
      renderTemplateParamChips();
      updatePreview();
    });
  });
}

// ---------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------

async function loadCustomersForPicker() {
  if (!MCApi.isConfigured()) { allCustomers = []; renderRecipientList(); updateAllModeHint(); return; }
  try {
    const res = await MCApi.Doctors.list();
    allCustomers = res.rows || [];
  } catch (err) {
    allCustomers = [];
  }
  renderRecipientList();
  updateAllModeHint();
}

function updateAllModeHint() {
  const activeCount = allCustomers.filter((d) => d.Status === "Active").length;
  document.getElementById("allModeHint").textContent = t("campaigns.recipientsAllHint", { n: activeCount });
}

function renderRecipientList() {
  const list = document.getElementById("recipientList");
  const q = document.getElementById("recipientSearch").value.trim().toLowerCase();
  const rows = allCustomers.filter((d) => !q || String(d.Name || "").toLowerCase().includes(q) || String(d.Mobile || "").includes(q));

  if (rows.length === 0) {
    list.innerHTML = `<div class="p-3 text-center text-secondary small">${I18N.t("doctors.empty")}</div>`;
  } else {
    list.innerHTML = rows.map((d) => `
      <label class="recipient-row mb-0">
        <input type="checkbox" class="recipient-checkbox" value="${d.ID}" ${selectedRecipientIds.has(String(d.ID)) ? "checked" : ""}>
        <span class="fw-semibold">${escapeHtml(d.Name)}</span>
        <span class="text-secondary" dir="ltr">${escapeHtml(d.Mobile)}</span>
      </label>`).join("");
    list.querySelectorAll(".recipient-checkbox").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) selectedRecipientIds.add(cb.value); else selectedRecipientIds.delete(cb.value);
        updateRecipientCount();
        updatePreview();
      });
    });
  }
  updateRecipientCount();
}

function updateRecipientCount() {
  const el = document.getElementById("recipientSelectedCount");
  el.textContent = selectedRecipientIds.size > 0
    ? t("campaigns.recipientsSelectedCount", { n: selectedRecipientIds.size })
    : I18N.t("campaigns.recipientsNone");
}

function toggleRecipientMode() {
  const mode = document.querySelector('input[name="recipientMode"]:checked').value;
  document.getElementById("customModeBox").classList.toggle("d-none", mode !== "custom");
  document.getElementById("uploadModeBox").classList.toggle("d-none", mode !== "upload");
  document.getElementById("allModeHint").classList.toggle("d-none", mode !== "all");
}

async function handleRecipientListUpload(file) {
  const statusEl = document.getElementById("recipientUploadStatus");
  const btn = document.getElementById("uploadRecipientListBtn");
  if (!file) return;
  if (!MCApi.isConfigured()) { MCApp.toast(I18N.t("common.error"), "error"); return; }

  btn.disabled = true;
  statusEl.classList.remove("d-none", "text-danger", "text-success");
  statusEl.textContent = I18N.t("campaigns.uploading");

  try {
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    const mapped = rows.map((r) => ({
      Name: r.Name || r.name || "",
      Mobile: String(r.Mobile || r.mobile || "").trim(),
      Specialty: r.Specialty || r.specialty || "",
      Hospital: r.Hospital || r.hospital || "",
      City: r.City || r.city || "",
      Country: r.Country || r.country || "",
      Status: r.Status || r.status || "Active",
      Notes: r.Notes || r.notes || "",
    })).filter((r) => r.Name && r.Mobile);

    if (mapped.length === 0) throw new Error("empty");

    // Match against the customers we already have. Compare digits only
    // (strip "+", spaces, dashes, etc.) instead of the raw string — the
    // same person can appear as "+966545084980" in one place and
    // "966545084980" or "00966545084980" in another, and a strict string
    // match would treat those as different people and leave the existing
    // one unchecked while creating a duplicate for the "new" one.
    const existingByMobile = new Map(allCustomers.map((d) => [normalizeMobile(d.Mobile), d]));
    const toCreate = mapped.filter((r) => !existingByMobile.has(normalizeMobile(r.Mobile)));
    const matchedIds = mapped.filter((r) => existingByMobile.has(normalizeMobile(r.Mobile))).map((r) => String(existingByMobile.get(normalizeMobile(r.Mobile)).ID));

    if (toCreate.length > 0) {
      await MCApi.Doctors.bulkImport(toCreate);
    }

    // Reload the customer list so newly-created rows get real IDs, then match again.
    const res = await MCApi.Doctors.list();
    allCustomers = res.rows || [];
    const refreshedByMobile = new Map(allCustomers.map((d) => [normalizeMobile(d.Mobile), d]));
    const allIds = mapped
      .map((r) => refreshedByMobile.get(normalizeMobile(r.Mobile)))
      .filter(Boolean)
      .map((d) => String(d.ID));

    selectedRecipientIds = new Set(allIds);
    document.getElementById("modeCustom").checked = true;
    toggleRecipientMode();
    renderRecipientList();
    updatePreview();

    statusEl.classList.add("text-success");
    statusEl.textContent = t("campaigns.recipientsUploadDone", { matched: matchedIds.length, added: toCreate.length });
  } catch (err) {
    statusEl.classList.add("text-danger");
    statusEl.textContent = I18N.t("campaigns.recipientsUploadError");
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------
// Send mode
// ---------------------------------------------------------------

function toggleSendMode() {
  const isLater = document.getElementById("sendLaterRadio").checked;
  document.getElementById("scheduleBox").classList.toggle("d-none", !isLater);
  document.getElementById("submitCampaignLabel").textContent = isLater
    ? I18N.t("campaigns.submitSchedule")
    : I18N.t("campaigns.submitSendNow");
}

// ---------------------------------------------------------------
// Live preview
// ---------------------------------------------------------------

function renderMessagePreview(rawMessage, sampleDoctor) {
  const d = sampleDoctor || { Name: I18N.t("campaigns.previewSampleName"), Specialty: "", Hospital: "", City: "" };
  return (rawMessage || "")
    .replace(/{{\s*doctor_name\s*}}/g, d.Name || "")
    .replace(/{{\s*specialty\s*}}/g, d.Specialty || "")
    .replace(/{{\s*hospital\s*}}/g, d.Hospital || "")
    .replace(/{{\s*city\s*}}/g, d.City || "");
}

function updatePreview() {
  const isTemplate = document.getElementById("msgTypeTemplate").checked;
  const body = document.getElementById("waPreviewBody");

  if (isTemplate) {
    const templateName = document.getElementById("fieldTemplateName").value.trim();
    const headerImageUrl = document.getElementById("fieldImageUrl").value.trim();
    if (!templateName && templateParamOrder.length === 0 && !headerImageUrl) {
      body.innerHTML = `<div class="wa-empty">${I18N.t("campaigns.templatePreviewEmpty")}</div>`;
      return;
    }
    let sampleDoctor = null;
    if (document.getElementById("modeCustom").checked && selectedRecipientIds.size > 0) {
      const firstId = Array.from(selectedRecipientIds)[0];
      sampleDoctor = allCustomers.find((d) => String(d.ID) === String(firstId));
    }
    const d = sampleDoctor || { Name: I18N.t("campaigns.previewSampleName"), Specialty: "", Hospital: "", City: "" };
    const fieldMap = { doctor_name: d.Name, specialty: d.Specialty, hospital: d.Hospital, city: d.City };
    const paramsHtml = templateParamOrder.length
      ? templateParamOrder.map((f, i) => `<div><strong>{{${i + 1}}}</strong> → ${escapeHtml(fieldMap[f] || "")}</div>`).join("")
      : `<div class="text-secondary">${I18N.t("campaigns.templateParamsEmpty")}</div>`;
    body.innerHTML = `
      <div class="wa-bubble" style="max-width:96%;">
        ${headerImageUrl ? `<img src="${escapeHtml(headerImageUrl)}" onerror="this.style.display='none'">` : ""}
        <div class="fw-semibold mb-1"><i class="bi bi-file-earmark-text-fill"></i> ${escapeHtml(templateName) || "—"}</div>
        <div class="small">${paramsHtml}</div>
        <div class="small text-secondary mt-2">${I18N.t("campaigns.templatePreviewNote")}</div>
      </div>`;
    return;
  }

  const message = document.getElementById("fieldMessage").value;
  const imageUrl = document.getElementById("fieldImageUrl").value.trim();

  if (!message.trim() && !imageUrl) {
    body.innerHTML = `<div class="wa-empty" data-i18n="campaigns.previewEmpty">${I18N.t("campaigns.previewEmpty")}</div>`;
    return;
  }

  let sampleDoctor = null;
  if (document.getElementById("modeCustom").checked && selectedRecipientIds.size > 0) {
    const firstId = Array.from(selectedRecipientIds)[0];
    sampleDoctor = allCustomers.find((d) => String(d.ID) === String(firstId));
  }
  const text = renderMessagePreview(message, sampleDoctor);
  const now = new Date();
  const time = now.toLocaleTimeString(I18N.lang === "ar" ? "ar-EG" : "en-US", { hour: "2-digit", minute: "2-digit" });

  body.innerHTML = `
    <div class="wa-bubble">
      ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" onerror="this.style.display='none'">` : ""}
      <div>${escapeHtml(text).replace(/\n/g, "<br>")}</div>
      <div class="wa-time">${time} <i class="bi bi-check2-all" style="color:#53bdeb;"></i></div>
    </div>`;
}

// ---------------------------------------------------------------
// Submit
// ---------------------------------------------------------------

async function submitCampaign() {
  const name = document.getElementById("fieldCampaignName").value.trim();
  const isTemplate = document.getElementById("msgTypeTemplate").checked;
  const message = document.getElementById("fieldMessage").value.trim();
  const imageUrl = document.getElementById("fieldImageUrl").value.trim();
  const pdfUrl = document.getElementById("fieldPdfUrl").value.trim();
  const templateName = document.getElementById("fieldTemplateName").value.trim();
  const templateLang = document.getElementById("fieldTemplateLang").value.trim() || "ar";
  const isCustom = document.getElementById("modeCustom").checked;
  const isLater = document.getElementById("sendLaterRadio").checked;
  const scheduleAt = document.getElementById("fieldScheduleAt").value;

  if (!name) { MCApp.toast(I18N.t("campaigns.validationName"), "error"); return; }
  if (isTemplate) {
    if (!templateName) { MCApp.toast(I18N.t("campaigns.validationTemplateName"), "error"); return; }
  } else if (!message) {
    MCApp.toast(I18N.t("campaigns.validationMessage"), "error"); return;
  }
  if (isCustom && selectedRecipientIds.size === 0) { MCApp.toast(I18N.t("campaigns.validationRecipients"), "error"); return; }
  if (isLater && (!scheduleAt || new Date(scheduleAt) <= new Date())) { MCApp.toast(I18N.t("campaigns.validationDate"), "error"); return; }
  if (!MCApi.isConfigured()) { MCApp.toast(I18N.t("common.error"), "error"); return; }

  const recipientCount = isCustom ? selectedRecipientIds.size : allCustomers.filter((d) => d.Status === "Active").length;
  if (!isLater && !confirm(t("campaigns.confirmSendNow", { n: recipientCount }))) return;

  const btn = document.getElementById("submitCampaignBtn");
  const label = document.getElementById("submitCampaignLabel");
  const originalLabel = label.textContent;
  btn.disabled = true;
  label.textContent = I18N.t("campaigns.submitSending");

  try {
    const campaignPayload = {
      Name: name,
      MessageType: isTemplate ? "template" : "text",
      Message: isTemplate ? "" : message,
      ImageUrl: imageUrl,
      PdfUrl: isTemplate ? "" : pdfUrl,
      TemplateName: isTemplate ? templateName : "",
      TemplateLanguage: isTemplate ? templateLang : "",
      TemplateParams: isTemplate ? templateParamOrder.join(",") : "",
      TemplateParamNames: isTemplate ? document.getElementById("fieldTemplateParamNames").value.trim() : "",
      RecipientIds: isCustom ? Array.from(selectedRecipientIds).join(",") : "",
      Status: isLater ? "Scheduled" : "Draft",
      ScheduledAt: isLater ? new Date(scheduleAt).toISOString() : "",
    };
    const createRes = await MCApi.Campaigns.create(campaignPayload);
    const campaignId = createRes.row && createRes.row.ID;

    if (isLater) {
      MCApp.toast(I18N.t("campaigns.scheduledSuccess"));
    } else {
      const sendRes = await MCApi.Campaigns.send(campaignId);
      if (sendRes.status === "Sending") {
        MCApp.toast(t("campaigns.sendingInProgress", { sent: sendRes.sent ?? 0, remaining: sendRes.remaining ?? 0 }));
      } else {
        MCApp.toast(t("campaigns.sentSuccess", { sent: sendRes.sent ?? 0, failed: sendRes.failed ?? 0 }));
      }
    }
    showListView();
  } catch (err) {
    MCApp.toast(I18N.t("common.error"), "error");
  } finally {
    btn.disabled = false;
    label.textContent = originalLabel;
  }
}

// ---------------------------------------------------------------
// Media upload (image / PDF) — reads the picked file as base64 and
// sends it to the backend, which stores it in Google Drive and returns
// a public link. That link is dropped straight into the URL field.
// ---------------------------------------------------------------

const MAX_UPLOAD_MB = 15;

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleMediaUpload(file, urlFieldId, statusElId, uploadBtnId) {
  const statusEl = document.getElementById(statusElId);
  const btn = document.getElementById(uploadBtnId);
  if (!file) return;

  if (!MCApi.isConfigured()) { MCApp.toast(I18N.t("common.error"), "error"); return; }
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
    statusEl.classList.remove("d-none");
    statusEl.classList.add("text-danger");
    statusEl.textContent = t("campaigns.uploadTooBig", { n: MAX_UPLOAD_MB });
    return;
  }

  btn.disabled = true;
  statusEl.classList.remove("d-none", "text-danger", "text-success");
  statusEl.textContent = I18N.t("campaigns.uploading");

  try {
    const base64 = await fileToBase64(file);
    const res = await MCApi.Media.upload(file.name, file.type, base64);
    document.getElementById(urlFieldId).value = res.url;
    statusEl.classList.add("text-success");
    statusEl.textContent = t("campaigns.uploadDone", { name: file.name });
    updatePreview();
  } catch (err) {
    statusEl.classList.add("text-danger");
    statusEl.textContent = I18N.t("campaigns.uploadFailed");
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  setTimeout(loadCampaigns, 60);

  document.getElementById("newCampaignBtn").addEventListener("click", showFormView);
  document.getElementById("backToListBtn").addEventListener("click", showListView);

  document.getElementById("fieldMessage").addEventListener("input", updatePreview);
  document.getElementById("fieldImageUrl").addEventListener("input", updatePreview);
  document.getElementById("fieldTemplateName").addEventListener("input", updatePreview);
  document.querySelectorAll('input[name="messageType"]').forEach((r) => r.addEventListener("change", () => { toggleMessageType(); updatePreview(); }));
  document.querySelectorAll('input[name="recipientMode"]').forEach((r) => r.addEventListener("change", () => { toggleRecipientMode(); updatePreview(); }));
  document.querySelectorAll('input[name="sendMode"]').forEach((r) => r.addEventListener("change", toggleSendMode));
  document.getElementById("recipientSearch").addEventListener("input", renderRecipientList);
  document.getElementById("submitCampaignBtn").addEventListener("click", submitCampaign);

  document.getElementById("uploadImageBtn").addEventListener("click", () => document.getElementById("imageFileInput").click());
  document.getElementById("imageFileInput").addEventListener("change", (e) => handleMediaUpload(e.target.files[0], "fieldImageUrl", "imageUploadStatus", "uploadImageBtn"));
  document.getElementById("uploadPdfBtn").addEventListener("click", () => document.getElementById("pdfFileInput").click());
  document.getElementById("pdfFileInput").addEventListener("change", (e) => handleMediaUpload(e.target.files[0], "fieldPdfUrl", "pdfUploadStatus", "uploadPdfBtn"));

  document.getElementById("uploadRecipientListBtn").addEventListener("click", () => document.getElementById("recipientFileInput").click());
  document.getElementById("recipientFileInput").addEventListener("change", (e) => { handleRecipientListUpload(e.target.files[0]); e.target.value = ""; });

  // Text-message variable buttons insert into the free-form textarea.
  document.querySelectorAll(".var-btn[data-var]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const textarea = document.getElementById("fieldMessage");
      const varText = btn.getAttribute("data-var");
      const start = textarea.selectionStart || textarea.value.length;
      const end = textarea.selectionEnd || textarea.value.length;
      textarea.value = textarea.value.slice(0, start) + varText + textarea.value.slice(end);
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = start + varText.length;
      updatePreview();
    });
  });

  // Template-mode variable buttons append to the ordered {{1}}, {{2}}... param list instead.
  document.querySelectorAll(".tpl-var-btn[data-tplvar]").forEach((btn) => {
    btn.addEventListener("click", () => {
      templateParamOrder.push(btn.getAttribute("data-tplvar"));
      renderTemplateParamChips();
      updatePreview();
    });
  });

  renderTemplateParamChips();

  // If arriving from the Templates page ("Use in campaign"), open the
  // builder pre-filled with the chosen message body.
  const params = new URLSearchParams(window.location.search);
  const prefill = sessionStorage.getItem("mc_prefill_message");
  if (params.get("prefill") === "1" && prefill !== null) {
    showFormView().then(() => {
      document.getElementById("fieldMessage").value = prefill;
      updatePreview();
    });
    sessionStorage.removeItem("mc_prefill_message");
  }
});

I18N.onChange(() => { renderCampaignsList(); updatePreview(); updateRecipientCount(); renderTemplateParamChips(); });
