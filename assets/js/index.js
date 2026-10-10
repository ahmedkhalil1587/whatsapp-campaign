/**
 * MedConnect Campaigns — Cloudflare Worker backend (D1-based)
 * ---------------------------------------------------------------
 * PHASE 2 of the migration: auth.login + session handling only.
 * Mirrors backend/Code.gs's single-endpoint action-router contract
 * EXACTLY (same {action, token, ...} request shape, same {ok:true/false,...}
 * response shape) so the existing frontend (assets/js/api.js) needs ZERO
 * code changes — only the saved backend URL (mc_gas_url in localStorage)
 * changes, once every phase is done.
 *
 * Every other action (doctors.*, campaigns.*, inbox.*, ...) will be added
 * in later phases, following the same pattern as auth.login below.
 */

const SESSION_TTL_SECONDS = 21600; // 6 hours — same as Apps Script, but backed by D1 instead of CacheService (no silent eviction)

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Meta webhook verification handshake (unchanged in later phases)
    if (request.method === "GET" && url.searchParams.get("hub.mode") === "subscribe") {
      const expected = env.WA_WEBHOOK_VERIFY_TOKEN;
      if (url.searchParams.get("hub.verify_token") === expected) {
        return new Response(url.searchParams.get("hub.challenge") || "");
      }
      return new Response("Verification failed", { status: 403 });
    }

    let body = {};
    if (request.method === "POST") {
      try {
        body = await request.json();
      } catch (err) {
        body = {};
      }
    } else {
      body = Object.fromEntries(url.searchParams.entries());
    }

    // Serves images/videos/documents that customers sent us (and anything
    // uploaded via media.upload) — replaces Google Drive's role.
    if (request.method === "GET" && url.pathname.startsWith("/media/")) {
      if (!env.MEDIA) return new Response("Media storage isn't set up yet.", { status: 503 });
      const key = decodeURIComponent(url.pathname.slice("/media/".length));
      const obj = await env.MEDIA.get(key);
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(obj.body, { headers: { "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream" } });
    }

    // Meta sends delivery/read/failed status updates AND incoming customer
    // messages as a POST with no "action" field.
    if (request.method === "POST" && body.object === "whatsapp_business_account") {
      await handleWebhookEvent(env, body, url.origin);
      return jsonResponse({ ok: true });
    }

    const action = body.action;
    let result;
    try {
      result = await routeAction(action, body, env, url.origin);
    } catch (err) {
      result = { ok: false, error: err.message };
    }

    return jsonResponse(result);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processScheduledCampaigns(env));
    // Auto-delete only needs to run once a day — this cron fires every 10
    // minutes, so only act during the 03:00–03:09 UTC window (matches the
    // "atHour(3)" quiet-hours choice from the Apps Script trigger).
    const hour = new Date().getUTCHours();
    if (hour === 3) ctx.waitUntil(deleteOldConversations(env));
  },
};

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

// ---------------------------------------------------------------
// Session-based authorization — identical policy to Code.gs's
// PUBLIC_ACTIONS_ / AGENT_ALLOWED_ACTIONS_, kept in sync as actions
// are added in later phases.
// ---------------------------------------------------------------

const PUBLIC_ACTIONS = ["auth.login", "auth.register", "auth.verify"];
const AGENT_ALLOWED_ACTIONS = [
  "doctors.list", "doctors.create", "doctors.update", "doctors.delete", "doctors.bulkImport",
  "inbox.list", "inbox.thread", "inbox.send", "inbox.sendMedia", "inbox.markRead",
  "inbox.startNewConversation", "inbox.sendQrSeha", "inbox.sendReportRequest",
  "inbox.pin", "inbox.unpin", "inbox.search", "media.upload",
];

async function routeAction(action, body, env, workerOrigin) {
  let session = null;
  if (!PUBLIC_ACTIONS.includes(action)) {
    session = await validateToken(env, body.token);
    if (!session) return { ok: false, error: "Session expired. Please log in again." };
    if (session.role !== "admin" && !AGENT_ALLOWED_ACTIONS.includes(action)) {
      return { ok: false, error: "You don't have permission for this action." };
    }
  }

  switch (action) {
    case "auth.login":
      return authLogin(env, body.username, body.password);

    case "doctors.list":       return { ok: true, rows: await doctorsList(env) };
    case "doctors.create":     return { ok: true, row: await doctorsCreate(env, body.doctor) };
    case "doctors.update":     return { ok: true, row: await doctorsUpdate(env, body.id, body.doctor) };
    case "doctors.delete":     return { ok: true, deleted: await doctorsDelete(env, body.id) };
    case "doctors.bulkImport": return { ok: true, count: await doctorsBulkImport(env, body.rows) };

    case "templates.list":     return { ok: true, rows: await templatesList(env) };
    case "templates.create":   return { ok: true, row: await templatesCreate(env, body.template) };
    case "templates.update":   return { ok: true, row: await templatesUpdate(env, body.id, body.template) };
    case "templates.delete":   return { ok: true, deleted: await templatesDelete(env, body.id) };

    case "campaigns.list":       return { ok: true, rows: await campaignsList(env) };
    case "campaigns.create":     return { ok: true, row: await campaignsCreate(env, body.campaign) };
    case "campaigns.send":       return sendCampaign(env, body.id);
    case "campaigns.retryFailed":return retryFailedMessages(env, body.id);
    case "campaigns.logs":       return { ok: true, rows: await campaignLogs(env, body.id) };
    case "campaigns.pause":      return { ok: true, row: await campaignsUpdate(env, body.id, { Status: "Paused" }) };
    case "campaigns.resume":     return sendCampaign(env, body.id, { forceResume: true });

    case "inbox.list":        return { ok: true, rows: await buildInboxConversations(env, session.username) };
    case "inbox.thread":      return { ok: true, rows: await getThreadRows(env, body.mobile) };
    case "inbox.send":        return sendInboxReply(env, body.mobile, body.text, session.username, body.replyToId, body.replyToWaMessageId);
    case "inbox.sendMedia":   return sendInboxMedia(env, body.mobile, body.mediaUrl, body.mediaType, body.caption, body.filename, session.username);
    case "inbox.markRead":    return { ok: true, readAt: await markConversationRead(env, body.mobile, body.timestamp, session.username) };
    case "inbox.startNewConversation": return startNewConversation(env, body.mobile, session.username);
    case "inbox.sendQrSeha":  return sendQrSehaConversation(env, body.mobile, session.username);
    case "inbox.sendReportRequest": return sendReportRequestConversation(env, body.mobile, session.username);
    case "inbox.pin":         return pinConversation(env, session.username, body.mobile);
    case "inbox.unpin":       return unpinConversation(env, session.username, body.mobile);
    case "inbox.search":      return { ok: true, rows: await searchInboxMessages(env, body.query) };
    case "inbox.agentStatsRange": return { ok: true, stats: await buildAgentStatsRange(env, body.startDate, body.endDate) };

    case "dashboard.stats":   return { ok: true, stats: await buildDashboardStats(env) };
    case "history.list":      return { ok: true, rows: await buildHistoryRows(env) };

    case "settings.get":      return { ok: true, settings: getPublicSettings(env) };
    case "settings.save":     return { ok: false, error: "Secrets are now managed via `wrangler secret put` from the CLI, not this page." };

    case "media.upload": {
      const uploaded = await mediaUpload(env, body.filename, body.mimeType, body.base64);
      uploaded.url = uploaded.url.replace("__ORIGIN__", workerOrigin);
      return uploaded;
    }

    case "auth.register":     return registerSignup(env, body.name, body.email, body.password);
    case "auth.verify":       return verifySignup(env, body.email, body.code);
    case "signups.list":      return { ok: true, rows: await listSignups(env) };
    case "signups.approve":   return approveSignup(env, body.id, body.role);
    case "signups.reject":    return rejectSignup(env, body.id);

    default:
      return { ok: false, error: "Not migrated to Cloudflare yet: " + action };
  }
}

// ---------------------------------------------------------------
// Sessions (D1-backed — replaces Apps Script's CacheService, which
// was the root cause of the random login drops / "hard refresh to
// log in" behavior: CacheService evicts early under load, D1 doesn't)
// ---------------------------------------------------------------

function genToken() {
  return crypto.randomUUID();
}

async function generateToken(env, username, role) {
  const token = genToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token, username, role, expires_at) VALUES (?, ?, ?, ?)")
    .bind(token, username, role, expiresAt)
    .run();
  return token;
}

async function validateToken(env, token) {
  if (!token) return null;
  const row = await env.DB.prepare("SELECT username, role, expires_at FROM sessions WHERE token = ?")
    .bind(token)
    .first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    return null;
  }
  // Slide the expiration window forward on activity, same as Code.gs's validateToken_.
  const newExpiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").bind(newExpiresAt, token).run();
  return { username: row.username, role: row.role };
}

// ---------------------------------------------------------------
// Auth
// ---------------------------------------------------------------

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authLogin(env, username, password) {
  const user = await env.DB.prepare("SELECT username, password, name, role FROM users WHERE username = ?")
    .bind(username)
    .first();
  if (!user) return { ok: false, error: "Invalid credentials" };

  const hashed = await sha256Hex(password || "");
  if (String(user.password) !== String(password) && String(user.password) !== hashed) {
    return { ok: false, error: "Invalid credentials" };
  }

  const token = await generateToken(env, user.username, user.role);
  return { ok: true, user: { username: user.username, name: user.name, role: user.role }, token };
}

// ---------------------------------------------------------------
// Doctors (D1 columns are snake_case; the frontend/old Code.gs
// contract uses PascalCase keys — these two maps keep that contract
// identical so assets/js/*.js needs zero changes)
// ---------------------------------------------------------------

function rowToDoctor(r) {
  return { ID: r.id, Name: r.name, Mobile: r.mobile, Specialty: r.specialty, Hospital: r.hospital, City: r.city, Country: r.country, Status: r.status, Notes: r.notes };
}

async function doctorsList(env) {
  const { results } = await env.DB.prepare("SELECT * FROM doctors").all();
  return results.map(rowToDoctor);
}

async function doctorsCreate(env, d) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO doctors (id, name, mobile, specialty, hospital, city, country, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, d.Name || "", d.Mobile || "", d.Specialty || "", d.Hospital || "", d.City || "", d.Country || "", d.Status || "Active", d.Notes || "").run();
  return { ID: id, ...d };
}

async function doctorsUpdate(env, id, d) {
  await env.DB.prepare(
    "UPDATE doctors SET name=?, mobile=?, specialty=?, hospital=?, city=?, country=?, status=?, notes=? WHERE id=?"
  ).bind(d.Name || "", d.Mobile || "", d.Specialty || "", d.Hospital || "", d.City || "", d.Country || "", d.Status || "Active", d.Notes || "", id).run();
  return { ID: id, ...d };
}

async function doctorsDelete(env, id) {
  await env.DB.prepare("DELETE FROM doctors WHERE id=?").bind(id).run();
  return true;
}

async function doctorsBulkImport(env, rows) {
  if (!rows || !rows.length) return 0;
  const stmts = rows.map((d) =>
    env.DB.prepare(
      "INSERT INTO doctors (id, name, mobile, specialty, hospital, city, country, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(crypto.randomUUID(), d.Name || "", d.Mobile || "", d.Specialty || "", d.Hospital || "", d.City || "", d.Country || "", d.Status || "Active", d.Notes || "")
  );
  await env.DB.batch(stmts);
  return rows.length;
}

// ---------------------------------------------------------------
// Templates
// ---------------------------------------------------------------

function rowToTemplate(r) {
  return { ID: r.id, Name: r.name, Body: r.body };
}

async function templatesList(env) {
  const { results } = await env.DB.prepare("SELECT * FROM templates").all();
  return results.map(rowToTemplate);
}

async function templatesCreate(env, t) {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO templates (id, name, body) VALUES (?, ?, ?)").bind(id, t.Name || "", t.Body || "").run();
  return { ID: id, ...t };
}

async function templatesUpdate(env, id, t) {
  await env.DB.prepare("UPDATE templates SET name=?, body=? WHERE id=?").bind(t.Name || "", t.Body || "", id).run();
  return { ID: id, ...t };
}

async function templatesDelete(env, id) {
  await env.DB.prepare("DELETE FROM templates WHERE id=?").bind(id).run();
  return true;
}

// ---------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------

function rowToCampaign(r) {
  return {
    ID: r.id, Name: r.name, Message: r.message, ImageUrl: r.image_url, PdfUrl: r.pdf_url,
    Status: r.status, ScheduledAt: r.scheduled_at, CreatedAt: r.created_at,
    Sent: r.sent, Delivered: r.delivered, Read: r.read, Failed: r.failed,
    RecipientIds: r.recipient_ids, MessageType: r.message_type,
    TemplateName: r.template_name, TemplateLanguage: r.template_language,
    TemplateParams: r.template_params, TemplateParamNames: r.template_param_names,
  };
}

/** Logs is the real source of truth for Sent/Delivered/Read/Failed (webhook status updates only ever touch Logs). */
async function computeAllCampaignStats(env) {
  const { results } = await env.DB.prepare("SELECT campaign_id, status FROM logs").all();
  const map = {};
  results.forEach((l) => {
    const id = String(l.campaign_id);
    if (!map[id]) map[id] = { sent: 0, delivered: 0, read: 0, failed: 0 };
    const status = String(l.status || "");
    if (status.indexOf("failed") === 0) {
      map[id].failed++;
    } else {
      map[id].sent++;
      if (status === "delivered" || status === "read") map[id].delivered++;
      if (status === "read") map[id].read++;
    }
  });
  return map;
}

async function campaignsList(env) {
  const { results } = await env.DB.prepare("SELECT * FROM campaigns ORDER BY created_at DESC").all();
  const stats = await computeAllCampaignStats(env);
  return results.map((r) => {
    const c = rowToCampaign(r);
    const s = stats[String(c.ID)] || { sent: 0, delivered: 0, read: 0, failed: 0 };
    c.Sent = s.sent; c.Delivered = s.delivered; c.Read = s.read; c.Failed = s.failed;
    return c;
  });
}

async function campaignsCreate(env, c) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO campaigns (id, name, message, image_url, pdf_url, status, scheduled_at, created_at, sent, delivered, read, failed, recipient_ids, message_type, template_name, template_language, template_params, template_param_names)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, c.Name || "", c.Message || "", c.ImageUrl || "", c.PdfUrl || "", c.Status || "Draft", c.ScheduledAt || "", createdAt,
    c.RecipientIds || "", c.MessageType || "", c.TemplateName || "", c.TemplateLanguage || "", c.TemplateParams || "", c.TemplateParamNames || ""
  ).run();
  return { ID: id, CreatedAt: createdAt, ...c };
}

async function campaignsUpdate(env, id, fields) {
  const map = { Status: "status", Sent: "sent", Delivered: "delivered", Read: "read", Failed: "failed" };
  const sets = [], vals = [];
  Object.keys(fields).forEach((k) => {
    if (map[k]) { sets.push(map[k] + "=?"); vals.push(fields[k]); }
  });
  if (!sets.length) return null;
  vals.push(id);
  await env.DB.prepare(`UPDATE campaigns SET ${sets.join(", ")} WHERE id=?`).bind(...vals).run();
  const row = await env.DB.prepare("SELECT * FROM campaigns WHERE id=?").bind(id).first();
  return row ? rowToCampaign(row) : null;
}

async function campaignLogs(env, campaignId) {
  const { results } = await env.DB.prepare("SELECT * FROM logs WHERE campaign_id=?").bind(campaignId).all();
  return results.map((l) => ({ Timestamp: l.timestamp, CampaignID: l.campaign_id, DoctorID: l.doctor_id, MobileNumber: l.mobile_number, WaMessageId: l.wa_message_id, Status: l.status }));
}

async function logMessage(env, campaignId, doctorId, mobile, waMessageId, status) {
  await env.DB.prepare(
    "INSERT INTO logs (id, timestamp, campaign_id, doctor_id, mobile_number, wa_message_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(crypto.randomUUID(), new Date().toISOString(), campaignId, doctorId, mobile, waMessageId || "", status).run();
}

// ---------------------------------------------------------------
// WhatsApp Cloud API — sending (identical logic to Code.gs)
// ---------------------------------------------------------------

async function callWhatsAppApi(env, payload) {
  const phoneNumberId = env.WA_PHONE_NUMBER_ID;
  const accessToken = env.WA_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) throw new Error("WhatsApp credentials are not configured yet.");

  const res = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + accessToken },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    const errObj = data.error || {};
    let msg = errObj.message || "WhatsApp API error";
    if (errObj.error_data && errObj.error_data.details) msg += " — " + errObj.error_data.details;
    if (errObj.error_subcode) msg += " (subcode " + errObj.error_subcode + ")";
    throw new Error(msg);
  }
  return data.messages && data.messages[0] && data.messages[0].id;
}

/** Guesses image/video/document from a URL's extension (matches Code.gs's guessMediaTypeFromUrl_), so campaigns and inbox replies can send any attachment through the same field. */
function guessMediaTypeFromUrl(url) {
  const str = String(url || "");
  const hintMatch = str.match(/[?&]mc_ext=([a-zA-Z0-9]+)/);
  let ext = hintMatch ? hintMatch[1].toLowerCase() : "";
  if (!ext) {
    const pathMatch = str.split("?")[0].toLowerCase().match(/\.([a-z0-9]+)$/);
    ext = pathMatch ? pathMatch[1] : "";
  }
  if (/^(mp4|3gp|mov|m4v)$/.test(ext)) return "video";
  if (/^(pdf|docx?|xlsx?|pptx?)$/.test(ext)) return "document";
  return "image";
}

function renderTemplateBody(template, doctor) {
  return template
    .replace(/{{\s*doctor_name\s*}}/g, doctor.Name || "")
    .replace(/{{\s*specialty\s*}}/g, doctor.Specialty || "")
    .replace(/{{\s*hospital\s*}}/g, doctor.Hospital || "")
    .replace(/{{\s*city\s*}}/g, doctor.City || "");
}

function fieldValueForDoctor(fieldName, doctor) {
  const map = { doctor_name: doctor.Name, specialty: doctor.Specialty, hospital: doctor.Hospital, city: doctor.City };
  return map[fieldName] || "";
}

async function sendWhatsAppTemplateMessage(env, toNumber, templateName, languageCode, paramValues, paramNames, headerImageUrl) {
  const payload = {
    messaging_product: "whatsapp", to: toNumber, type: "template",
    template: { name: templateName, language: { code: languageCode || "ar" }, components: [] },
  };
  if (headerImageUrl) {
    const headerMediaType = guessMediaTypeFromUrl(headerImageUrl);
    const headerParam = { type: headerMediaType };
    headerParam[headerMediaType] = { link: headerImageUrl };
    payload.template.components.push({ type: "header", parameters: [headerParam] });
  }
  if (paramValues && paramValues.length) {
    payload.template.components.push({
      type: "body",
      parameters: paramValues.map((v, i) => {
        const param = { type: "text", text: v || "" };
        if (paramNames && paramNames[i]) param.parameter_name = paramNames[i];
        return param;
      }),
    });
  }
  if (payload.template.components.length === 0) delete payload.template.components;
  return callWhatsAppApi(env, payload);
}

/** replyToWaMessageId: when set, WhatsApp renders this as a true quoted reply
 * (the small "replying to ..." preview) on the recipient's own phone too —
 * not just in our UI. Needs the ORIGINAL message's WaMessageId (wamid), not
 * our internal row id. Only meaningful for messages still within the 24h
 * window / otherwise sendable — same rules as any other free-form message. */
async function sendWhatsAppMessage(env, toNumber, bodyText, mediaUrl, replyToWaMessageId) {
  const payload = { messaging_product: "whatsapp", to: toNumber, type: mediaUrl ? guessMediaTypeFromUrl(mediaUrl) : "text" };
  if (mediaUrl) payload[payload.type] = { link: mediaUrl, caption: bodyText };
  else payload.text = { body: bodyText };
  if (replyToWaMessageId) payload.context = { message_id: replyToWaMessageId };
  return callWhatsAppApi(env, payload);
}

/** Sends one campaign message and logs it into Inbox too (not just Logs), so every outbound message shows up in the unified chat view. No AgentUsername — this wasn't a customer-service reply, shouldn't count toward agent stats. */
async function sendOneCampaignMessage(env, campaign, doctor) {
  let waMessageId, body;
  if (campaign.MessageType === "template") {
    const paramFields = campaign.TemplateParams ? String(campaign.TemplateParams).split(",").map((s) => s.trim()).filter(Boolean) : [];
    const paramValues = paramFields.map((f) => fieldValueForDoctor(f, doctor));
    const paramNames = campaign.TemplateParamNames ? String(campaign.TemplateParamNames).split(",").map((s) => s.trim()).filter(Boolean) : null;
    waMessageId = await sendWhatsAppTemplateMessage(env, doctor.Mobile, campaign.TemplateName, campaign.TemplateLanguage, paramValues, paramNames, campaign.ImageUrl);
    body = "[قالب: " + campaign.TemplateName + "]" + (paramValues.length ? " — " + paramValues.join(" | ") : "");
  } else {
    body = renderTemplateBody(campaign.Message, doctor);
    waMessageId = await sendWhatsAppMessage(env, doctor.Mobile, body, campaign.ImageUrl);
  }
  try {
    await appendInboxRow(env, {
      MobileNumber: doctor.Mobile, CustomerID: doctor.ID || "", Direction: "out",
      Body: body, MediaUrl: campaign.ImageUrl || "", WaMessageId: waMessageId || "", Status: "sent",
    });
  } catch (err) { /* never let a logging hiccup fail the actual send */ }
  return waMessageId;
}

/** Cloudflare Workers have no 6-minute cap like Apps Script, but we still batch to respect WhatsApp rate limits and keep one call fast. */
const CAMPAIGN_BATCH_SIZE = 150;

async function sendCampaign(env, campaignId, options) {
  const row = await env.DB.prepare("SELECT * FROM campaigns WHERE id=?").bind(campaignId).first();
  if (!row) return { ok: false, error: "Campaign not found" };
  const campaign = rowToCampaign(row);
  if (campaign.Status === "Paused" && !(options && options.forceResume)) {
    return { ok: false, error: "Campaign is paused" };
  }

  const recipientIds = campaign.RecipientIds ? String(campaign.RecipientIds).split(",").map((s) => s.trim()).filter(Boolean) : null;
  const allDoctors = (await env.DB.prepare("SELECT * FROM doctors").all()).results.map(rowToDoctor);
  const doctors = allDoctors.filter((d) => (recipientIds && recipientIds.length ? recipientIds.includes(String(d.ID)) : d.Status === "Active"));

  const processedLogs = (await env.DB.prepare("SELECT doctor_id FROM logs WHERE campaign_id=?").bind(campaignId).all()).results;
  const alreadyProcessed = {};
  processedLogs.forEach((l) => { alreadyProcessed[String(l.doctor_id)] = true; });
  const remaining = doctors.filter((d) => !alreadyProcessed[String(d.ID)]);
  const batch = remaining.slice(0, CAMPAIGN_BATCH_SIZE);

  let sentNow = 0, failedNow = 0;
  for (const doctor of batch) {
    try {
      const waMessageId = await sendOneCampaignMessage(env, campaign, doctor);
      await logMessage(env, campaignId, doctor.ID, doctor.Mobile, waMessageId, "sent");
      sentNow++;
    } catch (err) {
      await logMessage(env, campaignId, doctor.ID, doctor.Mobile, "", "failed: " + err.message);
      failedNow++;
    }
  }

  const totalSent = Number(campaign.Sent || 0) + sentNow;
  const totalFailed = Number(campaign.Failed || 0) + failedNow;
  const stillRemaining = remaining.length - batch.length;
  const newStatus = stillRemaining > 0 ? "Sending" : "Completed";

  await campaignsUpdate(env, campaignId, { Status: newStatus, Sent: totalSent, Failed: totalFailed });
  return { ok: true, sent: totalSent, failed: totalFailed, remaining: stillRemaining, status: newStatus };
}

async function retryFailedMessages(env, campaignId) {
  const failedLogs = (await env.DB.prepare("SELECT * FROM logs WHERE campaign_id=? AND status LIKE 'failed%'").bind(campaignId).all()).results;
  const row = await env.DB.prepare("SELECT * FROM campaigns WHERE id=?").bind(campaignId).first();
  const campaign = row ? rowToCampaign(row) : null;
  const allDoctors = (await env.DB.prepare("SELECT * FROM doctors").all()).results.map(rowToDoctor);
  let retried = 0;

  for (const log of failedLogs) {
    const doctor = allDoctors.find((d) => String(d.ID) === String(log.doctor_id));
    if (!doctor || !campaign) continue;
    try {
      const waMessageId = await sendOneCampaignMessage(env, campaign, doctor);
      await logMessage(env, campaignId, doctor.ID, doctor.Mobile, waMessageId, "sent");
      retried++;
    } catch (err) {
      await logMessage(env, campaignId, doctor.ID, doctor.Mobile, "", "failed: " + err.message);
    }
  }
  return { ok: true, retried };
}

// ---------------------------------------------------------------
// Webhook — delivery/read/failed status updates from Meta (incoming
// customer messages / Inbox come in the next phase)
// ---------------------------------------------------------------

async function handleWebhookStatuses(env, statuses) {
  for (const s of statuses) {
    let statusText = s.status;
    if (s.errors && s.errors.length) {
      const e = s.errors[0];
      let detail = e.title || e.message || "Delivery failed";
      if (e.error_data && e.error_data.details) detail += " — " + e.error_data.details;
      statusText = s.status + ": (#" + e.code + ") " + detail;
    }
    await env.DB.prepare("UPDATE logs SET status=? WHERE wa_message_id=?").bind(statusText, s.id).run();
  }
}

async function handleWebhookEvent(env, payload, workerOrigin) {
  try {
    const entry = payload.entry && payload.entry[0];
    const changes = (entry && entry.changes) || [];
    for (const change of changes) {
      const value = change.value || {};
      if (value.statuses) await handleWebhookStatuses(env, value.statuses);
      if (value.messages) await handleWebhookMessages(env, value.messages, workerOrigin);
    }
  } catch (err) {
    // Swallow — webhook delivery should never throw back to Meta.
  }
}

// ---------------------------------------------------------------
// Scheduling — runs every 10 minutes (set in wrangler.toml [triggers]),
// same role as Code.gs's processScheduledCampaigns_ time-driven trigger:
// resumes any campaign still "Sending" (large list, multiple batches)
// and fires off any "Scheduled" campaign whose time has arrived.
// ---------------------------------------------------------------

async function processScheduledCampaigns(env) {
  const { results } = await env.DB.prepare("SELECT * FROM campaigns").all();
  const now = Date.now();
  for (const row of results) {
    const c = rowToCampaign(row);
    if (c.Status === "Sending") {
      try { await sendCampaign(env, c.ID); } catch (err) { /* retried again next run */ }
      continue;
    }
    if (c.Status !== "Scheduled" || !c.ScheduledAt) continue;
    if (new Date(c.ScheduledAt).getTime() <= now) {
      try {
        await sendCampaign(env, c.ID);
      } catch (err) {
        await campaignsUpdate(env, c.ID, { Status: "Failed" });
      }
    }
  }
}

// ---------------------------------------------------------------
// Inbox — core row helpers
// ---------------------------------------------------------------

function rowToInbox(r) {
  return {
    Id: r.id, Timestamp: r.timestamp, MobileNumber: r.mobile_number, CustomerID: r.customer_id,
    Direction: r.direction, Body: r.body, MediaUrl: r.media_url, WaMessageId: r.wa_message_id,
    Status: r.status, AgentUsername: r.agent_username, ReplyToId: r.reply_to_id || "",
  };
}

/** Returns the generated row id, so a caller (e.g. sendInboxReply) can hand
 * it back to the browser for its own optimistic bubble / later reply-target. */
async function appendInboxRow(env, data) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO inbox (id, timestamp, mobile_number, customer_id, direction, body, media_url, wa_message_id, status, agent_username, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    id, data.Timestamp || new Date().toISOString(), data.MobileNumber || "", data.CustomerID || "",
    data.Direction || "", data.Body || "", data.MediaUrl || "", data.WaMessageId || "", data.Status || "", data.AgentUsername || "",
    data.ReplyToId || ""
  ).run();
  return id;
}

function normalizeMobile(mobile) {
  return String(mobile || "").replace(/[^0-9]/g, "");
}

async function findDoctorByMobile(env, mobile) {
  const target = normalizeMobile(mobile);
  const { results } = await env.DB.prepare("SELECT * FROM doctors").all();
  const doctor = results.map(rowToDoctor).find((d) => normalizeMobile(d.Mobile) === target);
  return doctor || null;
}

/** One row per conversation (most recent message per mobile), newest first — a single indexed-enough D1 query, no sheet-scan caching needed. */
async function buildInboxConversationsBase(env) {
  const { results } = await env.DB.prepare(
    `SELECT i.mobile_number, i.body AS last_message, i.status AS last_status, i.direction AS last_direction, i.timestamp AS last_timestamp
     FROM inbox i
     INNER JOIN (SELECT mobile_number, MAX(timestamp) AS max_ts FROM inbox GROUP BY mobile_number) latest
       ON i.mobile_number = latest.mobile_number AND i.timestamp = latest.max_ts`
  ).all();
  const doctors = (await env.DB.prepare("SELECT * FROM doctors").all()).results.map(rowToDoctor);
  const doctorByMobile = {};
  doctors.forEach((d) => { doctorByMobile[normalizeMobile(d.Mobile)] = d; });

  return results.map((r) => {
    const doctor = doctorByMobile[normalizeMobile(r.mobile_number)];
    return {
      MobileNumber: r.mobile_number, CustomerName: doctor ? doctor.Name : "",
      LastMessage: r.last_message, LastStatus: r.last_status, LastDirection: r.last_direction, LastTimestamp: r.last_timestamp,
    };
  });
}

async function getThreadRows(env, mobile) {
  const target = String(mobile || "").trim();
  if (!target) return [];
  const { results } = await env.DB.prepare("SELECT * FROM inbox WHERE mobile_number=? ORDER BY timestamp ASC").bind(target).all();
  return results.map(rowToInbox);
}

async function getReadStateMap(env) {
  const { results } = await env.DB.prepare("SELECT * FROM inbox_read_state").all();
  const map = {};
  results.forEach((r) => { map[String(r.mobile_number).trim()] = { LastReadTimestamp: r.last_read_timestamp, LastReadBy: r.last_read_by }; });
  return map;
}

async function markConversationRead(env, mobile, timestamp, username) {
  const readAt = timestamp || new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO inbox_read_state (mobile_number, last_read_timestamp, last_read_by) VALUES (?, ?, ?) ON CONFLICT(mobile_number) DO UPDATE SET last_read_timestamp=excluded.last_read_timestamp, last_read_by=excluded.last_read_by"
  ).bind(String(mobile).trim(), readAt, username || "").run();
  return readAt;
}

async function getPinnedMobilesForUser(env, username) {
  if (!username) return {};
  const { results } = await env.DB.prepare("SELECT mobile_number, pinned_at FROM pinned_conversations WHERE username=?").bind(username).all();
  const map = {};
  results.forEach((r) => { map[String(r.mobile_number).trim()] = r.pinned_at; });
  return map;
}

async function pinConversation(env, username, mobile) {
  const mobileClean = String(mobile || "").trim();
  if (!mobileClean || !username) return { ok: false, error: "Missing mobile or user." };
  await env.DB.prepare(
    "INSERT INTO pinned_conversations (username, mobile_number, pinned_at) VALUES (?, ?, ?) ON CONFLICT(username, mobile_number) DO NOTHING"
  ).bind(username, mobileClean, new Date().toISOString()).run();
  return { ok: true };
}

async function unpinConversation(env, username, mobile) {
  await env.DB.prepare("DELETE FROM pinned_conversations WHERE username=? AND mobile_number=?").bind(username, String(mobile || "").trim()).run();
  return { ok: true };
}

async function buildInboxConversations(env, currentUsername) {
  const base = await buildInboxConversationsBase(env);
  const readByMobile = await getReadStateMap(env);
  const pinnedMobiles = await getPinnedMobilesForUser(env, currentUsername);
  return base.map((c) => {
    const readState = readByMobile[c.MobileNumber];
    return {
      MobileNumber: c.MobileNumber, CustomerName: c.CustomerName, LastMessage: c.LastMessage,
      LastStatus: c.LastStatus, LastDirection: c.LastDirection, LastTimestamp: c.LastTimestamp,
      LastReadTimestamp: readState ? readState.LastReadTimestamp : "", LastReadBy: readState ? readState.LastReadBy : "",
      Pinned: !!pinnedMobiles[c.MobileNumber], PinnedAt: pinnedMobiles[c.MobileNumber] || "",
    };
  }).sort((a, b) => new Date(b.LastTimestamp) - new Date(a.LastTimestamp));
}

/** Case-insensitive substring search across every message body, newest 50. */
async function searchInboxMessages(env, query) {
  const q = String(query || "").trim();
  if (q.length < 2) return [];
  const { results } = await env.DB.prepare(
    "SELECT * FROM inbox WHERE body LIKE ? COLLATE NOCASE ORDER BY timestamp DESC LIMIT 50"
  ).bind("%" + q + "%").all();
  const doctors = (await env.DB.prepare("SELECT * FROM doctors").all()).results.map(rowToDoctor);
  const doctorByMobile = {};
  doctors.forEach((d) => { doctorByMobile[normalizeMobile(d.Mobile)] = d; });
  return results.map((r) => {
    const mobile = String(r.mobile_number).trim();
    const doctor = doctorByMobile[normalizeMobile(mobile)];
    return { Id: r.id, MobileNumber: mobile, CustomerName: doctor ? doctor.Name : "", Body: r.body, Timestamp: r.timestamp, Direction: r.direction };
  });
}

// ---------------------------------------------------------------
// Sending from the Inbox chat
// ---------------------------------------------------------------

async function sendInboxReply(env, mobile, body, agentUsername, replyToId, replyToWaMessageId) {
  const waMessageId = await sendWhatsAppMessage(env, mobile, body, null, replyToWaMessageId);
  const doctor = await findDoctorByMobile(env, mobile);
  const id = await appendInboxRow(env, {
    MobileNumber: mobile, CustomerID: doctor ? doctor.ID : "", Direction: "out",
    Body: body, WaMessageId: waMessageId || "", Status: "sent", AgentUsername: agentUsername || "",
    ReplyToId: replyToId || "",
  });
  await markConversationRead(env, mobile, new Date().toISOString(), agentUsername);
  return { ok: true, id };
}

async function sendInboxMedia(env, mobile, mediaUrl, mediaType, caption, filename, agentUsername) {
  const resolvedType = mediaType === "document" ? "document" : guessMediaTypeFromUrl(mediaUrl);
  const payload = { messaging_product: "whatsapp", to: mobile, type: resolvedType };
  if (resolvedType === "document") payload.document = { link: mediaUrl, caption: caption || "", filename: filename || "file" };
  else payload[resolvedType] = { link: mediaUrl, caption: caption || "" };
  const waMessageId = await callWhatsAppApi(env, payload);

  const doctor = await findDoctorByMobile(env, mobile);
  await appendInboxRow(env, {
    MobileNumber: mobile, CustomerID: doctor ? doctor.ID : "", Direction: "out",
    Body: caption || (mediaType === "document" ? "[document]" : "[image]"), MediaUrl: mediaUrl,
    WaMessageId: waMessageId || "", Status: "sent", AgentUsername: agentUsername || "",
  });
  await markConversationRead(env, mobile, new Date().toISOString(), agentUsername);
  return { ok: true };
}

// ---------------------------------------------------------------
// New-conversation quick-send buttons — fixed pre-approved templates
// (no variables), same three as the live system.
// ---------------------------------------------------------------

const NEW_CONVERSATION_TEMPLATE_NAME = "new_message";
const NEW_CONVERSATION_TEMPLATE_LANG = "ar_EG";
const NEW_CONVERSATION_TEMPLATE_BODY = "الرجاء التواصل مع مجمع المدلوح للاهمية؛\n\nبيانات التواصل / هاتفيا او عبر واتس اب من خلال الرقم الموحد:\n920014603";

const QR_SEHA_TEMPLATE_NAME = "qr_seha";
const QR_SEHA_TEMPLATE_LANG = "ar_EG";
const QR_SEHA_IMAGE_URL = "https://raw.githubusercontent.com/ahmedkhalil1587/whatsapp-campaign/main/assets/img/QR_seha.jpg";
const QR_SEHA_TEMPLATE_BODY = "مرفق QR للستجيل لرفع الاجازات المرضية على منصة صحتي\n\nللمزيد من الاستفسارات تواصل هاتفيا او واتس اب على الرقم الموحد:\n920014603";

const REPORT_REQ_TEMPLATE_NAME = "report_req";
const REPORT_REQ_TEMPLATE_LANG = "ar_EG";
const REPORT_REQ_TEMPLATE_BODY = "🖨️ لطلب ارسال التقارير الطبية أو الاجازات المرضية؛\nالرجاء ارسال:\n1- التقرير المطلوب (اجازة مرضية/تقريرطبي/نتيجة مختبر او اشعه)\n2- رقم الهوية/الاقامة\n3- رقم الجوال المسجل داخل ملفك الطبي بمجمع المدلوح\nوشكرا 🌹\nلمزيد من المعلومات تواصل معنا عبر الواتس اب او الهاتف على الرقم الموحد:\n📞 920014603";

async function sendFixedTemplateConversation(env, mobile, agentUsername, templateName, templateLang, bodyText, headerImageUrl) {
  const cleanMobile = normalizeMobile(mobile);
  if (!cleanMobile) return { ok: false, error: "رقم الجوال غير صالح." };
  const waMessageId = await sendWhatsAppTemplateMessage(env, cleanMobile, templateName, templateLang, [], null, headerImageUrl || "");
  const doctor = await findDoctorByMobile(env, cleanMobile);
  await appendInboxRow(env, {
    MobileNumber: cleanMobile, CustomerID: doctor ? doctor.ID : "", Direction: "out",
    Body: bodyText, MediaUrl: headerImageUrl || "", WaMessageId: waMessageId || "", Status: "sent", AgentUsername: agentUsername || "",
  });
  await markConversationRead(env, cleanMobile, new Date().toISOString(), agentUsername);
  return { ok: true, mobile: cleanMobile };
}

const startNewConversation = (env, mobile, agentUsername) =>
  sendFixedTemplateConversation(env, mobile, agentUsername, NEW_CONVERSATION_TEMPLATE_NAME, NEW_CONVERSATION_TEMPLATE_LANG, NEW_CONVERSATION_TEMPLATE_BODY, "");
const sendQrSehaConversation = (env, mobile, agentUsername) =>
  sendFixedTemplateConversation(env, mobile, agentUsername, QR_SEHA_TEMPLATE_NAME, QR_SEHA_TEMPLATE_LANG, QR_SEHA_TEMPLATE_BODY, QR_SEHA_IMAGE_URL);
const sendReportRequestConversation = (env, mobile, agentUsername) =>
  sendFixedTemplateConversation(env, mobile, agentUsername, REPORT_REQ_TEMPLATE_NAME, REPORT_REQ_TEMPLATE_LANG, REPORT_REQ_TEMPLATE_BODY, "");

// ---------------------------------------------------------------
// Incoming media from customers — stored in R2 (binding env.MEDIA),
// served back through this same Worker at /media/<key> (replaces
// Google Drive's role in Code.gs's fetchAndStoreIncomingMedia_).
// ---------------------------------------------------------------

const MEDIA_EXT_BY_MIME = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/3gpp": "3gp",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/amr": "amr",
  "application/pdf": "pdf",
};

async function fetchAndStoreIncomingMedia(env, mediaId, mimeType, workerOrigin) {
  const accessToken = env.WA_ACCESS_TOKEN;
  if (!accessToken || !env.MEDIA) return "";

  const metaResp = await fetch("https://graph.facebook.com/v20.0/" + mediaId, { headers: { Authorization: "Bearer " + accessToken } });
  const meta = await metaResp.json().catch(() => ({}));
  if (!meta.url) return "";

  const fileResp = await fetch(meta.url, { headers: { Authorization: "Bearer " + accessToken } });
  if (!fileResp.ok) return "";

  const ext = MEDIA_EXT_BY_MIME[mimeType || meta.mime_type] || "";
  const key = mediaId + (ext ? "." + ext : "");
  await env.MEDIA.put(key, fileResp.body, { httpMetadata: { contentType: mimeType || meta.mime_type || "application/octet-stream" } });
  return workerOrigin + "/media/" + key;
}

async function handleWebhookMessages(env, messages, workerOrigin) {
  for (const m of messages) {
    const mobile = String(m.from || "").trim();
    let body = "", mediaUrl = "", status = "received";

    if (m.type === "reaction") {
      const emoji = m.reaction && m.reaction.emoji;
      if (!emoji) continue; // "" means a reaction was removed — not worth logging
      body = emoji;
      status = "reaction";
    } else if (m.type === "text" && m.text) {
      body = m.text.body;
    } else if (m.type) {
      body = "[" + m.type + "]";
      const mediaObj = m[m.type];
      if (mediaObj && mediaObj.id) {
        try { mediaUrl = await fetchAndStoreIncomingMedia(env, mediaObj.id, mediaObj.mime_type, workerOrigin); } catch (err) { /* logged without the attachment this once */ }
        if (mediaObj.caption) body = mediaObj.caption;
      }
    }

    const doctor = await findDoctorByMobile(env, mobile);
    await appendInboxRow(env, {
      Timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString(),
      MobileNumber: mobile, CustomerID: doctor ? doctor.ID : "", Direction: "in",
      Body: body, MediaUrl: mediaUrl, WaMessageId: m.id || "", Status: status,
    });
  }
}

async function mediaUpload(env, filename, mimeType, base64) {
  if (!filename || !base64 || !env.MEDIA) throw new Error("Missing file data, or R2 isn't bound yet.");
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const extMatch = String(filename).match(/\.([a-zA-Z0-9]+)$/);
  const key = crypto.randomUUID() + (extMatch ? "." + extMatch[1].toLowerCase() : "");
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: mimeType || "application/octet-stream" } });
  return { ok: true, url: "__ORIGIN__/media/" + key, fileId: key, name: filename };
}

// ---------------------------------------------------------------
// Dashboard / history / agent stats
// ---------------------------------------------------------------

async function buildHistoryRows(env) {
  const logs = (await env.DB.prepare("SELECT * FROM logs ORDER BY timestamp DESC").all()).results;
  const campaigns = (await env.DB.prepare("SELECT * FROM campaigns").all()).results.map(rowToCampaign);
  const doctors = (await env.DB.prepare("SELECT * FROM doctors").all()).results.map(rowToDoctor);
  const campaignById = {}; campaigns.forEach((c) => { campaignById[c.ID] = c; });
  const doctorById = {}; doctors.forEach((d) => { doctorById[d.ID] = d; });
  return logs.map((l) => {
    const campaign = campaignById[l.campaign_id];
    const doctor = doctorById[l.doctor_id];
    return {
      Timestamp: l.timestamp, CampaignID: l.campaign_id, CampaignName: campaign ? campaign.Name : "",
      DoctorID: l.doctor_id, CustomerName: doctor ? doctor.Name : "", MobileNumber: l.mobile_number, Status: l.status,
    };
  });
}

/** Per-agent reply activity from Inbox's AgentUsername column. */
async function buildAgentStats(env) {
  const rows = (await env.DB.prepare("SELECT timestamp, direction, agent_username FROM inbox WHERE direction='out' AND agent_username != ''").all()).results;
  const todayStr = new Date().toDateString();
  const byAgent = {};
  rows.forEach((r) => {
    const name = String(r.agent_username).trim();
    if (!name) return;
    if (!byAgent[name]) byAgent[name] = { username: name, totalReplies: 0, repliesToday: 0, lastReplyAt: "" };
    byAgent[name].totalReplies++;
    const ts = r.timestamp ? new Date(r.timestamp) : null;
    if (ts && ts.toDateString() === todayStr) byAgent[name].repliesToday++;
    if (ts && (!byAgent[name].lastReplyAt || ts > new Date(byAgent[name].lastReplyAt))) byAgent[name].lastReplyAt = r.timestamp;
  });
  return Object.values(byAgent).sort((a, b) => b.totalReplies - a.totalReplies);
}

/** Per-agent reply stats within an inclusive date range, plus each agent's % of total outbound replies — percentage based on DISTINCT CUSTOMERS replied to, so it can never exceed 100%. */
async function buildAgentStatsRange(env, startDate, endDate) {
  const rows = (await env.DB.prepare("SELECT * FROM inbox").all()).results;
  const start = startDate ? new Date(startDate + "T00:00:00") : null;
  const end = endDate ? new Date(endDate + "T23:59:59") : null;

  const inRange = rows.filter((r) => {
    if (!r.timestamp) return false;
    const ts = new Date(r.timestamp);
    if (start && ts < start) return false;
    if (end && ts > end) return false;
    return true;
  });

  const totalOutbound = inRange.filter((r) => r.direction === "out").length;

  const inboundCustomers = {};
  inRange.forEach((r) => { if (r.direction !== "out" && r.status !== "reaction") inboundCustomers[String(r.mobile_number).trim()] = true; });
  const totalInbound = Object.keys(inboundCustomers).length;

  const byAgent = {};
  inRange.forEach((r) => {
    if (r.direction !== "out" || !r.agent_username) return;
    const name = String(r.agent_username).trim();
    if (!name) return;
    if (!byAgent[name]) byAgent[name] = { username: name, replies: 0, customers: {} };
    byAgent[name].replies++;
    const mobile = String(r.mobile_number).trim();
    if (inboundCustomers[mobile]) byAgent[name].customers[mobile] = true;
  });

  const result = Object.values(byAgent).map((a) => {
    const customersReplied = Object.keys(a.customers).length;
    return {
      username: a.username, replies: a.replies, customersReplied,
      percentage: totalInbound > 0 ? Math.round((customersReplied / totalInbound) * 1000) / 10 : 0,
    };
  }).sort((a, b) => b.replies - a.replies);

  const repliedCustomersOverall = {};
  Object.values(byAgent).forEach((a) => Object.keys(a.customers).forEach((m) => { repliedCustomersOverall[m] = true; }));
  const coveredCount = Object.keys(repliedCustomersOverall).length;

  return {
    rows: result, totalOutbound, totalInbound,
    coveragePercentage: totalInbound > 0 ? Math.round((coveredCount / totalInbound) * 1000) / 10 : 0,
    rangeStart: startDate || "", rangeEnd: endDate || "",
  };
}

async function buildDashboardStats(env) {
  const doctors = (await env.DB.prepare("SELECT * FROM doctors").all()).results;
  const campaigns = await campaignsList(env);
  let sent = 0, delivered = 0, read = 0, failed = 0;
  campaigns.forEach((c) => { sent += Number(c.Sent || 0); delivered += Number(c.Delivered || 0); read += Number(c.Read || 0); failed += Number(c.Failed || 0); });
  const recent = campaigns.slice(-5).reverse().map((c) => ({ name: c.Name, date: c.CreatedAt, recipients: Number(c.Sent || 0), delivered: Number(c.Delivered || 0), status: c.Status || "draft" }));
  return {
    totalDoctors: doctors.length, totalCampaigns: campaigns.length,
    messagesSent: sent, delivered, read, failed,
    performance: { labels: recent.map((_, i) => "C" + (i + 1)), sent: recent.map((r) => r.recipients), delivered: recent.map((r) => r.delivered) },
    recent, agentStats: await buildAgentStats(env),
  };
}

// ---------------------------------------------------------------
// Settings — phoneNumberId/businessId/webhookVerifyToken are read from
// env (set via `wrangler secret put`), same contract as before, minus
// the ability to save them from the browser (secrets can't be written
// at runtime — use `wrangler secret put <NAME>` from the CLI instead).
// ---------------------------------------------------------------

function getPublicSettings(env) {
  return {
    phoneNumberId: env.WA_PHONE_NUMBER_ID || "",
    businessId: env.WA_BUSINESS_ID || "",
    webhookVerifyToken: env.WA_WEBHOOK_VERIFY_TOKEN || "",
    hasAccessToken: !!env.WA_ACCESS_TOKEN,
  };
}

// ---------------------------------------------------------------
// Auto-delete old conversations + expired sessions — runs once daily
// (guarded inside the cron handler below), same 7-day cutoff as Code.gs.
// ---------------------------------------------------------------

const INBOX_DELETE_AFTER_DAYS = 7;

async function cleanupExpiredSessions(env) {
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(new Date().toISOString()).run();
}

async function deleteOldConversations(env) {
  await cleanupExpiredSessions(env);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - INBOX_DELETE_AFTER_DAYS);
  const result = await env.DB.prepare(
    `DELETE FROM inbox WHERE mobile_number IN (
       SELECT mobile_number FROM inbox GROUP BY mobile_number HAVING MAX(timestamp) < ?
     )`
  ).bind(cutoff.toISOString()).run();
  return { deleted: result.meta.changes || 0 };
}

// ---------------------------------------------------------------
// Self-registration with admin approval + email verification code
// (emails sent via Resend — env.RESEND_API_KEY / SENDER_EMAIL /
// SENDER_NAME / ADMIN_EMAIL, set with `wrangler secret put`)
// ---------------------------------------------------------------

async function sendResendEmail(env, to, subject, text) {
  if (!env.RESEND_API_KEY) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: (env.SENDER_NAME || "MedConnect") + " <" + env.SENDER_EMAIL + ">",
        to: [to], subject, text,
      }),
    });
    return res.ok;
  } catch (err) {
    return false;
  }
}

function rowToSignup(r) {
  return { ID: r.id, Timestamp: r.timestamp, Name: r.name, Email: r.email, PasswordHash: r.password_hash, Status: r.status, VerificationCode: r.verification_code, Role: r.role };
}

async function registerSignup(env, name, email, password) {
  if (!name || !email || !password) return { ok: false, error: "Missing name, email, or password." };
  const existing = await env.DB.prepare("SELECT id FROM signups WHERE lower(email)=lower(?) AND status != 'rejected'").bind(email).first();
  if (existing) return { ok: false, error: "A request for this email already exists." };

  const passwordHash = await sha256Hex(password);
  await env.DB.prepare(
    "INSERT INTO signups (id, timestamp, name, email, password_hash, status, verification_code, role) VALUES (?, ?, ?, ?, ?, 'pending', '', '')"
  ).bind(crypto.randomUUID(), new Date().toISOString(), name, email, passwordHash).run();

  if (env.ADMIN_EMAIL) {
    await sendResendEmail(env, env.ADMIN_EMAIL, "طلب تسجيل جديد — نظام الواتساب",
      "يوجد طلب تسجيل جديد بانتظار الموافقة:\n\nالاسم: " + name + "\nالبريد الإلكتروني: " + email);
  }
  return { ok: true };
}

/** Admin-only (enforced by omission from AGENT_ALLOWED_ACTIONS). Pending + approved-but-not-yet-verified. */
async function listSignups(env) {
  const { results } = await env.DB.prepare("SELECT * FROM signups WHERE status IN ('pending','approved')").all();
  return results.map(rowToSignup);
}

async function approveSignup(env, id, role) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const resolvedRole = role === "admin" ? "admin" : "agent";
  await env.DB.prepare("UPDATE signups SET status='approved', verification_code=?, role=? WHERE id=?").bind(code, resolvedRole, id).run();
  const row = await env.DB.prepare("SELECT * FROM signups WHERE id=?").bind(id).first();
  if (!row) return { ok: false, error: "Signup not found" };
  await sendResendEmail(env, row.email, "تم قبول طلب تسجيلك — كود التفعيل",
    "مرحبًا " + row.name + "،\n\nتم قبول طلب تسجيلك في MedConnect Campaigns.\n\nكود التفعيل بتاعك هو: " + code + "\n\nادخل على صفحة تفعيل الحساب وحط الكود ده مع إيميلك عشان تكمل التسجيل.");
  return { ok: true };
}

async function rejectSignup(env, id) {
  await env.DB.prepare("UPDATE signups SET status='rejected' WHERE id=?").bind(id).run();
  return { ok: true };
}

/** Final step: the user enters the emailed code, which creates their row in Users. */
async function verifySignup(env, email, code) {
  const match = await env.DB.prepare(
    "SELECT * FROM signups WHERE lower(email)=lower(?) AND status='approved' AND verification_code=?"
  ).bind(email, String(code)).first();
  if (!match) return { ok: false, error: "Invalid code, or this request hasn't been approved yet." };

  await env.DB.prepare("INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)")
    .bind(match.email, match.password_hash, match.name, match.role).run();
  await env.DB.prepare("UPDATE signups SET status='completed' WHERE id=?").bind(match.id).run();
  return { ok: true };
}
