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
let convFilter = "all"; // "all" | "unread" | "replied"
let threadCache = {}; // mobile -> last-known rows[], so re-opening a chat is instant (stale-while-revalidate)
// The message currently staged to be quoted in the next outgoing reply (WhatsApp-style
// "swipe to reply"), or null. { id, waMessageId, direction, agentUsername, body } —
// `id` is our own inbox row id (ReplyToId, for rendering the quote in OUR UI),
// `waMessageId` is the real WhatsApp wamid (for WhatsApp's own native reply threading).
let replyingTo = null;

// --- Read/unread tracking -------------------------------------------------
// Shared across every device and agent — the backend keeps one row per
// conversation in the InboxReadState sheet (see Code.gs) and returns
// LastReadTimestamp/LastReadBy on every conversation. A conversation is
// "unread" whenever its latest message is newer than that read cursor.
function isConvUnread(c) {
  if (!c.LastTimestamp) return false;
  // If the last activity was something WE sent (agent reply, campaign
  // blast, "start new conversation" template, etc.), it can never be
  // "unread" — that status only makes sense for something the customer
  // sent that nobody's looked at yet.
  if (c.LastDirection === "out") return false;
  if (!c.LastReadTimestamp) return true;
  const last = new Date(c.LastTimestamp).getTime();
  const read = new Date(c.LastReadTimestamp).getTime();
  if (isNaN(last) || isNaN(read)) return true;
  return last > read;
}
/** True when the most recent activity in this conversation was
 * something WE sent — a distinct "Sent" bucket that has nothing to do
 * with read/unread state. */
function isConvSent(c) {
  return c.LastDirection === "out";
}
/** Tells the backend this conversation has been seen, and updates our
 * local copy immediately so the UI reflects it without waiting on a
 * round trip. Fire-and-forget — a failed markRead call isn't worth
 * blocking or alarming the user over. */
function markRead(mobile, timestamp) {
  const conv = allConversations.find((c) => c.MobileNumber === mobile);
  const readAt = timestamp || new Date().toISOString();
  if (conv) conv.LastReadTimestamp = readAt;
  if (MCApi.isConfigured()) {
    MCApi.Inbox.markRead(mobile, readAt).catch(() => {});
  }
}

function escapeHtml(str) {
  if (str === undefined || str === null) return "";
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Grows the reply <textarea> to fit its content (up to the CSS max-height,
 * after which it scrolls), then shrinks it back down when text is removed. */
function autoResizeReplyInput(el) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/** Called via onerror when a message's MediaUrl fails to load as an image
 * (meaning it's actually a non-image attachment, e.g. a PDF) — swaps the
 * broken <img> for a plain "attachment" link to the same URL instead. */
function handleMediaError(imgEl) {
  const wrap = imgEl.closest(".msg-media-wrap");
  if (!wrap || wrap.dataset.fallenBack) return; // avoid loops if the link itself 404s
  wrap.dataset.fallenBack = "1";
  wrap.className = "d-flex align-items-center gap-2 mb-1";
  wrap.innerHTML = `<i class="bi bi-file-earmark-fill"></i> <span class="text-decoration-underline">${I18N.t("inbox.attachment")}</span>`;
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
    allConversations = (res.rows || []).filter((c) => c && c.MobileNumber);
    renderConvList();
    if (preserveSelection && activeMobile) loadThread(activeMobile, false);
    prefetchVisibleThreads();
  } catch (err) {
    renderConvList();
  }
}

let prefetchInFlight = false;
/** Quietly warms threadCache for the conversations at the top of the
 * list, so opening one feels instant instead of waiting on Apps
 * Script's ~1-3s round trip. One at a time (not in parallel) — we
 * learned the hard way that hammering Apps Script with concurrent
 * requests causes intermittent failures, so this deliberately trades
 * a little prefetch speed for not overloading the backend. */
async function prefetchVisibleThreads() {
  if (prefetchInFlight) return;
  prefetchInFlight = true;
  try {
    const candidates = allConversations.slice(0, 8).filter((c) => !threadCache[c.MobileNumber]);
    for (const c of candidates) {
      if (document.hidden) break; // don't bother warming caches for a tab nobody's looking at
      try {
        const res = await MCApi.Inbox.thread(c.MobileNumber);
        threadCache[c.MobileNumber] = res.rows || [];
      } catch (err) {
        // Best-effort — a failed prefetch just means that one chat loads
        // normally (with its own spinner) when actually opened.
      }
    }
  } finally {
    prefetchInFlight = false;
  }
}

/** Escapes text for safe HTML insertion, then wraps every case-insensitive
 * occurrence of `query` in <mark> so the match is visible in the snippet. */
function highlightMatch(text, query) {
  const escaped = escapeHtml(text);
  const escapedQuery = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escapedQuery) return escaped;
  return escaped.replace(new RegExp(escapedQuery, "gi"), (m) => `<mark>${m}</mark>`);
}

/** Pulls a short window of text around the first match, so long messages
 * don't blow up the result list — same idea as a search-engine snippet. */
function snippetAround(text, query, radius = 60) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);
  return (start > 0 ? "… " : "") + text.slice(start, end) + (end < text.length ? " …" : "");
}

let messageSearchDebounceTimer = null;
function wireMessageSearch() {
  const input = document.getElementById("messageSearchInput");
  input.addEventListener("input", () => {
    clearTimeout(messageSearchDebounceTimer);
    const query = input.value.trim();
    if (query.length < 2) {
      exitMessageSearch();
      return;
    }
    // Debounced so a fast typist doesn't fire a backend search on every
    // keystroke — only once they pause briefly.
    messageSearchDebounceTimer = setTimeout(() => runMessageSearch(query), 300);
  });
}

function exitMessageSearch() {
  document.getElementById("messageSearchResults").classList.add("d-none");
  document.getElementById("convItems").classList.remove("d-none");
  document.querySelector(".conv-filter-bar").classList.remove("d-none");
}

async function runMessageSearch(query) {
  const resultsBox = document.getElementById("messageSearchResults");
  document.getElementById("convItems").classList.add("d-none");
  document.querySelector(".conv-filter-bar").classList.add("d-none");
  resultsBox.classList.remove("d-none");
  resultsBox.innerHTML = `<div class="p-3 text-center text-secondary small">${I18N.t("common.loading")}</div>`;

  if (!MCApi.isConfigured()) { MCApp.toast(I18N.t("common.error"), "error"); return; }
  try {
    const res = await MCApi.Inbox.search(query);
    // The person may have kept typing while this was in flight — drop a
    // stale response instead of overwriting a newer, still-loading search.
    if (document.getElementById("messageSearchInput").value.trim() !== query) return;
    renderMessageSearchResults(res.rows || [], query);
  } catch (err) {
    resultsBox.innerHTML = `<div class="p-3 text-center text-danger small">${err.message || I18N.t("common.error")}</div>`;
  }
}

function renderMessageSearchResults(rows, query) {
  const resultsBox = document.getElementById("messageSearchResults");
  if (rows.length === 0) {
    resultsBox.innerHTML = `<div class="p-3 text-center text-secondary small">${I18N.t("inbox.messageSearchEmpty")}</div>`;
    return;
  }
  const dateFmt = new Intl.DateTimeFormat(I18N.lang === "ar" ? "ar-EG" : "en-US", { dateStyle: "short", timeStyle: "short" });
  resultsBox.innerHTML = rows.map((r) => `
    <div class="msg-search-item" data-mobile="${escapeHtml(r.MobileNumber)}" data-msg-id="${escapeHtml(r.Id || "")}">
      <div class="d-flex justify-content-between align-items-center">
        <span class="msg-search-name">${escapeHtml(r.CustomerName) || I18N.t("inbox.unknownCustomer")}</span>
        <span class="msg-search-time">${r.Timestamp ? dateFmt.format(new Date(r.Timestamp)) : ""}</span>
      </div>
      <div class="msg-search-snippet" dir="auto">${highlightMatch(snippetAround(String(r.Body || ""), query), query)}</div>
    </div>`).join("");

  resultsBox.querySelectorAll(".msg-search-item").forEach((el) => {
    el.addEventListener("click", () => {
      // Keep the search box and results as-is (like WhatsApp) — only
      // navigate to the chat, and jump straight to the matched message
      // itself (not just the latest one in the conversation).
      loadThread(el.getAttribute("data-mobile"), false, el.getAttribute("data-msg-id") || null);
    });
  });
}

function renderConvList() {
  const box = document.getElementById("convItems");
  const q = document.getElementById("convSearch").value.trim().toLowerCase();
  const rows = allConversations
    .filter((c) => !q
      || String(c.CustomerName || "").toLowerCase().includes(q)
      || String(c.MobileNumber || "").includes(q))
    .filter((c) => {
      if (convFilter === "all") return true;
      if (convFilter === "unread") return isConvUnread(c);
      if (convFilter === "sent") return isConvSent(c);
      // "replied"/read tab: a conversation the customer sent that's
      // already been read — sent-by-us conversations belong in their
      // own "Sent" tab, not lumped in here as if they were "read".
      return !isConvUnread(c) && !isConvSent(c);
    })
    // Pinned conversations always float to the top (this user's own pins
    // only), most-recently-active first within each group.
    .sort((a, b) => (Number(!!b.Pinned) - Number(!!a.Pinned)) || (new Date(b.LastTimestamp) - new Date(a.LastTimestamp)));

  const unreadCount = allConversations.filter(isConvUnread).length;
  const unreadBtn = document.querySelector('.conv-filter-btn[data-filter="unread"]');
  if (unreadBtn) unreadBtn.textContent = `${I18N.t("inbox.filterUnread")}${unreadCount ? ` (${unreadCount})` : ""}`;

  if (rows.length === 0) {
    box.innerHTML = `<div class="p-3 text-center text-secondary small">${I18N.t("inbox.empty")}</div>`;
    return;
  }
  const dateFmt = new Intl.DateTimeFormat(I18N.lang === "ar" ? "ar-EG" : "en-US", { dateStyle: "short", timeStyle: "short" });
  box.innerHTML = rows.map((c) => {
    const unread = isConvUnread(c);
    return `
    <div class="conv-item ${c.MobileNumber === activeMobile ? "active" : ""} ${unread ? "unread" : ""} ${c.Pinned ? "pinned" : ""}" data-mobile="${escapeHtml(c.MobileNumber)}">
      <div class="d-flex justify-content-between align-items-center">
        <span class="conv-name">${c.Pinned ? '<i class="bi bi-pin-angle-fill conv-pin-indicator"></i> ' : ""}${escapeHtml(c.CustomerName) || I18N.t("inbox.unknownCustomer")}${unread ? '<span class="conv-unread-dot"></span>' : ""}</span>
        <span class="conv-time">${c.LastTimestamp ? dateFmt.format(new Date(c.LastTimestamp)) : ""}</span>
      </div>
      <div class="d-flex justify-content-between align-items-end">
        <div>
          <div class="conv-preview" dir="ltr">${escapeHtml(c.MobileNumber)}</div>
          <div class="conv-preview">${c.LastDirection === "out" ? "↩ " : ""}${c.LastStatus === "reaction" ? `${I18N.t("inbox.reactedWith")} ${escapeHtml(c.LastMessage)}` : escapeHtml(c.LastMessage)}</div>
        </div>
        <div class="d-flex gap-1">
          <button type="button" class="btn btn-sm btn-light conv-pin-btn" data-mobile="${escapeHtml(c.MobileNumber)}" data-pinned="${c.Pinned ? "1" : "0"}" title="${c.Pinned ? I18N.t("inbox.unpin") : I18N.t("inbox.pin")}"><i class="bi ${c.Pinned ? "bi-pin-fill" : "bi-pin"}"></i></button>
          ${unread ? `<button type="button" class="btn btn-sm btn-light conv-mark-read-btn" data-mobile="${escapeHtml(c.MobileNumber)}" title="${I18N.t("inbox.markRead")}"><i class="bi bi-check2"></i></button>` : ""}
        </div>
      </div>
    </div>`;
  }).join("");

  box.querySelectorAll(".conv-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".conv-mark-read-btn") || e.target.closest(".conv-pin-btn")) return; // handled separately below
      loadThread(el.getAttribute("data-mobile"), true);
    });
  });
  // Pin / unpin without opening the thread.
  box.querySelectorAll(".conv-pin-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const mobile = btn.getAttribute("data-mobile");
      const wasPinned = btn.getAttribute("data-pinned") === "1";
      const conv = allConversations.find((c) => c.MobileNumber === mobile);
      if (conv) conv.Pinned = !wasPinned; // optimistic — feels instant, no need to wait on the round trip
      renderConvList();
      try {
        if (wasPinned) await MCApi.Inbox.unpin(mobile);
        else await MCApi.Inbox.pin(mobile);
      } catch (err) {
        if (conv) conv.Pinned = wasPinned; // roll back on failure
        renderConvList();
        MCApp.toast(err.message || I18N.t("common.error"), "error");
      }
    });
  });
  // "Mark as read" without opening the thread — for messages that don't
  // need a reply (a thank-you, an emoji reaction, etc).
  box.querySelectorAll(".conv-mark-read-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const mobile = btn.getAttribute("data-mobile");
      const conv = allConversations.find((c) => c.MobileNumber === mobile);
      markRead(mobile, conv && conv.LastTimestamp);
      renderConvList();
    });
  });
}

async function loadThread(mobile, scrollToBottom, highlightId) {
  const isSwitchingConversation = activeMobile !== mobile;
  activeMobile = mobile;
  // Switching conversations means any staged reply no longer applies — but
  // a background poll refresh of the SAME conversation (every few seconds,
  // to pick up new incoming messages) shouldn't wipe out a reply someone
  // is still in the middle of composing.
  if (isSwitchingConversation && replyingTo) cancelReply();
  // Mark it read the moment it's opened — that's the point of opening it.
  const openedConv = allConversations.find((c) => c.MobileNumber === mobile);
  markRead(mobile, openedConv && openedConv.LastTimestamp);
  renderConvList();
  document.getElementById("emptyPane").classList.add("d-none");
  document.getElementById("activeThread").classList.remove("d-none");

  const conv = openedConv;
  document.getElementById("threadName").textContent = (conv && conv.CustomerName) || I18N.t("inbox.unknownCustomer");
  document.getElementById("threadMobile").textContent = mobile;

  // Stale-while-revalidate: if we already have this thread cached from a
  // previous visit, paint it immediately (feels instant) while we fetch the
  // real up-to-date version in the background and swap it in once it lands.
  const cached = threadCache[mobile];
  // Paint the cached copy immediately, but respect the caller's intent on
  // whether to jump to the bottom — a silent background poll refresh of
  // the currently-open chat passes scrollToBottom=false precisely so it
  // doesn't yank someone away from history they're reading. Hardcoding
  // "true" here (as before) forced a jump to the latest message on
  // *every* poll cycle regardless of where the person had scrolled to.
  // `highlightId` (coming from a message-search result click) overrides
  // both — jump to and flash that specific message instead of the bottom.
  if (cached) renderThread(cached, scrollToBottom, highlightId);
  else {
    document.getElementById("threadBody").innerHTML = `<div class="text-center text-secondary small py-3">${I18N.t("common.loading") || "…"}</div>`;
  }

  try {
    const res = await MCApi.Inbox.thread(mobile);
    if (mobile !== activeMobile) return; // user already switched to another chat — drop this stale response
    threadCache[mobile] = res.rows || [];
    renderThread(res.rows || [], scrollToBottom || !cached, highlightId);
    // The background refresh may have revealed an even newer last message
    // than what we knew when we first marked this read — catch up again.
    const freshConv = allConversations.find((c) => c.MobileNumber === mobile);
    if (freshConv) markRead(mobile, freshConv.LastTimestamp);
  } catch (err) {
    if (!cached) MCApp.toast(err.message || I18N.t("common.error"), "error");
  }
}

/** Scrolls a specific message bubble into view within the open thread and
 * flashes it briefly, so it's obvious which one was being pointed to —
 * used both for "jump to this message" from search and for tapping a
 * quoted reply to find its original. */
function scrollToMessage(id) {
  if (!id) return;
  const body = document.getElementById("threadBody");
  const el = body.querySelector(`[data-msg-id="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("msg-highlight");
  // Force a reflow so re-adding the class restarts the flash animation
  // even if the same message was just highlighted a moment ago.
  void el.offsetWidth;
  el.classList.add("msg-highlight");
  setTimeout(() => el.classList.remove("msg-highlight"), 1600);
}

/** Builds the small WhatsApp-style quoted-message box shown inside a bubble
 * that's a reply to an earlier message. `quoted` is the original row (looked
 * up by id within the same thread) or undefined if it couldn't be found. */
function buildQuoteHtml(quoted) {
  if (!quoted) {
    return `<div class="msg-quote" dir="auto"><div class="msg-quote-body"><div class="msg-quote-text fst-italic">${I18N.t("inbox.originalDeleted")}</div></div></div>`;
  }
  const name = quoted.Direction === "out"
    ? (quoted.AgentUsername || I18N.t("meta.appName"))
    : (document.getElementById("threadName").textContent || "");
  const rawText = String(quoted.Body ?? "");
  const cleanText = /^\[(image|document|video|audio|sticker)\]$/i.test(rawText.trim())
    ? (quoted.MediaUrl ? I18N.t("inbox.attachment") : "")
    : rawText;
  const snippet = cleanText.length > 90 ? cleanText.slice(0, 90) + "…" : cleanText;
  return `
    <div class="msg-quote" dir="auto" data-target-id="${escapeHtml(quoted.Id || "")}">
      <div class="msg-quote-bar"></div>
      <div class="msg-quote-body">
        <div class="msg-quote-name">${escapeHtml(name)}</div>
        <div class="msg-quote-text">${escapeHtml(snippet)}</div>
      </div>
    </div>`;
}

/** Stages a message to be quoted in the next outgoing reply — the WhatsApp
 * "Reply" action. `rows` is the full thread currently on screen, so we can
 * look up the exact row being replied to by id. */
function startReplyTo(id, rows) {
  const row = (rows || threadCache[activeMobile] || []).find((r) => r.Id === id);
  if (!row) return;
  replyingTo = { id: row.Id, waMessageId: row.WaMessageId || "", direction: row.Direction, agentUsername: row.AgentUsername, body: row.Body, mediaUrl: row.MediaUrl };
  renderReplyPreview();
  document.getElementById("replyInput").focus();
}

function cancelReply() {
  replyingTo = null;
  renderReplyPreview();
}

function renderReplyPreview() {
  const bar = document.getElementById("replyPreviewBar");
  if (!bar) return;
  if (!replyingTo) { bar.classList.add("d-none"); return; }
  bar.classList.remove("d-none");
  document.getElementById("replyPreviewName").textContent = replyingTo.direction === "out"
    ? (replyingTo.agentUsername || I18N.t("meta.appName"))
    : (document.getElementById("threadName").textContent || "");
  const rawText = String(replyingTo.body ?? "");
  const cleanText = /^\[(image|document|video|audio|sticker)\]$/i.test(rawText.trim())
    ? (replyingTo.mediaUrl ? I18N.t("inbox.attachment") : "")
    : rawText;
  document.getElementById("replyPreviewText").textContent = cleanText;
}

function renderThread(rows, forceScrollToBottom, highlightId) {
  const body = document.getElementById("threadBody");
  // Only auto-scroll if the user was already near the bottom (or we're told
  // to force it, e.g. right after sending). Otherwise a live update would
  // yank someone away from history they're scrolled up reading. A specific
  // message to highlight (from search) takes priority over both.
  const wasNearBottom = !highlightId && (forceScrollToBottom || (body.scrollHeight - body.scrollTop - body.clientHeight < 80));
  const timeFmt = new Intl.DateTimeFormat(I18N.lang === "ar" ? "ar-EG" : "en-US", { hour: "2-digit", minute: "2-digit" });
  // So a reply bubble can show a quoted preview of the message it's
  // replying to, without a separate round trip — look it up by id within
  // the same thread that's already loaded.
  const rowsById = {};
  rows.forEach((r) => { if (r && r.Id) rowsById[r.Id] = r; });
  // Skip any blank/malformed rows (e.g. an empty row in the sheet) instead
  // of letting them throw and abort the whole render.
  body.innerHTML = rows.filter((r) => r && (r.Body || r.MediaUrl)).map((r) => {
    // Reactions (👍, ❤️, etc. on a message) come through as their own row
    // (Status === "reaction", see Code.gs) — render them as a small,
    // borderless emoji instead of a normal chat bubble; a full-size box
    // around a single emoji looks broken and buries it visually.
    if (r.Status === "reaction") {
      return `
      <div class="msg-reaction ${r.Direction === "out" ? "out" : "in"}" dir="auto">
        <span class="msg-reaction-emoji">${escapeHtml(String(r.Body ?? ""))}</span>
        <span class="msg-time">${r.Timestamp ? timeFmt.format(new Date(r.Timestamp)) : ""}</span>
      </div>`;
    }
    // We can't reliably tell "image vs. document" from the URL alone (e.g.
    // Drive links like drive.google.com/uc?...id=... have no file
    // extension), so always try rendering it as an image first; if the
    // browser fails to load it as an image (onerror), swap it for a plain
    // attachment link instead. See handleMediaError() below.
    const mediaHtml = r.MediaUrl
      ? `<a href="${escapeHtml(r.MediaUrl)}" target="_blank" class="msg-media-wrap"><img src="${escapeHtml(r.MediaUrl)}" alt="" style="max-width:260px;max-height:260px;border-radius:8px;margin-bottom:4px;display:block;object-fit:cover;" onerror="handleMediaError(this)"></a>`
      : "";
    // Collapse 3+ consecutive newlines down to a single blank line, collapse
    // runs of 2+ spaces/tabs down to one (senders often pad messages with
    // extra spaces for visual alignment on their own phone — those invisible
    // gaps still take up real width under white-space:pre-wrap), and trim
    // leading/trailing whitespace, so bubbles hug the actual visible text.
    // "[image]" / "[document]" are internal placeholders (see backend) used
    // when there's no real caption — don't show them as if they were text.
    const rawBody = String(r.Body ?? "");
    const cleanBody = /^\[(image|document|video|audio|sticker)\]$/i.test(rawBody.trim()) ? "" : rawBody
      .replace(/\n{3,}/g, "\n\n")
      .split("\n").map((line) => line.replace(/[ \t]{2,}/g, " ").trim()).join("\n")
      .trim();
    const quoteHtml = r.ReplyToId ? buildQuoteHtml(rowsById[r.ReplyToId]) : "";
    return `
    <div class="msg-bubble ${r.Direction === "out" ? "out" : "in"} ${r._pending ? "pending" : ""}" dir="auto" data-msg-id="${escapeHtml(r.Id || "")}">
      ${r.Id ? `<span class="msg-reply-btn" data-msg-id="${escapeHtml(r.Id)}" title="${escapeHtml(I18N.t("inbox.reply"))}"><i class="bi bi-reply-fill"></i></span>` : ""}
      ${r.Direction === "out" && r.AgentUsername ? `<div class="msg-agent-label">${escapeHtml(r.AgentUsername)}</div>` : ""}
      ${quoteHtml}
      ${mediaHtml}
      <span class="msg-text">${escapeHtml(cleanBody)}</span>&nbsp;<span class="msg-time">${r._pending ? "…" : (r.Timestamp ? timeFmt.format(new Date(r.Timestamp)) : "")}</span>
    </div>`;
  }).join("");

  // Reply button: stage this message to be quoted in the next outgoing send.
  body.querySelectorAll(".msg-reply-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      startReplyTo(btn.getAttribute("data-msg-id"), rows);
    });
  });
  // Tapping a quoted preview inside a bubble jumps to the original message —
  // same "find the original" behavior WhatsApp itself has.
  body.querySelectorAll(".msg-quote[data-target-id]").forEach((q) => {
    q.addEventListener("click", () => scrollToMessage(q.getAttribute("data-target-id")));
  });

  if (highlightId) scrollToMessage(highlightId);
  else if (wasNearBottom) body.scrollTop = body.scrollHeight;
}

async function sendReply() {
  const input = document.getElementById("replyInput");
  const text = input.value.trim();
  if (!text || !activeMobile) return;
  const mobile = activeMobile;
  const replyTarget = replyingTo; // capture before clearing — sendReply itself is async

  // Optimistic send: paint the message immediately and clear the box right
  // away instead of waiting on the (often slow) Apps Script round trip —
  // we reconcile with the real server copy in the background afterwards.
  input.value = "";
  autoResizeReplyInput(input);
  cancelReply(); // clear the "replying to ..." preview bar, like WhatsApp does on send
  const currentUsername = (typeof MCAuth !== "undefined" && MCAuth.getSession && MCAuth.getSession()) ? MCAuth.getSession().username : "";
  const optimisticRow = { Direction: "out", Body: text, Timestamp: new Date().toISOString(), AgentUsername: currentUsername, _pending: true, ReplyToId: replyTarget ? replyTarget.id : "" };
  threadCache[mobile] = [...(threadCache[mobile] || []), optimisticRow];
  if (mobile === activeMobile) renderThread(threadCache[mobile], true);
  // Reflect it in the conversation list preview immediately too.
  const conv = allConversations.find((c) => c.MobileNumber === mobile);
  if (conv) { conv.LastMessage = text; conv.LastDirection = "out"; conv.LastTimestamp = optimisticRow.Timestamp; markRead(mobile, optimisticRow.Timestamp); renderConvList(); }

  try {
    await MCApi.Inbox.send(mobile, text, replyTarget ? replyTarget.id : undefined, replyTarget ? replyTarget.waMessageId : undefined);
    // Fire-and-forget background reconcile — don't block the UI on it.
    loadThread(mobile, false);
    loadConversations(true);
  } catch (err) {
    // Roll back the optimistic bubble and let the person know it didn't go.
    threadCache[mobile] = (threadCache[mobile] || []).filter((r) => r !== optimisticRow);
    if (mobile === activeMobile) renderThread(threadCache[mobile], false);
    // Give them the reply context back too, so they don't have to re-pick the message.
    if (replyTarget) { replyingTo = replyTarget; renderReplyPreview(); }
    MCApp.toast(err.message || I18N.t("inbox.sendError"), "error");
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
  wireMessageSearch();
  document.querySelectorAll(".conv-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      convFilter = btn.getAttribute("data-filter");
      document.querySelectorAll(".conv-filter-btn").forEach((b) => b.classList.toggle("active", b === btn));
      renderConvList();
    });
  });
  document.getElementById("refreshBtn").addEventListener("click", () => loadConversations(true));
  document.getElementById("sendReplyBtn").addEventListener("click", sendReply);
  document.getElementById("cancelReplyBtn").addEventListener("click", cancelReply);
  const replyInputEl = document.getElementById("replyInput");
  replyInputEl.addEventListener("keydown", (e) => {
    // Enter sends the message; Shift+Enter inserts a real newline instead
    // (default <textarea> behavior — just don't intercept it).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendReply();
    }
  });
  replyInputEl.addEventListener("input", () => autoResizeReplyInput(replyInputEl));
  document.getElementById("attachBtn").addEventListener("click", () => document.getElementById("attachFileInput").click());
  document.getElementById("attachFileInput").addEventListener("change", (e) => {
    sendAttachment(e.target.files[0]);
    e.target.value = "";
  });

  let newConversationModal;
  let qrSehaModal;
  /** Wires up a "type a mobile number → send a fixed pre-approved
   * template" flow. Both "start new conversation" and "send Seha QR"
   * are the exact same interaction, just against a different backend
   * action and modal — this avoids duplicating the logic twice. */
  function wireStartConversationModal({ triggerBtnId, modalId, mobileInputId, errorId, sendBtnId, apiCall, sentMessageKey }) {
    let modalInstance;
    document.getElementById(triggerBtnId).addEventListener("click", () => {
      if (!modalInstance) modalInstance = new bootstrap.Modal(document.getElementById(modalId));
      document.getElementById(mobileInputId).value = "";
      document.getElementById(errorId).classList.add("d-none");
      modalInstance.show();
      setTimeout(() => document.getElementById(mobileInputId).focus(), 200);
    });
    document.getElementById(sendBtnId).addEventListener("click", async () => {
      const input = document.getElementById(mobileInputId);
      const errEl = document.getElementById(errorId);
      const btn = document.getElementById(sendBtnId);
      const mobile = input.value.replace(/[^0-9]/g, "");
      errEl.classList.add("d-none");
      if (!mobile) {
        errEl.textContent = I18N.t("inbox.newConversation.invalidMobile");
        errEl.classList.remove("d-none");
        return;
      }
      if (!MCApi.isConfigured()) { MCApp.toast(I18N.t("common.error"), "error"); return; }
      btn.disabled = true;
      try {
        await apiCall(mobile);
        modalInstance.hide();
        MCApp.toast(I18N.t(sentMessageKey), "success");
        await loadConversations(true);
        await loadThread(mobile, true);
      } catch (err) {
        errEl.textContent = err.message || I18N.t("common.error");
        errEl.classList.remove("d-none");
      } finally {
        btn.disabled = false;
      }
    });
  }

  wireStartConversationModal({
    triggerBtnId: "newConversationBtn", modalId: "newConversationModal",
    mobileInputId: "newConversationMobile", errorId: "newConversationError", sendBtnId: "newConversationSendBtn",
    apiCall: (mobile) => MCApi.Inbox.startNewConversation(mobile), sentMessageKey: "inbox.newConversation.sent",
  });
  wireStartConversationModal({
    triggerBtnId: "qrSehaBtn", modalId: "qrSehaModal",
    mobileInputId: "qrSehaMobile", errorId: "qrSehaError", sendBtnId: "qrSehaSendBtn",
    apiCall: (mobile) => MCApi.Inbox.sendQrSeha(mobile), sentMessageKey: "inbox.qrSeha.sent",
  });
  wireStartConversationModal({
    triggerBtnId: "reportReqBtn", modalId: "reportReqModal",
    mobileInputId: "reportReqMobile", errorId: "reportReqError", sendBtnId: "reportReqSendBtn",
    apiCall: (mobile) => MCApi.Inbox.sendReportRequest(mobile), sentMessageKey: "inbox.reportReq.sent",
  });
  // Live-updates so new incoming messages show up without a manual refresh.
  // Apps Script has a low concurrent-execution ceiling, so we poll at a
  // moderate interval (not too fast) and skip a cycle entirely if the
  // previous one hasn't finished yet — overlapping requests were flooding
  // the backend and causing intermittent "حدث خطأ ما" failures.
  pollTimer = setInterval(async () => {
    if (!MCApi.isConfigured() || document.hidden || pollInFlight || prefetchInFlight) return;
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

I18N.onChange(() => { renderConvList(); if (activeMobile) loadThread(activeMobile, false); renderReplyPreview(); });
