/**
 * MedConnect Campaigns — Google Apps Script Backend
 * ---------------------------------------------------------------
 * Deploy this as a Web App (Extensions > Apps Script in your
 * Google Sheet). See backend/README.md for full setup steps.
 *
 * Sheet tabs expected (create with these exact names/headers):
 *   Doctors    : ID | Name | Mobile | Specialty | Hospital | City | Country | Status | Notes
 *   Campaigns  : ID | Name | Message | ImageUrl | PdfUrl | Status | ScheduledAt | CreatedAt | Sent | Delivered | Read | Failed | RecipientIds | MessageType | TemplateName | TemplateLanguage | TemplateParams | TemplateParamNames
 *   Templates  : ID | Name | Body
 *   Logs       : Timestamp | CampaignID | DoctorID | MobileNumber | WaMessageId | Status
 *   Inbox      : Timestamp | MobileNumber | CustomerID | Direction | Body | MediaUrl | WaMessageId | Status | AgentUsername
 *   InboxReadState : MobileNumber | LastReadTimestamp | LastReadBy
 *   PinnedConversations : Username | MobileNumber | PinnedAt
 *   Signups    : ID | Timestamp | Name | Email | PasswordHash | Status | VerificationCode | Role
 *   Users      : Username | Password | Name | Role
 *
 * Secrets (Phone Number ID, Access Token, etc.) are NEVER stored in the
 * sheet or sent to the browser — they live in Script Properties only.
 * Set them once via Project Settings > Script properties, or run
 * saveSecretsFromSettingsPage_() through the Settings screen (todo).
 */

// ---------------------------------------------------------------
// Router
// ---------------------------------------------------------------

function doGet(e) {
  // Meta verification handshake: ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
  if (e.parameter["hub.mode"] === "subscribe") {
    var props = PropertiesService.getScriptProperties();
    var expected = props.getProperty("WA_WEBHOOK_VERIFY_TOKEN");
    if (e.parameter["hub.verify_token"] === expected) {
      return ContentService.createTextOutput(e.parameter["hub.challenge"]);
    }
    return ContentService.createTextOutput("Verification failed");
  }
  return handleRequest_(e);
}

function doPost(e) {
  // Meta sends delivery/read/failed status updates AND incoming customer
  // messages without our "action" field — route those to the webhook
  // handler instead of the app router.
  if (e.postData && e.postData.contents) {
    try {
      var maybePayload = JSON.parse(e.postData.contents);
      if (maybePayload.object === "whatsapp_business_account") {
        handleWebhookEvent_(maybePayload);
        return ContentService.createTextOutput(JSON.stringify({ ok: true }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    } catch (err) {
      // Not JSON, or not a webhook payload — fall through to the normal router.
    }
  }
  return handleRequest_(e);
}

function handleRequest_(e) {
  var result;
  try {
    var body = {};
    if (e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    } else if (e.parameter) {
      body = e.parameter;
    }
    var action = body.action;
    result = routeAction_(action, body);
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------
// Session-based authorization
// ---------------------------------------------------------------
// Real server-side protection: every action except the ones below needs
// a valid token (issued at login, in CacheService — auto-expires, and
// slides forward on activity). Non-admin roles are further restricted
// to an explicit allow-list, so e.g. a "agent" user calling
// "settings.save" directly (from a browser console) is rejected here,
// not just hidden in the UI.

var PUBLIC_ACTIONS_ = ["auth.login", "auth.register", "auth.verify"];
var AGENT_ALLOWED_ACTIONS_ = ["doctors.list", "doctors.create", "doctors.update", "doctors.delete", "doctors.bulkImport", "inbox.list", "inbox.thread", "inbox.send", "inbox.sendMedia", "inbox.markRead", "inbox.startNewConversation", "inbox.sendQrSeha", "inbox.sendReportRequest", "inbox.pin", "inbox.unpin", "inbox.search", "media.upload"];
var SESSION_TTL_SECONDS_ = 21600; // 6 hours; slides forward on each authorized request

function generateToken_(username, role) {
  var token = Utilities.getUuid();
  CacheService.getScriptCache().put("sess_" + token, JSON.stringify({ username: username, role: role }), SESSION_TTL_SECONDS_);
  return token;
}

function validateToken_(token) {
  if (!token) return null;
  var cache = CacheService.getScriptCache();
  var raw = cache.get("sess_" + token);
  if (!raw) return null;
  cache.put("sess_" + token, raw, SESSION_TTL_SECONDS_); // slide the expiration window
  return JSON.parse(raw);
}

function routeAction_(action, body) {
  var session = null;
  if (PUBLIC_ACTIONS_.indexOf(action) === -1) {
    session = validateToken_(body.token);
    if (!session) return { ok: false, error: "Session expired. Please log in again." };
    if (session.role !== "admin" && AGENT_ALLOWED_ACTIONS_.indexOf(action) === -1) {
      return { ok: false, error: "You don't have permission for this action." };
    }
  }

  switch (action) {
    case "auth.login":        return authLogin_(body.username, body.password);
    case "auth.register":     return registerSignup_(body.name, body.email, body.password);
    case "auth.verify":       return verifySignup_(body.email, body.code);

    case "signups.list":      return { ok: true, rows: listSignups_() };
    case "signups.approve":   return approveSignup_(body.id, body.role);
    case "signups.reject":    return rejectSignup_(body.id);

    case "doctors.list":      return { ok: true, rows: sheetToObjects_("Doctors") };
    case "doctors.create":    return { ok: true, row: appendRow_("Doctors", body.doctor) };
    case "doctors.update":    return { ok: true, row: updateRow_("Doctors", body.id, body.doctor) };
    case "doctors.delete":    return { ok: true, deleted: deleteRow_("Doctors", body.id) };
    case "doctors.bulkImport":return { ok: true, count: bulkImport_("Doctors", body.rows) };

    case "campaigns.list":    return { ok: true, rows: mergeLiveCampaignStats_(sheetToObjects_("Campaigns")) };
    case "campaigns.create":  return { ok: true, row: appendRow_("Campaigns", body.campaign) };
    case "campaigns.send":    return sendCampaign_(body.id);
    case "campaigns.retryFailed": return retryFailedMessages_(body.id);
    case "campaigns.logs":     return { ok: true, rows: sheetToObjects_("Logs").filter(function (l) { return String(l.CampaignID) === String(body.id); }) };
    case "campaigns.pause":    return { ok: true, row: updateRow_("Campaigns", body.id, { Status: "Paused" }) };
    case "campaigns.resume":   return sendCampaign_(body.id, { forceResume: true });

    case "templates.list":    return { ok: true, rows: sheetToObjects_("Templates") };
    case "templates.create":  return { ok: true, row: appendRow_("Templates", body.template) };
    case "templates.update":  return { ok: true, row: updateRow_("Templates", body.id, body.template) };
    case "templates.delete":  return { ok: true, deleted: deleteRow_("Templates", body.id) };

    case "media.upload":      return uploadMedia_(body.filename, body.mimeType, body.base64);

    case "dashboard.stats":   return { ok: true, stats: buildDashboardStats_() };

    case "history.list":      return { ok: true, rows: buildHistoryRows_() };

    case "inbox.list":        return { ok: true, rows: buildInboxConversations_(session.username) };
    case "inbox.thread":      return { ok: true, rows: sheetToObjects_("Inbox").filter(function (r) { return String(r.MobileNumber).trim() === String(body.mobile).trim(); }).sort(function (a, b) { return new Date(a.Timestamp) - new Date(b.Timestamp); }) };
    case "inbox.send":        return sendInboxReply_(body.mobile, body.text, session.username);
    case "inbox.sendMedia":    return sendInboxMedia_(body.mobile, body.mediaUrl, body.mediaType, body.caption, body.filename, session.username);
    case "inbox.markRead":    return { ok: true, readAt: markConversationRead_(body.mobile, body.timestamp, session.username) };
    case "inbox.startNewConversation": return startNewConversation_(body.mobile, session.username);
    case "inbox.sendQrSeha": return sendQrSehaConversation_(body.mobile, session.username);
    case "inbox.sendReportRequest": return sendReportRequestConversation_(body.mobile, session.username);
    case "inbox.pin":         return pinConversation_(session.username, body.mobile);
    case "inbox.unpin":       return unpinConversation_(session.username, body.mobile);
    case "inbox.search":      return { ok: true, rows: searchInboxMessages_(body.query) };

    // Admin-only (not in AGENT_ALLOWED_ACTIONS_ — this is for evaluating agents, not for agents themselves).
    case "inbox.agentStatsRange": return { ok: true, stats: buildAgentStatsRange_(body.startDate, body.endDate) };

    case "settings.get":      return { ok: true, settings: getPublicSettings_() };
    case "settings.save":     return { ok: true, settings: saveSettings_(body.settings) };

    default:
      return { ok: false, error: "Unknown action: " + action };
  }
}

// ---------------------------------------------------------------
// Generic sheet CRUD helpers (Sheets-as-database)
// ---------------------------------------------------------------

function getSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error("Sheet not found: " + name);
  return sheet;
}

function sheetToObjects_(name) {
  var sheet = getSheet_(name);
  var values = sheet.getDataRange().getValues();
  var headers = values.shift();
  return values.map(function (row) {
    var obj = {};
    headers.forEach(function (h, i) { obj[h] = row[i]; });
    return obj;
  });
}

function appendRow_(name, data) {
  var sheet = getSheet_(name);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var id = data.ID || Utilities.getUuid();
  data.ID = id;
  if (headers.indexOf("CreatedAt") !== -1 && !data.CreatedAt) {
    data.CreatedAt = new Date().toISOString();
  }
  var row = headers.map(function (h) { return data[h] !== undefined ? data[h] : ""; });
  sheet.appendRow(row);
  return data;
}

function findRowIndexById_(sheet, headers, id) {
  var idCol = headers.indexOf("ID");
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idCol]) === String(id)) return i + 1; // 1-based sheet row
  }
  return -1;
}

function updateRow_(name, id, data) {
  var sheet = getSheet_(name);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var rowIndex = findRowIndexById_(sheet, headers, id);
  if (rowIndex === -1) throw new Error("Record not found: " + id);
  var current = {};
  var currentValues = sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0];
  headers.forEach(function (h, i) { current[h] = currentValues[i]; });
  var merged = Object.assign(current, data, { ID: id });
  var row = headers.map(function (h) { return merged[h] !== undefined ? merged[h] : ""; });
  sheet.getRange(rowIndex, 1, 1, headers.length).setValues([row]);
  return merged;
}

function deleteRow_(name, id) {
  var sheet = getSheet_(name);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var rowIndex = findRowIndexById_(sheet, headers, id);
  if (rowIndex === -1) return false;
  sheet.deleteRow(rowIndex);
  return true;
}

function bulkImport_(name, rows) {
  var sheet = getSheet_(name);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var out = rows.map(function (data) {
    if (!data.ID) data.ID = Utilities.getUuid();
    return headers.map(function (h) { return data[h] !== undefined ? data[h] : ""; });
  });
  if (out.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, out.length, headers.length).setValues(out);
  }
  return out.length;
}

// ---------------------------------------------------------------
// Auth (simple — swap for something stronger before real production use)
// ---------------------------------------------------------------

/** SHA-256 hex digest — used for passwords set through the new self-registration flow. */
function hashPassword_(password) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password);
  return bytes.map(function (b) { return ((b < 0 ? b + 256 : b).toString(16)).padStart(2, "0"); }).join("");
}

function authLogin_(username, password) {
  var users = sheetToObjects_("Users");
  var match = users.find(function (u) {
    if (String(u.Username) !== String(username)) return false;
    var stored = String(u.Password);
    return stored === String(password) || stored === hashPassword_(password);
  });
  if (!match) return { ok: false, error: "Invalid credentials" };
  var token = generateToken_(match.Username, match.Role);
  return { ok: true, user: { username: match.Username, name: match.Name, role: match.Role }, token: token };
}

// ---------------------------------------------------------------
// Self-registration with admin approval + email verification code
// ---------------------------------------------------------------

function registerSignup_(name, email, password) {
  if (!name || !email || !password) return { ok: false, error: "Missing name, email, or password." };
  var existing = sheetToObjects_("Signups").find(function (s) {
    return String(s.Email).toLowerCase() === String(email).toLowerCase() && s.Status !== "rejected";
  });
  if (existing) return { ok: false, error: "A request for this email already exists." };
  appendRow_("Signups", {
    Timestamp: new Date().toISOString(),
    Name: name,
    Email: email,
    PasswordHash: hashPassword_(password),
    Status: "pending",
    VerificationCode: "",
    Role: "",
  });
  return { ok: true };
}

/** Admin-only (enforced in routeAction_). Pending + approved-but-not-yet-verified requests. */
function listSignups_() {
  return sheetToObjects_("Signups").filter(function (s) { return s.Status === "pending" || s.Status === "approved"; });
}

/** Admin approves a request, assigns a role, and emails a 6-digit activation code. */
function approveSignup_(id, role) {
  var code = String(Math.floor(100000 + Math.random() * 900000));
  var row = updateRow_("Signups", id, { Status: "approved", VerificationCode: code, Role: role === "admin" ? "admin" : "agent" });
  MailApp.sendEmail({
    to: row.Email,
    subject: "تم قبول طلب تسجيلك — كود التفعيل",
    body: "مرحبًا " + row.Name + "،\n\n" +
      "تم قبول طلب تسجيلك في MedConnect Campaigns.\n\n" +
      "كود التفعيل بتاعك هو: " + code + "\n\n" +
      "ادخل على صفحة تفعيل الحساب وحط الكود ده مع إيميلك عشان تكمل التسجيل.",
  });
  return { ok: true };
}

function rejectSignup_(id) {
  updateRow_("Signups", id, { Status: "rejected" });
  return { ok: true };
}

/** Final step: the user enters the emailed code, which actually creates their row in Users. */
function verifySignup_(email, code) {
  var signups = sheetToObjects_("Signups");
  var match = signups.find(function (s) {
    return String(s.Email).toLowerCase() === String(email).toLowerCase()
      && s.Status === "approved"
      && String(s.VerificationCode) === String(code);
  });
  if (!match) return { ok: false, error: "Invalid code, or this request hasn't been approved yet." };
  appendRow_("Users", { Username: match.Email, Password: match.PasswordHash, Name: match.Name, Role: match.Role });
  updateRow_("Signups", match.ID, { Status: "completed" });
  return { ok: true };
}

// ---------------------------------------------------------------
// Dashboard stats
// ---------------------------------------------------------------

/** Joins Logs with Campaigns and Doctors so the History page can show readable names instead of raw IDs. */
function buildHistoryRows_() {
  var logs = sheetToObjects_("Logs");
  var campaigns = sheetToObjects_("Campaigns");
  var doctors = sheetToObjects_("Doctors");
  var campaignById = {};
  campaigns.forEach(function (c) { campaignById[c.ID] = c; });
  var doctorById = {};
  doctors.forEach(function (d) { doctorById[d.ID] = d; });

  return logs.map(function (l) {
    var campaign = campaignById[l.CampaignID];
    var doctor = doctorById[l.DoctorID];
    return {
      Timestamp: l.Timestamp,
      CampaignID: l.CampaignID,
      CampaignName: campaign ? campaign.Name : "",
      DoctorID: l.DoctorID,
      CustomerName: doctor ? doctor.Name : "",
      MobileNumber: l.MobileNumber,
      Status: l.Status,
    };
  }).reverse();
}

/**
 * The Campaigns sheet's Sent/Delivered/Read/Failed columns are only ever
 * written once, when a batch is sent — they never reflect later webhook
 * updates (a message moving from "sent" to "delivered" to "read", or
 * failing after the fact). Logs is the real source of truth, since every
 * webhook status update rewrites that row's Status in place. This walks
 * Logs once and returns live counts per campaign.
 */
function computeAllCampaignStats_() {
  var logs = sheetToObjects_("Logs");
  var map = {};
  logs.forEach(function (l) {
    var id = String(l.CampaignID);
    if (!map[id]) map[id] = { sent: 0, delivered: 0, read: 0, failed: 0 };
    var status = String(l.Status || "");
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

/** Returns Campaigns rows with Sent/Delivered/Read/Failed overwritten by the live counts from Logs. */
function mergeLiveCampaignStats_(campaigns) {
  var statsMap = computeAllCampaignStats_();
  return campaigns.map(function (c) {
    var s = statsMap[String(c.ID)] || { sent: 0, delivered: 0, read: 0, failed: 0 };
    var merged = {};
    Object.keys(c).forEach(function (k) { merged[k] = c[k]; });
    merged.Sent = s.sent;
    merged.Delivered = s.delivered;
    merged.Read = s.read;
    merged.Failed = s.failed;
    return merged;
  });
}

function buildDashboardStats_() {
  var doctors = sheetToObjects_("Doctors");
  var campaigns = mergeLiveCampaignStats_(sheetToObjects_("Campaigns"));
  var sent = 0, delivered = 0, read = 0, failed = 0;
  campaigns.forEach(function (c) {
    sent += Number(c.Sent || 0);
    delivered += Number(c.Delivered || 0);
    read += Number(c.Read || 0);
    failed += Number(c.Failed || 0);
  });
  var recent = campaigns.slice(-5).reverse().map(function (c) {
    return {
      name: c.Name, date: c.CreatedAt, recipients: Number(c.Sent || 0),
      delivered: Number(c.Delivered || 0), status: (c.Status || "draft"),
    };
  });
  return {
    totalDoctors: doctors.length,
    totalCampaigns: campaigns.length,
    messagesSent: sent, delivered: delivered, read: read, failed: failed,
    performance: {
      labels: recent.map(function (_, i) { return "C" + (i + 1); }),
      sent: recent.map(function (r) { return r.recipients; }),
      delivered: recent.map(function (r) { return r.delivered; }),
    },
    recent: recent,
    agentStats: buildAgentStats_(),
  };
}

/**
 * Per-agent reply activity from the Inbox sheet's AgentUsername column
 * (populated by sendInboxReply_/sendInboxMedia_ whenever someone replies
 * to a customer from the Inbox chat). Counts total replies and replies
 * sent today, per agent, most-active first.
 */
function buildAgentStats_() {
  var rows = sheetToObjects_("Inbox");
  var todayStr = new Date().toDateString();
  var byAgent = {};
  rows.forEach(function (r) {
    if (r.Direction !== "out" || !r.AgentUsername) return;
    var name = String(r.AgentUsername).trim();
    if (!name) return;
    if (!byAgent[name]) byAgent[name] = { username: name, totalReplies: 0, repliesToday: 0, lastReplyAt: "" };
    byAgent[name].totalReplies++;
    var ts = r.Timestamp ? new Date(r.Timestamp) : null;
    if (ts && ts.toDateString() === todayStr) byAgent[name].repliesToday++;
    if (ts && (!byAgent[name].lastReplyAt || ts > new Date(byAgent[name].lastReplyAt))) {
      byAgent[name].lastReplyAt = r.Timestamp;
    }
  });
  return Object.keys(byAgent).map(function (k) { return byAgent[k]; })
    .sort(function (a, b) { return b.totalReplies - a.totalReplies; });
}

/**
 * Per-agent reply stats within an inclusive date range, plus each agent's
 * share (%) of total outbound replies in that range — the "evaluation"
 * view management asked for, so it's usable for performance comparisons
 * over an arbitrary period instead of just "totals so far".
 * startDate/endDate are "YYYY-MM-DD" strings from an <input type="date">;
 * either can be omitted for an open-ended range.
 */
function buildAgentStatsRange_(startDate, endDate) {
  var rows = sheetToObjects_("Inbox");
  var start = startDate ? new Date(startDate + "T00:00:00") : null;
  var end = endDate ? new Date(endDate + "T23:59:59") : null;

  var inRange = rows.filter(function (r) {
    if (!r.Timestamp) return false;
    var ts = new Date(r.Timestamp);
    if (start && ts < start) return false;
    if (end && ts > end) return false;
    return true;
  });

  var totalOutbound = inRange.filter(function (r) { return r.Direction === "out"; }).length;

  // "Received messages" for this metric means actual customer messages —
  // reaction pings (👍 etc.) aren't something an agent is expected to
  // reply to, so they're excluded from the denominator.
  var inboundCustomers = {}; // set of mobile numbers that messaged in-range
  inRange.forEach(function (r) {
    if (r.Direction === "out" || r.Status === "reaction") return;
    inboundCustomers[String(r.MobileNumber).trim()] = true;
  });
  var totalInbound = Object.keys(inboundCustomers).length;

  // Percentage is deliberately based on DISTINCT CUSTOMERS replied to,
  // not raw reply message count — an agent often sends several messages
  // per conversation (e.g. "checking now" then the actual answer), and
  // counting each of those as a separate "reply" could push a single
  // agent's share past 100% of the day's received messages, which isn't
  // a meaningful number. Counting customers instead guarantees each
  // agent's own percentage can never exceed 100%, and only counts a
  // customer if they actually messaged in *this* range — replying to an
  // older, unrelated conversation on the same day doesn't inflate it.
  var byAgent = {}; // username -> { replies: count, customers: {mobile: true} }
  inRange.forEach(function (r) {
    if (r.Direction !== "out" || !r.AgentUsername) return;
    var name = String(r.AgentUsername).trim();
    if (!name) return;
    if (!byAgent[name]) byAgent[name] = { username: name, replies: 0, customers: {} };
    byAgent[name].replies++;
    var mobile = String(r.MobileNumber).trim();
    if (inboundCustomers[mobile]) byAgent[name].customers[mobile] = true;
  });

  var result = Object.keys(byAgent).map(function (k) {
    var a = byAgent[k];
    var customersReplied = Object.keys(a.customers).length;
    return {
      username: a.username,
      replies: a.replies, // raw message count, shown for volume context
      customersReplied: customersReplied, // distinct customers actually replied to (subset of totalInbound)
      percentage: totalInbound > 0 ? Math.round((customersReplied / totalInbound) * 1000) / 10 : 0,
    };
  }).sort(function (a, b) { return b.replies - a.replies; });

  // Overall coverage: how many of the day's customers got *some* reply
  // from *some* agent — the "70% تم الرد عليها" headline number. Also
  // capped at totalInbound by construction (a customer either got
  // replied to or didn't, counted once regardless of how many agents touched it).
  var repliedCustomersOverall = {};
  Object.keys(byAgent).forEach(function (k) {
    Object.keys(byAgent[k].customers).forEach(function (mobile) { repliedCustomersOverall[mobile] = true; });
  });
  var coveredCount = Object.keys(repliedCustomersOverall).length;

  return {
    rows: result,
    totalOutbound: totalOutbound,
    totalInbound: totalInbound,
    coveragePercentage: totalInbound > 0 ? Math.round((coveredCount / totalInbound) * 1000) / 10 : 0,
    rangeStart: startDate || "",
    rangeEnd: endDate || "",
  };
}

// ---------------------------------------------------------------
// Settings (secrets stay server-side in Script Properties)
// ---------------------------------------------------------------

function getPublicSettings_() {
  var props = PropertiesService.getScriptProperties();
  return {
    phoneNumberId: props.getProperty("WA_PHONE_NUMBER_ID") || "",
    businessId: props.getProperty("WA_BUSINESS_ID") || "",
    webhookVerifyToken: props.getProperty("WA_WEBHOOK_VERIFY_TOKEN") || "",
    // Access token is intentionally never returned to the browser.
    hasAccessToken: !!props.getProperty("WA_ACCESS_TOKEN"),
  };
}

function saveSettings_(settings) {
  var props = PropertiesService.getScriptProperties();
  if (settings.phoneNumberId !== undefined) props.setProperty("WA_PHONE_NUMBER_ID", settings.phoneNumberId);
  if (settings.businessId !== undefined) props.setProperty("WA_BUSINESS_ID", settings.businessId);
  if (settings.webhookVerifyToken !== undefined) props.setProperty("WA_WEBHOOK_VERIFY_TOKEN", settings.webhookVerifyToken);
  if (settings.accessToken) props.setProperty("WA_ACCESS_TOKEN", settings.accessToken); // only overwritten if provided
  return getPublicSettings_();
}

// ---------------------------------------------------------------
// Media upload — images/PDFs picked in the browser are base64-encoded
// and sent here, saved to a Drive folder, and shared "anyone with the
// link can view" so WhatsApp Cloud API can fetch them by URL. There is
// no traditional file server in this stack, so Drive plays that role.
// ---------------------------------------------------------------

function uploadMedia_(filename, mimeType, base64) {
  if (!filename || !base64) throw new Error("Missing file data");
  var folder = getOrCreateMediaFolder_();
  var bytes = Utilities.base64Decode(base64);
  var blob = Utilities.newBlob(bytes, mimeType || "application/octet-stream", filename);
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var url = "https://drive.google.com/uc?export=download&id=" + file.getId();
  return { ok: true, url: url, fileId: file.getId(), name: file.getName() };
}

function getOrCreateMediaFolder_() {
  var name = "MedConnect Campaign Media";
  var folders = DriveApp.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(name);
}

// ---------------------------------------------------------------
// WhatsApp Cloud API — sending
// ---------------------------------------------------------------

function callWhatsAppApi_(payload) {
  var props = PropertiesService.getScriptProperties();
  var phoneNumberId = props.getProperty("WA_PHONE_NUMBER_ID");
  var accessToken = props.getProperty("WA_ACCESS_TOKEN");
  if (!phoneNumberId || !accessToken) throw new Error("WhatsApp credentials are not configured yet.");

  var url = "https://graph.facebook.com/v20.0/" + phoneNumberId + "/messages";
  var response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + accessToken },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  var data = JSON.parse(response.getContentText());
  if (response.getResponseCode() >= 300) {
    var errObj = data.error || {};
    var msg = errObj.message || "WhatsApp API error";
    if (errObj.error_data && errObj.error_data.details) msg += " — " + errObj.error_data.details;
    if (errObj.error_subcode) msg += " (subcode " + errObj.error_subcode + ")";
    throw new Error(msg);
  }
  return data.messages && data.messages[0] && data.messages[0].id;
}

/** Free-form text or single-image message — only deliverable within the 24h customer service window. */
/** Guesses whether a media URL is an image, video, or document from its
 * file extension, so campaigns can just paste a link into the same
 * "attachment" field they've always used and have it sent as the right
 * WhatsApp message/header type automatically — no separate "video URL"
 * field needed. Defaults to "image" when the extension is unrecognized
 * (covers the common case and matches the old hardcoded behavior). */
function guessMediaTypeFromUrl_(url) {
  var clean = String(url || "").split("?")[0].toLowerCase();
  if (/\.(mp4|3gp|mov|m4v)$/.test(clean)) return "video";
  if (/\.(pdf|docx?|xlsx?|pptx?)$/.test(clean)) return "document";
  return "image";
}

function sendWhatsAppMessage_(toNumber, bodyText, mediaUrl) {
  var payload = {
    messaging_product: "whatsapp",
    to: toNumber,
    type: mediaUrl ? guessMediaTypeFromUrl_(mediaUrl) : "text",
  };
  if (mediaUrl) {
    payload[payload.type] = { link: mediaUrl, caption: bodyText };
  } else {
    payload.text = { body: bodyText };
  }
  return callWhatsAppApi_(payload);
}

/**
 * Approved Meta message template — works outside the 24h window (first
 * contact, re-engagement). templateName/languageCode must exactly match
 * an approved template in WhatsApp Manager. paramValues fill {{1}}, {{2}}...
 * in the template body, in order.
 */
/**
 * Approved Meta message template — works outside the 24h window (first
 * contact, re-engagement). templateName/languageCode must exactly match
 * an approved template in WhatsApp Manager.
 *
 * paramValues fills the template body variables in order. If paramNames
 * is provided (Meta's newer named-parameter templates, e.g. {{customer_name}}
 * instead of {{1}}), each parameter is tagged with parameter_name so Meta
 * can match it correctly — this is required for templates built with named
 * variables, and must match the exact name registered in WhatsApp Manager.
 * headerImageUrl is only needed if the approved template has a media
 * header (image, video, or document) — the type is auto-detected from
 * the URL's file extension (see guessMediaTypeFromUrl_), so a video
 * template header works by just passing the same param, no separate
 * "header type" argument needed.
 */
function sendWhatsAppTemplateMessage_(toNumber, templateName, languageCode, paramValues, paramNames, headerImageUrl) {
  var payload = {
    messaging_product: "whatsapp",
    to: toNumber,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode || "ar" },
      components: [],
    },
  };
  if (headerImageUrl) {
    var headerMediaType = guessMediaTypeFromUrl_(headerImageUrl);
    var headerParam = { type: headerMediaType };
    headerParam[headerMediaType] = { link: headerImageUrl };
    payload.template.components.push({
      type: "header",
      parameters: [headerParam],
    });
  }
  if (paramValues && paramValues.length) {
    payload.template.components.push({
      type: "body",
      parameters: paramValues.map(function (v, i) {
        var param = { type: "text", text: v || "" };
        if (paramNames && paramNames[i]) param.parameter_name = paramNames[i];
        return param;
      }),
    });
  }
  if (payload.template.components.length === 0) delete payload.template.components;
  return callWhatsAppApi_(payload);
}

/** Fills {{doctor_name}}, {{specialty}}, {{hospital}}, {{city}} placeholders. */
function renderTemplate_(template, doctor) {
  return template
    .replace(/{{\s*doctor_name\s*}}/g, doctor.Name || "")
    .replace(/{{\s*specialty\s*}}/g, doctor.Specialty || "")
    .replace(/{{\s*hospital\s*}}/g, doctor.Hospital || "")
    .replace(/{{\s*city\s*}}/g, doctor.City || "");
}

/** Maps a doctor record to a field value by the short names used in TemplateParams (doctor_name/specialty/hospital/city). */
function fieldValueForDoctor_(fieldName, doctor) {
  var map = { doctor_name: doctor.Name, specialty: doctor.Specialty, hospital: doctor.Hospital, city: doctor.City };
  return map[fieldName] || "";
}

/** Sends one message for one doctor, using free-form text/image or an approved template depending on the campaign's MessageType. */
function sendOneCampaignMessage_(campaign, doctor) {
  var waMessageId, body;
  if (campaign.MessageType === "template") {
    var paramFields = campaign.TemplateParams
      ? String(campaign.TemplateParams).split(",").map(function (s) { return s.trim(); }).filter(Boolean)
      : [];
    var paramValues = paramFields.map(function (f) { return fieldValueForDoctor_(f, doctor); });
    var paramNames = campaign.TemplateParamNames
      ? String(campaign.TemplateParamNames).split(",").map(function (s) { return s.trim(); }).filter(Boolean)
      : null;
    waMessageId = sendWhatsAppTemplateMessage_(doctor.Mobile, campaign.TemplateName, campaign.TemplateLanguage, paramValues, paramNames, campaign.ImageUrl);
    // We don't know the approved template's exact wording here (it lives
    // on Meta's side), so show something identifying enough to give
    // context in the unified chat view instead of the literal text.
    body = "[قالب: " + campaign.TemplateName + "]" + (paramValues.length ? " — " + paramValues.join(" | ") : "");
  } else {
    body = renderTemplate_(campaign.Message, doctor);
    waMessageId = sendWhatsAppMessage_(doctor.Mobile, body, campaign.ImageUrl);
  }

  // Log it into Inbox too (not just Logs, which only feeds delivery
  // stats) so every outbound message — campaign, one-off reply, or new
  // conversation — shows up in the same chat thread. Without this, an
  // agent looking at the chat later has no idea a campaign message was
  // ever sent, and can't tell what the customer's reply is actually
  // about. Left with no AgentUsername on purpose: this wasn't a
  // customer-service reply, so it shouldn't count toward agent stats.
  try {
    appendRow_("Inbox", {
      Timestamp: new Date().toISOString(),
      MobileNumber: doctor.Mobile,
      CustomerID: doctor.ID || "",
      Direction: "out",
      Body: body,
      MediaUrl: campaign.ImageUrl || "",
      WaMessageId: waMessageId || "",
      Status: "sent",
    });
  } catch (err) {
    // Never let a logging hiccup fail the actual send — the message already went out.
  }

  return waMessageId;
}

/**
 * Sends a campaign to every doctor with Status = "Active".
 * Kept simple (synchronous loop) for now — for large lists (1000+),
 * switch this to a time-driven trigger that processes a batch per run
 * so you stay under WhatsApp's rate limits and Apps Script's 6-min cap.
 */
/**
 * Google Apps Script kills any single execution after 6 minutes, so a
 * campaign to thousands of recipients can never finish in one call.
 * This sends one batch per call (fast enough to stay well under that
 * limit) and leaves the campaign in "Sending" status if recipients
 * remain. processScheduledCampaigns_ (the same 10-minute trigger used
 * for scheduled sends) automatically calls this again for any campaign
 * still "Sending" until every recipient has been processed — no manual
 * splitting or resending required.
 */
var CAMPAIGN_BATCH_SIZE_ = 150;

function sendCampaign_(campaignId, options) {
  var campaigns = sheetToObjects_("Campaigns");
  var campaign = campaigns.find(function (c) { return String(c.ID) === String(campaignId); });
  if (!campaign) return { ok: false, error: "Campaign not found" };
  if (campaign.Status === "Paused" && !(options && options.forceResume)) {
    return { ok: false, error: "Campaign is paused" };
  }

  var recipientIds = campaign.RecipientIds
    ? String(campaign.RecipientIds).split(",").map(function (s) { return s.trim(); }).filter(Boolean)
    : null;
  var doctors = sheetToObjects_("Doctors").filter(function (d) {
    if (recipientIds && recipientIds.length) return recipientIds.indexOf(String(d.ID)) !== -1;
    return d.Status === "Active";
  });

  // Skip anyone already logged for this campaign (from a previous batch),
  // so resuming never double-sends.
  var alreadyProcessed = {};
  sheetToObjects_("Logs").forEach(function (l) {
    if (String(l.CampaignID) === String(campaignId)) alreadyProcessed[String(l.DoctorID)] = true;
  });
  var remaining = doctors.filter(function (d) { return !alreadyProcessed[String(d.ID)]; });
  var batch = remaining.slice(0, CAMPAIGN_BATCH_SIZE_);

  var sentNow = 0, failedNow = 0;
  batch.forEach(function (doctor) {
    try {
      var waMessageId = sendOneCampaignMessage_(campaign, doctor);
      logMessage_(campaignId, doctor.ID, doctor.Mobile, waMessageId, "sent");
      sentNow++;
    } catch (err) {
      logMessage_(campaignId, doctor.ID, doctor.Mobile, "", "failed: " + err.message);
      failedNow++;
    }
  });

  var totalSent = Number(campaign.Sent || 0) + sentNow;
  var totalFailed = Number(campaign.Failed || 0) + failedNow;
  var stillRemaining = remaining.length - batch.length;
  var newStatus = stillRemaining > 0 ? "Sending" : "Completed";

  updateRow_("Campaigns", campaignId, { Status: newStatus, Sent: totalSent, Failed: totalFailed });
  return { ok: true, sent: totalSent, failed: totalFailed, remaining: stillRemaining, status: newStatus };
}

function retryFailedMessages_(campaignId) {
  var logs = sheetToObjects_("Logs").filter(function (l) {
    return String(l.CampaignID) === String(campaignId) && String(l.Status).indexOf("failed") === 0;
  });
  var campaigns = sheetToObjects_("Campaigns");
  var campaign = campaigns.find(function (c) { return String(c.ID) === String(campaignId); });
  var doctors = sheetToObjects_("Doctors");
  var retried = 0;

  logs.forEach(function (log) {
    var doctor = doctors.find(function (d) { return String(d.ID) === String(log.DoctorID); });
    if (!doctor) return;
    try {
      var waMessageId = sendOneCampaignMessage_(campaign, doctor);
      logMessage_(campaignId, doctor.ID, doctor.Mobile, waMessageId, "sent");
      retried++;
    } catch (err) {
      logMessage_(campaignId, doctor.ID, doctor.Mobile, "", "failed: " + err.message);
    }
  });
  return { ok: true, retried: retried };
}

function logMessage_(campaignId, doctorId, mobile, waMessageId, status) {
  appendRow_("Logs", {
    Timestamp: new Date().toISOString(),
    CampaignID: campaignId,
    DoctorID: doctorId,
    MobileNumber: mobile,
    WaMessageId: waMessageId,
    Status: status,
  });
}

// ---------------------------------------------------------------
// Scheduling — a campaign saved with Status = "Scheduled" and a future
// ScheduledAt gets picked up here and sent once its time arrives.
// This function does nothing by itself; it needs a time-driven trigger
// (see setupScheduleTrigger_ below) to actually run periodically.
// ---------------------------------------------------------------

function processScheduledCampaigns_() {
  var campaigns = sheetToObjects_("Campaigns");
  var now = new Date();
  campaigns.forEach(function (c) {
    // Large campaigns that couldn't finish in one 6-minute run: send the next batch.
    if (c.Status === "Sending") {
      try { sendCampaign_(c.ID); } catch (err) { /* leave as "Sending" — retried again next run */ }
      return;
    }
    // Scheduled campaigns whose time has arrived.
    if (c.Status !== "Scheduled" || !c.ScheduledAt) return;
    var when = new Date(c.ScheduledAt);
    if (when <= now) {
      try {
        sendCampaign_(c.ID);
      } catch (err) {
        updateRow_("Campaigns", c.ID, { Status: "Failed" });
      }
    }
  });
}

/**
 * Run this ONCE manually: open this file in the Apps Script editor,
 * select "setupScheduleTrigger_" in the function dropdown at the top,
 * and click "Run". It installs a trigger that calls
 * processScheduledCampaigns_ every 10 minutes so scheduled campaigns
 * actually go out without you needing to keep a tab open.
 */
function setupScheduleTrigger_() {
  // Avoid creating duplicate triggers if this is run more than once.
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "processScheduledCampaigns_") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger("processScheduledCampaigns_")
    .timeBased()
    .everyMinutes(10)
    .create();
}

// ---------------------------------------------------------------
// Webhook — receives delivery/read/failed status updates from Meta
// Deploy URL + this GET handler is what you paste into the Meta
// "Callback URL" field. doGet above already routes here for the
// verification handshake; status updates arrive as doPost calls with
// no "action" field, so they fall through to this handler instead.
// ---------------------------------------------------------------

/** Entry point for every webhook event from Meta — dispatches to status updates and/or incoming messages. */
function handleWebhookEvent_(payload) {
  try {
    var entry = payload.entry && payload.entry[0];
    var changes = (entry && entry.changes) || [];
    changes.forEach(function (change) {
      var value = change.value || {};
      if (value.statuses) handleWebhookStatuses_(value.statuses);
      if (value.messages) handleWebhookMessages_(value.messages, value.contacts);
    });
  } catch (err) {
    // Swallow — webhook delivery should never throw back to Meta.
  }
}

function handleWebhookStatuses_(statuses) {
  statuses.forEach(function (s) {
    // Update the matching Logs row so history / retry can reflect real delivery state.
    var sheet = getSheet_("Logs");
    var values = sheet.getDataRange().getValues();
    var headers = values[0];
    var waCol = headers.indexOf("WaMessageId");
    var statusCol = headers.indexOf("Status");

    // Build a detailed status string when Meta includes an error reason
    // (e.g. delivery failures), instead of just the bare word "failed".
    var statusText = s.status;
    if (s.errors && s.errors.length) {
      var e = s.errors[0];
      var detail = (e.title || e.message || "Delivery failed");
      if (e.error_data && e.error_data.details) detail += " — " + e.error_data.details;
      statusText = s.status + ": (#" + e.code + ") " + detail;
    }

    for (var i = 1; i < values.length; i++) {
      if (values[i][waCol] === s.id) {
        sheet.getRange(i + 1, statusCol + 1).setValue(statusText);
        break;
      }
    }
  });
}

/** Saves incoming customer messages to the Inbox sheet so they show up in the app's Messages/Inbox page. */
/** Strips everything except digits, so "+20 100 123 4567", "20-100-1234567", and "201001234567" all match. */
function normalizeMobile_(mobile) {
  return String(mobile || "").replace(/[^0-9]/g, "");
}

function handleWebhookMessages_(messages, contacts) {
  var doctors = sheetToObjects_("Doctors");
  var doctorByMobile = {};
  doctors.forEach(function (d) { doctorByMobile[normalizeMobile_(d.Mobile)] = d; });

  messages.forEach(function (m) {
    var mobile = String(m.from || "").trim();
    var body = "";
    var mediaUrl = "";
    var status = "received";

    if (m.type === "reaction") {
      // WhatsApp sends {message_id, emoji} — emoji is "" when someone
      // *removes* a reaction, which isn't worth logging as its own row.
      var emoji = m.reaction && m.reaction.emoji;
      if (!emoji) return;
      body = emoji;
      status = "reaction"; // lets the chat UI render it as a compact reaction bubble instead of a normal message
    } else if (m.type === "text" && m.text) {
      body = m.text.body;
    } else if (m.type) {
      body = "[" + m.type + "]"; // fallback if there's no caption and/or the media couldn't be fetched
      var mediaObj = m[m.type]; // e.g. m.image, m.document, m.audio, m.video, m.sticker — all share {id, mime_type, ...}
      if (mediaObj && mediaObj.id) {
        try {
          mediaUrl = fetchAndStoreIncomingMedia_(mediaObj.id, mediaObj.mime_type);
        } catch (err) {
          // Don't let a media-download hiccup (expired link, quota, etc.)
          // stop the message from being logged at all — it just won't
          // have a previewable attachment this one time.
        }
        if (mediaObj.caption) body = mediaObj.caption;
      }
    }
    var doctor = doctorByMobile[normalizeMobile_(mobile)];

    appendRow_("Inbox", {
      Timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString(),
      MobileNumber: mobile,
      CustomerID: doctor ? doctor.ID : "",
      Body: body,
      MediaUrl: mediaUrl,
      WaMessageId: m.id || "",
      Status: status,
    });
  });
}

/** Common WhatsApp media MIME types → a sane file extension for the saved Drive file. */
var MEDIA_EXT_BY_MIME_ = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/3gpp": "3gp",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/amr": "amr",
  "application/pdf": "pdf",
};

/**
 * Downloads a customer-sent attachment from WhatsApp (Meta only gives you a
 * short-lived media ID in the webhook payload, not a direct URL — you have
 * to look up a real download link with your access token, then fetch the
 * bytes with that same token) and re-hosts it on Drive, mirroring
 * uploadMedia_()'s pattern for outgoing files, so the browser can just
 * <img src="..."> it without needing any WhatsApp auth of its own.
 * Returns the Drive URL, or "" if credentials aren't configured or the
 * download failed for any reason.
 */
function fetchAndStoreIncomingMedia_(mediaId, mimeType) {
  var props = PropertiesService.getScriptProperties();
  var accessToken = props.getProperty("WA_ACCESS_TOKEN");
  if (!accessToken) return "";

  // Step 1: media ID → a temporary authenticated download URL.
  var metaResp = UrlFetchApp.fetch("https://graph.facebook.com/v20.0/" + mediaId, {
    method: "get",
    headers: { Authorization: "Bearer " + accessToken },
    muteHttpExceptions: true,
  });
  var meta = JSON.parse(metaResp.getContentText() || "{}");
  if (!meta.url) return "";

  // Step 2: fetch the actual bytes from that URL (still needs the same auth header).
  var fileResp = UrlFetchApp.fetch(meta.url, {
    method: "get",
    headers: { Authorization: "Bearer " + accessToken },
    muteHttpExceptions: true,
  });
  if (fileResp.getResponseCode() !== 200) return "";

  var ext = MEDIA_EXT_BY_MIME_[mimeType || meta.mime_type] || "";
  var filename = mediaId + (ext ? "." + ext : "");
  var folder = getOrCreateMediaFolder_();
  var blob = fileResp.getBlob().setName(filename);
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return "https://drive.google.com/uc?export=download&id=" + file.getId();
}

/** Returns one row per conversation (most recent message per mobile number), newest first. */
/**
 * Full-text search across every message body in the Inbox sheet, across
 * ALL conversations — not just the last-message preview the sidebar
 * list search covers. Used for things like "who asked about X report"
 * without having to remember or open the right conversation first.
 * Case-insensitive substring match; capped at 50 most-recent hits so a
 * broad query can't return an unbounded, slow-to-render result set.
 */
function searchInboxMessages_(query) {
  var q = String(query || "").trim().toLowerCase();
  if (q.length < 2) return []; // too short to be a useful search, and avoids scanning on every keystroke

  var rows = sheetToObjects_("Inbox");
  var doctors = sheetToObjects_("Doctors");
  var doctorByMobile = {};
  doctors.forEach(function (d) { doctorByMobile[normalizeMobile_(d.Mobile)] = d; });

  var matches = rows.filter(function (r) {
    return r.Body && String(r.Body).toLowerCase().indexOf(q) !== -1;
  });
  matches.sort(function (a, b) { return new Date(b.Timestamp) - new Date(a.Timestamp); });

  return matches.slice(0, 50).map(function (r) {
    var mobile = String(r.MobileNumber).trim();
    var doctor = doctorByMobile[normalizeMobile_(mobile)];
    return {
      MobileNumber: mobile,
      CustomerName: doctor ? doctor.Name : "",
      Body: r.Body,
      Timestamp: r.Timestamp,
      Direction: r.Direction,
    };
  });
}

function buildInboxConversations_(currentUsername) {
  var rows = sheetToObjects_("Inbox");
  var doctors = sheetToObjects_("Doctors");
  var doctorByMobile = {};
  doctors.forEach(function (d) { doctorByMobile[normalizeMobile_(d.Mobile)] = d; });
  var readByMobile = getReadStateMap_();
  var pinnedMobiles = getPinnedMobilesForUser_(currentUsername); // {mobile: pinnedAt}, this user only

  var byMobile = {};
  rows.forEach(function (r) {
    var mobile = String(r.MobileNumber).trim();
    if (!byMobile[mobile] || new Date(r.Timestamp) > new Date(byMobile[mobile].Timestamp)) {
      byMobile[mobile] = r;
    }
  });

  return Object.keys(byMobile).map(function (mobile) {
    var last = byMobile[mobile];
    var doctor = doctorByMobile[normalizeMobile_(mobile)];
    var readState = readByMobile[mobile];
    return {
      MobileNumber: mobile,
      CustomerName: doctor ? doctor.Name : "",
      LastMessage: last.Body,
      LastStatus: last.Status,
      LastDirection: last.Direction,
      LastTimestamp: last.Timestamp,
      // Shared across every device/agent (stored in the InboxReadState
      // sheet) — the client just compares this to LastTimestamp instead
      // of keeping its own per-browser read/unread flag.
      LastReadTimestamp: readState ? readState.LastReadTimestamp : "",
      LastReadBy: readState ? readState.LastReadBy : "",
      // Per-user pin (see PinnedConversations sheet) — each agent pins
      // their own frequently-needed numbers (support line, manager,
      // etc.), independent of what anyone else has pinned.
      Pinned: !!pinnedMobiles[mobile],
      PinnedAt: pinnedMobiles[mobile] || "",
    };
  }).sort(function (a, b) { return new Date(b.LastTimestamp) - new Date(a.LastTimestamp); });
}

// ---------------------------------------------------------------
// Pinned conversations — per-user, synced across devices (see
// PinnedConversations sheet: Username | MobileNumber | PinnedAt). Each
// agent pins their own frequently-needed numbers (e.g. "IT support",
// "customer service manager") so they're always at the top of their own
// conversation list instead of searching by name every time.
// ---------------------------------------------------------------

function getPinnedMobilesForUser_(username) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("PinnedConversations");
  if (!sheet || !username) return {};
  var rows = sheetToObjects_("PinnedConversations");
  var map = {};
  rows.forEach(function (r) {
    if (String(r.Username).trim() === String(username).trim()) {
      map[String(r.MobileNumber).trim()] = r.PinnedAt || new Date().toISOString();
    }
  });
  return map;
}

function pinConversation_(username, mobile) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("PinnedConversations");
  if (!sheet) return { ok: false, error: "PinnedConversations sheet isn't set up yet." };
  var mobileClean = String(mobile || "").trim();
  if (!mobileClean || !username) return { ok: false, error: "Missing mobile or user." };

  var existing = sheetToObjects_("PinnedConversations").some(function (r) {
    return String(r.Username).trim() === String(username).trim() && String(r.MobileNumber).trim() === mobileClean;
  });
  if (existing) return { ok: true }; // already pinned — nothing to do
  appendRow_("PinnedConversations", { Username: username, MobileNumber: mobileClean, PinnedAt: new Date().toISOString() });
  return { ok: true };
}

function unpinConversation_(username, mobile) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("PinnedConversations");
  if (!sheet) return { ok: true };
  var mobileClean = String(mobile || "").trim();
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var userCol = headers.indexOf("Username");
  var mobileCol = headers.indexOf("MobileNumber");
  var values = sheet.getDataRange().getValues();
  for (var i = values.length - 1; i >= 1; i--) {
    if (String(values[i][userCol]).trim() === String(username).trim() && String(values[i][mobileCol]).trim() === mobileClean) {
      sheet.deleteRow(i + 1);
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------
// Inbox read state — shared across devices/agents (see InboxReadState
// sheet: MobileNumber | LastReadTimestamp | LastReadBy). There's one row
// per conversation, upserted every time someone opens/reads a thread, so
// "read" status is consistent no matter who's looking or from where.
// ---------------------------------------------------------------

function getReadStateMap_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("InboxReadState");
  if (!sheet) return {}; // sheet not created yet — treat everything as unread rather than erroring
  var rows = sheetToObjects_("InboxReadState");
  var map = {};
  rows.forEach(function (r) {
    var mobile = String(r.MobileNumber).trim();
    // If duplicate rows exist for the same mobile (see markConversationRead_
    // for why that could happen), keep whichever has the LATEST
    // timestamp — not just whichever row happens to come last in the
    // sheet — so a stray stale duplicate can't make a conversation look
    // permanently unread.
    var existing = map[mobile];
    if (!existing || new Date(r.LastReadTimestamp) > new Date(existing.LastReadTimestamp)) {
      map[mobile] = r;
    }
  });
  return map;
}

/** Upserts the read cursor for a conversation. Returns the timestamp that was stored. */
function markConversationRead_(mobile, timestamp, username) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("InboxReadState");
  if (!sheet) return ""; // sheet not set up — silently no-op instead of throwing on every message open
  var readAt = timestamp || new Date().toISOString();

  // Concurrent requests (poll cycles, prefetch, multiple agents/devices)
  // can otherwise each read the sheet before any of them has written
  // back, all miss the existing row, and each append their own duplicate.
  // A script lock makes the whole read-then-write atomic across
  // simultaneous executions.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    return readAt; // couldn't get the lock in time — don't hang the request over a UI nicety
  }
  try {
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var mobileCol = headers.indexOf("MobileNumber");
    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][mobileCol]).trim() === String(mobile).trim()) {
        var row = headers.map(function (h) {
          if (h === "MobileNumber") return mobile;
          if (h === "LastReadTimestamp") return readAt;
          if (h === "LastReadBy") return username || "";
          return values[i][headers.indexOf(h)];
        });
        sheet.getRange(i + 1, 1, 1, headers.length).setValues([row]);
        return readAt;
      }
    }
    sheet.appendRow(headers.map(function (h) {
      if (h === "MobileNumber") return mobile;
      if (h === "LastReadTimestamp") return readAt;
      if (h === "LastReadBy") return username || "";
      return "";
    }));
    return readAt;
  } finally {
    lock.releaseLock();
  }
}

/** Sends an image or document attachment to a customer from the Inbox chat, and logs it. */
function sendInboxMedia_(mobile, mediaUrl, mediaType, caption, filename, agentUsername) {
  // Respect an explicit "document" choice from the file picker, but
  // otherwise auto-detect (so an attached video gets sent as a video,
  // not silently mislabeled as an image).
  var resolvedType = mediaType === "document" ? "document" : guessMediaTypeFromUrl_(mediaUrl);
  var payload = {
    messaging_product: "whatsapp",
    to: mobile,
    type: resolvedType,
  };
  if (resolvedType === "document") {
    payload.document = { link: mediaUrl, caption: caption || "", filename: filename || "file" };
  } else {
    payload[resolvedType] = { link: mediaUrl, caption: caption || "" };
  }
  var waMessageId = callWhatsAppApi_(payload);

  var doctors = sheetToObjects_("Doctors");
  var doctor = doctors.find(function (d) { return normalizeMobile_(d.Mobile) === normalizeMobile_(mobile); });
  appendRow_("Inbox", {
    Timestamp: new Date().toISOString(),
    MobileNumber: mobile,
    CustomerID: doctor ? doctor.ID : "",
    Direction: "out",
    Body: caption || (mediaType === "document" ? "[document]" : "[image]"),
    MediaUrl: mediaUrl,
    WaMessageId: waMessageId || "",
    Status: "sent",
    AgentUsername: agentUsername || "",
  });
  markConversationRead_(mobile, new Date().toISOString(), agentUsername); // replying implies you've seen it
  return { ok: true };
}

/** Sends a free-form reply to a customer (only deliverable within their 24h window) and logs it to Inbox. */
function sendInboxReply_(mobile, body, agentUsername) {
  var waMessageId = sendWhatsAppMessage_(mobile, body, null);
  var doctors = sheetToObjects_("Doctors");
  var doctor = doctors.find(function (d) { return normalizeMobile_(d.Mobile) === normalizeMobile_(mobile); });
  appendRow_("Inbox", {
    Timestamp: new Date().toISOString(),
    MobileNumber: mobile,
    CustomerID: doctor ? doctor.ID : "",
    Direction: "out",
    Body: body,
    WaMessageId: waMessageId || "",
    Status: "sent",
    AgentUsername: agentUsername || "",
  });
  markConversationRead_(mobile, new Date().toISOString(), agentUsername); // replying implies you've seen it
  return { ok: true };
}

// ---------------------------------------------------------------
// Starting a brand-new conversation (no prior messages, so a free-form
// text would be silently rejected by WhatsApp — has to be an approved
// template). Fixed to a single pre-approved template with NO variables,
// used for doctor-requested one-off outreach to a specific patient —
// e.g. "please contact us" — set up once via WhatsApp Manager.
// ---------------------------------------------------------------

var NEW_CONVERSATION_TEMPLATE_NAME_ = "new_message";
var NEW_CONVERSATION_TEMPLATE_LANG_ = "ar_EG";
// Mirrors the template's exact approved wording, purely so it shows up
// correctly in our own Inbox chat log — we aren't sending this text
// ourselves, it's baked into the already-approved template on Meta's side.
var NEW_CONVERSATION_TEMPLATE_BODY_ = "الرجاء التواصل مع مجمع المدلوح للاهمية؛\n\nبيانات التواصل / هاتفيا او عبر واتس اب من خلال الرقم الموحد:\n920014603";

function startNewConversation_(mobile, agentUsername) {
  var cleanMobile = String(mobile || "").replace(/[^0-9]/g, "");
  if (!cleanMobile) return { ok: false, error: "رقم الجوال غير صالح." };

  var waMessageId = sendWhatsAppTemplateMessage_(cleanMobile, NEW_CONVERSATION_TEMPLATE_NAME_, NEW_CONVERSATION_TEMPLATE_LANG_, [], null, "");

  var doctors = sheetToObjects_("Doctors");
  var doctor = doctors.find(function (d) { return normalizeMobile_(d.Mobile) === normalizeMobile_(cleanMobile); });
  appendRow_("Inbox", {
    Timestamp: new Date().toISOString(),
    MobileNumber: cleanMobile,
    CustomerID: doctor ? doctor.ID : "",
    Direction: "out",
    Body: NEW_CONVERSATION_TEMPLATE_BODY_,
    WaMessageId: waMessageId || "",
    Status: "sent",
    AgentUsername: agentUsername || "",
  });
  markConversationRead_(cleanMobile, new Date().toISOString(), agentUsername);
  return { ok: true, mobile: cleanMobile };
}

// ---------------------------------------------------------------
// Second "brand-new conversation" button, for reception staff: sends the
// Seha-platform QR code image via its own separate pre-approved template
// (has an image header, unlike NEW_CONVERSATION_TEMPLATE_NAME_ above).
// ---------------------------------------------------------------

var QR_SEHA_TEMPLATE_NAME_ = "qr_seha";
var QR_SEHA_TEMPLATE_LANG_ = "ar_EG";
var QR_SEHA_IMAGE_URL_ = "https://raw.githubusercontent.com/ahmedkhalil1587/whatsapp-campaign/main/assets/img/QR_seha.jpg";
// Friendly placeholder for our own chat log — the template's real approved
// wording lives on Meta's side, we just need something readable here.
// Mirrors the template's exact approved wording, purely so it shows up
// correctly in our own Inbox chat log — we aren't sending this text
// ourselves, it's baked into the already-approved template on Meta's side.
var QR_SEHA_TEMPLATE_BODY_ = "مرفق QR للستجيل لرفع الاجازات المرضية على منصة صحتي\n\nللمزيد من الاستفسارات تواصل هاتفيا او واتس اب على الرقم الموحد:\n920014603";

function sendQrSehaConversation_(mobile, agentUsername) {
  var cleanMobile = String(mobile || "").replace(/[^0-9]/g, "");
  if (!cleanMobile) return { ok: false, error: "رقم الجوال غير صالح." };

  var waMessageId = sendWhatsAppTemplateMessage_(cleanMobile, QR_SEHA_TEMPLATE_NAME_, QR_SEHA_TEMPLATE_LANG_, [], null, QR_SEHA_IMAGE_URL_);

  var doctors = sheetToObjects_("Doctors");
  var doctor = doctors.find(function (d) { return normalizeMobile_(d.Mobile) === normalizeMobile_(cleanMobile); });
  appendRow_("Inbox", {
    Timestamp: new Date().toISOString(),
    MobileNumber: cleanMobile,
    CustomerID: doctor ? doctor.ID : "",
    Direction: "out",
    Body: QR_SEHA_TEMPLATE_BODY_,
    MediaUrl: QR_SEHA_IMAGE_URL_, // so the QR image itself shows up in the chat log, not just placeholder text
    WaMessageId: waMessageId || "",
    Status: "sent",
    AgentUsername: agentUsername || "",
  });
  markConversationRead_(cleanMobile, new Date().toISOString(), agentUsername);
  return { ok: true, mobile: cleanMobile };
}

// ---------------------------------------------------------------
// Third "brand-new conversation" button: requesting a patient's national
// ID so staff can pull/send their medical reports or sick leave records.
// Plain text template, no image.
// ---------------------------------------------------------------

var REPORT_REQ_TEMPLATE_NAME_ = "report_req";
var REPORT_REQ_TEMPLATE_LANG_ = "ar_EG";
// Mirrors the template's exact approved wording, purely so it shows up
// correctly in our own Inbox chat log — we aren't sending this text
// ourselves, it's baked into the already-approved template on Meta's side.
var REPORT_REQ_TEMPLATE_BODY_ = "🖨️ لطلب ارسال التقارير الطبية أو الاجازات المرضية؛\nالرجاء ارسال:\n1- التقرير المطلوب (اجازة مرضية/تقريرطبي/نتيجة مختبر او اشعه)\n2- رقم الهوية/الاقامة\nوشكرا 🌹\nلمزيد من المعلومات تواصل معنا عبر الواتس اب او الهاتف على الرقم الموحد:\n📞 920014603";

function sendReportRequestConversation_(mobile, agentUsername) {
  var cleanMobile = String(mobile || "").replace(/[^0-9]/g, "");
  if (!cleanMobile) return { ok: false, error: "رقم الجوال غير صالح." };

  var waMessageId = sendWhatsAppTemplateMessage_(cleanMobile, REPORT_REQ_TEMPLATE_NAME_, REPORT_REQ_TEMPLATE_LANG_, [], null, "");

  var doctors = sheetToObjects_("Doctors");
  var doctor = doctors.find(function (d) { return normalizeMobile_(d.Mobile) === normalizeMobile_(cleanMobile); });
  appendRow_("Inbox", {
    Timestamp: new Date().toISOString(),
    MobileNumber: cleanMobile,
    CustomerID: doctor ? doctor.ID : "",
    Direction: "out",
    Body: REPORT_REQ_TEMPLATE_BODY_,
    WaMessageId: waMessageId || "",
    Status: "sent",
    AgentUsername: agentUsername || "",
  });
  markConversationRead_(cleanMobile, new Date().toISOString(), agentUsername);
  return { ok: true, mobile: cleanMobile };
}


/**
 * Plain wrapper with no trailing underscore, so it always shows up in the
 * Apps Script editor's "Run" function dropdown. Select THIS one (not
 * setupScheduleTrigger_) from the dropdown and click Run once.
 */
function runScheduleSetup() {
  setupScheduleTrigger_();
}

function testEmailAuth() {
  MailApp.sendEmail(Session.getActiveUser().getEmail(), "اختبار صلاحية الإيميل", "لو وصلتك الرسالة دي، الصلاحية اتفعلت صح.");
}
