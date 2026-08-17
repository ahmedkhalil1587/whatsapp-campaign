/**
 * inbox.js
 * A simple two-pane inbox: conversation list on the left (one row per
 * mobile number, from the "Inbox" sheet, populated by the webhook when
 * customers message the business number), and a WhatsApp-style thread
 * on the right with a reply box. Replies are free-form text, so they
 * only deliver within the customer's 24h reply window — same rule as
 * everywhere else in the app.
 */

let allConversations = [];
let activeMobile = null;
let pollTimer = null;
let pollInFlight = false; // guards against overlapping poll cycles hammering Apps Script

function escapeHtml(str) {
  if (str === undefined || str === null) return "";
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function loadConversations(preserveSelection = true) {
  const note = document.getElementById("notConnectedNote");
  if (!MCApi.isConfigured()) {
    note.classList.remove("d-none");
    allConversations = [];
    renderConvList();
    return;
  }
  note.classList.add("d-none");
  try {
    const res = await MCApi.Inbox.list();
    allConversations = res.rows || [];
    renderConvList();
    if (preserveSelection && activeMobile) loadThread(activeMobile, false);
  } catch (err) {
    renderConvList();
  }
}

function renderConvList() {
  const box = document.getElementById("convItems");
  const q = document.getElementById("convSearch").value.trim().toLowerCase();
  const rows = allConversations.filter((c) => !q
    || String(c.CustomerName || "").toLowerCase().includes(q)
    || String(c.MobileNumber || "").includes(q));

  if (rows.length === 0) {
    box.innerHTML = `<div class="p-3 text-center text-secondary small">${I18N.t("inbox.empty")}</div>`;
    return;
  }
  const dateFmt = new Intl.DateTimeFormat(I18N.lang === "ar" ? "ar-EG" : "en-US", { dateStyle: "short", timeStyle: "short" });
  box.innerHTML = rows.map((c) => `
    <div class="conv-item ${c.MobileNumber === activeMobile ? "active" : ""}" data-mobile="${escapeHtml(c.MobileNumber)}">
      <div class="d-flex justify-content-between align-items-center">
        <span class="conv-name">${escapeHtml(c.CustomerName) || I18N.t("inbox.unknownCustomer")}</span>
        <span class="conv-time">${c.LastTimestamp ? dateFmt.format(new Date(c.LastTimestamp)) : ""}</span>
      </div>
      <div class="conv-preview" dir="ltr">${escapeHtml(c.MobileNumber)}</div>
      <div class="conv-preview">${c.LastDirection === "out" ? "↩ " : ""}${escapeHtml(c.LastMessage)}</div>
    </div>`).join("");

  box.querySelectorAll(".conv-item").forEach((el) => {
    el.addEventListener("click", () => loadThread(el.getAttribute("data-mobile"), true));
  });
}

async function loadThread(mobile, scrollToBottom) {
  activeMobile = mobile;
  renderConvList();
  document.getElementById("emptyPane").classList.add("d-none");
  document.getElementById("activeThread").classList.remove("d-none");

  const conv = allConversations.find((c) => c.MobileNumber === mobile);
  document.getElementById("threadName").textContent = (conv && conv.CustomerName) || I18N.t("inbox.unknownCustomer");
  document.getElementById("threadMobile").textContent = mobile;

  try {
    const res = await MCApi.Inbox.thread(mobile);
    renderThread(res.rows || [], scrollToBottom);
  } catch (err) {
    MCApp.toast(err.message || I18N.t("common.error"), "error");
  }
}

function renderThread(rows, forceScrollToBottom) {
  const body = document.getElementById("threadBody");
  // Only auto-scroll if the user was already near the bottom (or we're told
  // to force it, e.g. right after sending). Otherwise a live update would
  // yank someone away from history they're scrolled up reading.
  const wasNearBottom = forceScrollToBottom || (body.scrollHeight - body.scrollTop - body.clientHeight < 80);
  const timeFmt = new Intl.DateTimeFormat(I18N.lang === "ar" ? "ar-EG" : "en-US", { hour: "2-digit", minute: "2-digit" });
  body.innerHTML = rows.map((r) => {
    const isImage = r.MediaUrl && /\.(jpe?g|png|gif|webp)$/i.test(r.MediaUrl);
    const isDoc = r.MediaUrl && !isImage;
    const mediaHtml = isImage
      ? `<img src="${escapeHtml(r.MediaUrl)}" style="max-width:100%;border-radius:8px;margin-bottom:4px;display:block;">`
      : isDoc
        ? `<a href="${escapeHtml(r.MediaUrl)}" target="_blank" class="d-flex align-items-center gap-2 mb-1"><i class="bi bi-file-earmark-fill"></i> <span class="text-decoration-underline">${I18N.t("inbox.attachment")}</span></a>`
        : "";
    // Collapse 3+ consecutive newlines down to a single blank line, collapse
    // runs of 2+ spaces/tabs down to one (senders often pad messages with
    // extra spaces for visual alignment on their own phone — those invisible
    // gaps still take up real width under white-space:pre-wrap), and trim
    // leading/trailing whitespace, so bubbles hug the actual visible text.
    const cleanBody = (r.Body || "")
      .replace(/\n{3,}/g, "\n\n")
      .split("\n").map((line) => line.replace(/[ \t]{2,}/g, " ").trim()).join("\n")
      .trim();
    return `
    <div class="msg-bubble ${r.Direction === "out" ? "out" : "in"}" dir="auto">
      ${mediaHtml}
      <span class="msg-text">${escapeHtml(cleanBody)}</span>&nbsp;<span class="msg-time">${r.Timestamp ? timeFmt.format(new Date(r.Timestamp)) : ""}</span>
    </div>`;
  }).join("");
  if (wasNearBottom) body.scrollTop = body.scrollHeight;
}

async function sendReply() {
  const input = document.getElementById("replyInput");
  const text = input.value.trim();
  if (!text || !activeMobile) return;
  const btn = document.getElementById("sendReplyBtn");
  btn.disabled = true;
  try {
    await MCApi.Inbox.send(activeMobile, text);
    input.value = "";
    await loadThread(activeMobile, true);
    await loadConversations(true);
  } catch (err) {
    MCApp.toast(I18N.t("inbox.sendError"), "error");
  } finally {
    btn.disabled = false;
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function sendAttachment(file) {
  if (!file || !activeMobile) return;
  if (!MCApi.isConfigured()) { MCApp.toast(I18N.t("common.error"), "error"); return; }
  const btn = document.getElementById("attachBtn");
  btn.disabled = true;
  try {
    const base64 = await fileToBase64(file);
    const uploadRes = await MCApi.Media.upload(file.name, file.type, base64);
    const mediaType = file.type.startsWith("image/") ? "image" : "document";
    await MCApi.Inbox.sendMedia(activeMobile, uploadRes.url, mediaType, "", file.name);
    await loadThread(activeMobile, true);
    await loadConversations(true);
  } catch (err) {
    MCApp.toast(I18N.t("inbox.sendError"), "error");
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => loadConversations(false), 60);

  document.getElementById("convSearch").addEventListener("input", renderConvList);
  document.getElementById("refreshBtn").addEventListener("click", () => loadConversations(true));
  document.getElementById("sendReplyBtn").addEventListener("click", sendReply);
  document.getElementById("replyInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendReply();
  });
  document.getElementById("attachBtn").addEventListener("click", () => document.getElementById("attachFileInput").click());
  document.getElementById("attachFileInput").addEventListener("change", (e) => {
    sendAttachment(e.target.files[0]);
    e.target.value = "";
  });

  // Live-updates so new incoming messages show up without a manual refresh.
  // Apps Script has a low concurrent-execution ceiling, so we poll at a
  // moderate interval (not too fast) and skip a cycle entirely if the
  // previous one hasn't finished yet — overlapping requests were flooding
  // the backend and causing intermittent "حدث خطأ ما" failures.
  pollTimer = setInterval(async () => {
    if (!MCApi.isConfigured() || document.hidden || pollInFlight) return;
    pollInFlight = true;
    try {
      await loadConversations(true);
    } finally {
      pollInFlight = false;
    }
  }, 10000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && MCApi.isConfigured() && !pollInFlight) loadConversations(true);
  });
  window.addEventListener("beforeunload", () => clearInterval(pollTimer));
});

I18N.onChange(() => { renderConvList(); if (activeMobile) loadThread(activeMobile, false); });
