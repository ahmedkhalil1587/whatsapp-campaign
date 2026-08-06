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
    case "campaigns.logs":     return { ok: true, rows: sheetToObjects_("Logs").filter(function (l) { return String(l.CampaignID) === String(body.id); }) };

    case "templates.list":    return { ok: true, rows: sheetToObjects_("Templates") };
    case "templates.create":  return { ok: true, row: appendRow_("Templates", body.template) };
    case "templates.update":  return { ok: true, row: updateRow_("Templates", body.id, body.template) };
    case "templates.delete":  return { ok: true, deleted: deleteRow_("Templates", body.id) };

    case "media.upload":      return uploadMedia_(body.filename, body.mimeType, body.base64);

    case "dashboard.stats":   return { ok: true, stats: buildDashboardStats_() };

    case "history.list":      return { ok: true, rows: buildHistoryRows_() };

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
    throw new Error((data.error && data.error.message) || "WhatsApp API error");
  }
  return data.messages && data.messages[0] && data.messages[0].id;
}

/** Free-form text or single-image message — only deliverable within the 24h customer service window. */
function sendWhatsAppMessage_(toNumber, bodyText, mediaUrl) {
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
 */
function sendWhatsAppTemplateMessage_(toNumber, templateName, languageCode, paramValues, paramNames) {
  var payload = {
    messaging_product: "whatsapp",
    to: toNumber,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode || "ar" },
    },
  };
  if (paramValues && paramValues.length) {
    payload.template.components = [{
      type: "body",
      parameters: paramValues.map(function (v, i) {
        var param = { type: "text", text: v || "" };
        if (paramNames && paramNames[i]) param.parameter_name = paramNames[i];
        return param;
      }),
    }];
  }
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
  if (campaign.MessageType === "template") {
    var paramFields = campaign.TemplateParams
      ? String(campaign.TemplateParams).split(",").map(function (s) { return s.trim(); }).filter(Boolean)
      : [];
    var paramValues = paramFields.map(function (f) { return fieldValueForDoctor_(f, doctor); });
    var paramNames = campaign.TemplateParamNames
      ? String(campaign.TemplateParamNames).split(",").map(function (s) { return s.trim(); }).filter(Boolean)
      : null;
    return sendWhatsAppTemplateMessage_(doctor.Mobile, campaign.TemplateName, campaign.TemplateLanguage, paramValues, paramNames);
  }
  var text = renderTemplate_(campaign.Message, doctor);
  return sendWhatsAppMessage_(doctor.Mobile, text, campaign.ImageUrl);
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
      var waMessageId = sendOneCampaignMessage_(campaign, doctor);
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
  } catch (err) {
    // Swallow — webhook delivery should never throw back to Meta.
  }
}

/**
 * Plain wrapper with no trailing underscore, so it always shows up in the
 * Apps Script editor's "Run" function dropdown. Select THIS one (not
 * setupScheduleTrigger_) from the dropdown and click Run once.
 */
function runScheduleSetup() {
  setupScheduleTrigger_();
}
