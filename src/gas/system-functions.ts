export const SYSTEM_FUNCTIONS_CODE = `
var _agsLogs = [];

function _agsLog(msg) {
  _agsLogs.push({ t: new Date().toISOString(), m: String(msg) });
}

function doPost(e) {
  var payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return _agsJsonResponse({ success: false, error: 'Invalid JSON: ' + err.message });
  }
  var fn = payload._fn;
  var params = payload._params || {};
  if (!fn) {
    return _agsJsonResponse({ success: false, error: 'Missing _fn in request body' });
  }
  _agsLogs = [];
  try {
    if (typeof this[fn] !== 'function') {
      return _agsJsonResponse({ success: false, error: 'Unknown function: ' + fn });
    }
    var result = this[fn](params);
    return _agsJsonResponse({ success: true, result: result, logs: _agsLogs.slice() });
  } catch (err) {
    return _agsJsonResponse({ success: false, error: err.message || String(err), logs: _agsLogs.slice() });
  }
}

function doGet(e) {
  var html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AutomateGS — Authorized</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f3ff;min-height:100vh;display:flex;align-items:center;justify-content:center}.card{background:#fff;border-radius:16px;padding:48px 56px;box-shadow:0 4px 24px rgba(79,70,229,.10);text-align:center;max-width:420px;width:90%}.icon{font-size:52px;margin-bottom:20px}.badge{display:inline-block;background:#ede9fe;color:#4f46e5;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;padding:4px 12px;border-radius:99px;margin-bottom:16px}h1{font-size:22px;font-weight:700;color:#111;margin-bottom:10px}p{color:#6b7280;font-size:15px;line-height:1.6}</style></head><body><div class="card"><div class="icon">⚡</div><div class="badge">AutomateGS</div><h1>Connected to Google</h1><p>Your automation is authorized and ready to run.<br>You can close this tab and return to Claude.</p></div></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle('AutomateGS — Authorized');
}

function _agsJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function _agsSchedule(params) {
  var fnName = params.functionName;
  var type = params.type;
  var hour = (params.hour !== undefined) ? params.hour : 9;
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === fnName) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  var trigger;
  if (type === 'hourly') {
    trigger = ScriptApp.newTrigger(fnName).timeBased().everyHours(1).create();
  } else if (type === 'daily') {
    trigger = ScriptApp.newTrigger(fnName).timeBased().atHour(hour).everyDays(1).create();
  } else if (type === 'weekly') {
    var day = params.dayOfWeek || ScriptApp.WeekDay.MONDAY;
    trigger = ScriptApp.newTrigger(fnName).timeBased().onWeekDay(day).atHour(hour).create();
  } else {
    return { success: false, error: 'Unknown schedule type: ' + type };
  }
  return { success: true, triggerId: trigger.getUniqueId() };
}

function _agsUnschedule(params) {
  var fnName = params.functionName;
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === fnName) {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  return { success: true, removed: removed };
}

function _agsMakeStagingCopy(params) {
  var sheetId = params.sheetId;
  var label = params.label || 'Staging';
  try {
    var src = DriveApp.getFileById(sheetId);
    var copy = src.makeCopy('[AGS STAGING] ' + label, DriveApp.getRootFolder());
    return {
      success: true,
      stagingSheetId: copy.getId(),
      stagingSheetUrl: 'https://docs.google.com/spreadsheets/d/' + copy.getId() + '/edit'
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function _agsDeleteFile(params) {
  try {
    DriveApp.getFileById(params.fileId).setTrashed(true);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
`;
