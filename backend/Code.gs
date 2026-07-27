/**
 * MedConnect Campaigns — Google Apps Script Backend
 * ---------------------------------------------------------------
 * Deploy this as a Web App (Extensions > Apps Script in your
 * Google Sheet). See backend/README.md for full setup steps.
 *
 * Sheet tabs expected (create with these exact names/headers):
 *   Doctors    : ID | Name | Mobile | Specialty | Hospital | City | Country | Status | Notes
 *   Campaigns  : ID | Name | Message | ImageUrl | PdfUrl | Status | ScheduledAt | CreatedAt | Sent | Delivered | Read | Failed | RecipientIds
 *   Templates  : ID | Name | Body
 *   Logs       : Timestamp | CampaignID | DoctorID | MobileNumber | WaMessageId | Status
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
  // Meta sends delivery/read/failed status updates without our "action" field —
  // route those to the webhook handler instead of the app router.
  if (e.postData && e.postData.contents) {
    try {
      var maybePayload = JSON.parse(e.postData.contents);
      if (maybePayload.object === "whatsapp_business_account") {
        handleWebhookStatus_(maybePayload);
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

function routeAction_(action, body) {
  switch (action) {
    case "auth.login":        return authLogin_(body.username, body.password);

    case "doctors.list":      return { ok: true, rows: sheetToObjects_("Doctors") };
    case "doctors.create":    return { ok: true, row: appendRow_("Doctors", body.doctor) };
    case "doctors.update":    return { ok: true, row: updateRow_("Doctors", body.id, body.doctor) };
    case "doctors.delete":    return { ok: true, deleted: deleteRow_("Doctors", body.id) };
    case "doctors.bulkImport":return { ok: true, count: bulkImport_("Doctors", body.rows) };

    case "campaigns.list":    return { ok: true, rows: sheetToObjects_("Campaigns") };
    case "campaigns.create":  return { ok: true, row: appendRow_("Campaigns", body.campaign) };
    case "campaigns.send":    return sendCampaign_(body.id);
    case "campaigns.retryFailed": return retryFailedMessages_(body.id);

    case "templates.list":    return { ok: true, rows: sheetToObjects_("Templates") };
    case "templates.create":  return { ok: true, row: appendRow_("Templates", body.template) };

    case "dashboard.stats":   return { ok: true, stats: buildDashboardStats_() };

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

function authLogin_(username, password) {
  var users = sheetToObjects_("Users");
  var match = users.find(function (u) {
    return String(u.Username) === String(username) && String(u.Password) === String(password);
  });
  if (!match) return { ok: false, error: "Invalid credentials" };
  return { ok: true, user: { username: match.Username, name: match.Name, role: match.Role } };
}

// ---------------------------------------------------------------
// Dashboard stats
// ---------------------------------------------------------------

function buildDashboardStats_() {
  var doctors = sheetToObjects_("Doctors");
  var campaigns = sheetToObjects_("Campaigns");
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
// WhatsApp Cloud API — sending
// ---------------------------------------------------------------

function sendWhatsAppMessage_(toNumber, bodyText, mediaUrl) {
  var props = PropertiesService.getScriptProperties();
  var phoneNumberId = props.getProperty("WA_PHONE_NUMBER_ID");
  var accessToken = props.getProperty("WA_ACCESS_TOKEN");
  if (!phoneNumberId || !accessToken) throw new Error("WhatsApp credentials are not configured yet.");

  var url = "https://graph.facebook.com/v20.0/" + phoneNumberId + "/messages";
  var payload = {
    messaging_product: "whatsapp",
    to: toNumber,
    type: mediaUrl ? "image" : "text",
  };
  if (mediaUrl) {
    payload.image = { link: mediaUrl, caption: bodyText };
  } else {
    payload.text = { body: bodyText };
  }

  var response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + accessToken },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  var data = JSON.parse(response.getContentText());
  if (response.getResponseCode() >= 300) {
    throw new Error((data.error && data.error.message) || "WhatsApp API error");
  }
  return data.messages && data.messages[0] && data.messages[0].id;
}

/** Fills {{doctor_name}}, {{specialty}}, {{hospital}}, {{city}} placeholders. */
function renderTemplate_(template, doctor) {
  return template
    .replace(/{{\s*doctor_name\s*}}/g, doctor.Name || "")
    .replace(/{{\s*specialty\s*}}/g, doctor.Specialty || "")
    .replace(/{{\s*hospital\s*}}/g, doctor.Hospital || "")
    .replace(/{{\s*city\s*}}/g, doctor.City || "");
}

/**
 * Sends a campaign to every doctor with Status = "Active".
 * Kept simple (synchronous loop) for now — for large lists (1000+),
 * switch this to a time-driven trigger that processes a batch per run
 * so you stay under WhatsApp's rate limits and Apps Script's 6-min cap.
 */
function sendCampaign_(campaignId) {
  var campaigns = sheetToObjects_("Campaigns");
  var campaign = campaigns.find(function (c) { return String(c.ID) === String(campaignId); });
  if (!campaign) return { ok: false, error: "Campaign not found" };

  var recipientIds = campaign.RecipientIds
    ? String(campaign.RecipientIds).split(",").map(function (s) { return s.trim(); }).filter(Boolean)
    : null;
  var doctors = sheetToObjects_("Doctors").filter(function (d) {
    if (recipientIds && recipientIds.length) return recipientIds.indexOf(String(d.ID)) !== -1;
    return d.Status === "Active";
  });
  var sent = 0, failed = 0;

  doctors.forEach(function (doctor) {
    try {
      var text = renderTemplate_(campaign.Message, doctor);
      var waMessageId = sendWhatsAppMessage_(doctor.Mobile, text, campaign.ImageUrl);
      logMessage_(campaignId, doctor.ID, doctor.Mobile, waMessageId, "sent");
      sent++;
    } catch (err) {
      logMessage_(campaignId, doctor.ID, doctor.Mobile, "", "failed: " + err.message);
      failed++;
    }
  });

  updateRow_("Campaigns", campaignId, { Status: "Completed", Sent: sent, Failed: failed });
  return { ok: true, sent: sent, failed: failed };
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
      var text = renderTemplate_(campaign.Message, doctor);
      var waMessageId = sendWhatsAppMessage_(doctor.Mobile, text, campaign.ImageUrl);
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

function handleWebhookStatus_(payload) {
  try {
    var entry = payload.entry && payload.entry[0];
    var change = entry && entry.changes && entry.changes[0];
    var statuses = change && change.value && change.value.statuses;
    if (!statuses) return;
    statuses.forEach(function (s) {
      // Update the matching Logs row so history / retry can reflect real delivery state.
      var sheet = getSheet_("Logs");
      var values = sheet.getDataRange().getValues();
      var headers = values[0];
      var waCol = headers.indexOf("WaMessageId");
      var statusCol = headers.indexOf("Status");
      for (var i = 1; i < values.length; i++) {
        if (values[i][waCol] === s.id) {
          sheet.getRange(i + 1, statusCol + 1).setValue(s.status);
          break;
        }
      }
    });
  } catch (err) {
    // Swallow — webhook delivery should never throw back to Meta.
  }
}
