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
