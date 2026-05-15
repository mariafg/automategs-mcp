export const SYSTEM_FUNCTIONS = `var _AGS_LOGS = [];

function _agsLog(message) {
  _AGS_LOGS.push({
    t: new Date().toISOString(),
    m: String(message)
  });
}

function doGet(e) {
  var action = e && e.parameter && e.parameter.action;
  if (action === 'check') {
    return _ags_chk(e.parameter.id);
  }
  var callbackUrl = e && e.parameter && e.parameter.callback;
  var existing = ScriptApp.getProjectTriggers();
  if (existing.length === 0) {
    ScriptApp.newTrigger('_ags_td')
      .timeBased().everyMinutes(1).create();
  }
  PropertiesService.getScriptProperties()
    .setProperty('setupComplete', '1');
  console.log('AUTOMATEGS_SETUP_COMPLETE');
  var result = JSON.stringify({
    status: 'setup_complete',
    triggersInstalled: true
  });
  if (callbackUrl) {
    return HtmlService.createHtmlOutput(
      '<script>window.location="' + callbackUrl +
      '?result=' + encodeURIComponent(result) +
      '"</script>'
    );
  }
  return ContentService.createTextOutput(result)
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  _AGS_LOGS = [];
  var body = JSON.parse(e.postData.contents);
  var fnName = body.function;
  var params = body.parameters !== undefined ?
    body.parameters : [];
  var isUserFn =
    /^[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9]{4}$/.test(fnName);
  var isSysFn = /^_ags_[a-zA-Z0-9]+$/.test(fnName);
  if (!fnName || (!isUserFn && !isSysFn)) {
    return ContentService.createTextOutput(
      JSON.stringify({ error: 'Invalid function: ' + fnName })
    ).setMimeType(ContentService.MimeType.JSON);
  }
  if (!(fnName in this) ||
      typeof this[fnName] !== 'function') {
    return ContentService.createTextOutput(
      JSON.stringify({ error: fnName + ' not found' })
    ).setMimeType(ContentService.MimeType.JSON);
  }
  try {
    var result = this[fnName](params);
    return ContentService.createTextOutput(
      JSON.stringify({
        status: 'success',
        result: result,
        logs: _AGS_LOGS
      })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService.createTextOutput(
      JSON.stringify({
        status: 'error',
        error: err.message,
        logs: _AGS_LOGS
      })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function _ags_td() {
  var props = PropertiesService.getScriptProperties();
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    var t = triggers[i];
    if (t.getHandlerFunction() !== '_ags_td') continue;
    var tid = t.getUniqueId();
    var fnName = props.getProperty('async_fn_' + tid);
    if (!fnName) continue;
    var params = JSON.parse(
      props.getProperty('async_params_' + tid) || '[]'
    );
    var executionId =
      props.getProperty('async_execid_' + tid);
    _AGS_LOGS = [];
    try {
      var result = this[fnName](params);
      props.setProperty(
        'async_result_' + executionId,
        JSON.stringify({
          status: 'success',
          result: result,
          logs: _AGS_LOGS
        })
      );
    } catch(err) {
      props.setProperty(
        'async_result_' + executionId,
        JSON.stringify({
          status: 'error',
          error: err.message,
          logs: _AGS_LOGS
        })
      );
    }
    if (props.getProperty('async_once_' + tid) === '1') {
      ScriptApp.deleteTrigger(t);
      props.deleteProperty('async_fn_' + tid);
      props.deleteProperty('async_params_' + tid);
      props.deleteProperty('async_execid_' + tid);
      props.deleteProperty('async_once_' + tid);
    }
  }
}

function _ags_chk(executionId) {
  var props = PropertiesService.getScriptProperties();
  var result =
    props.getProperty('async_result_' + executionId);
  if (!result) {
    return ContentService.createTextOutput(
      JSON.stringify({
        status: 'pending',
        executionId: executionId
      })
    ).setMimeType(ContentService.MimeType.JSON);
  }
  props.deleteProperty('async_result_' + executionId);
  return ContentService.createTextOutput(result)
    .setMimeType(ContentService.MimeType.JSON);
}

function _ags_trg(params) {
  var fnName = params.fnName;
  var fnParams = params.fnParams;
  var executionId = params.executionId;
  var trigger = ScriptApp.newTrigger('_ags_td')
    .timeBased().after(60 * 1000).create();
  var tid = trigger.getUniqueId();
  var props = PropertiesService.getScriptProperties();
  props.setProperty('async_fn_' + tid, fnName);
  props.setProperty('async_params_' + tid,
    JSON.stringify(fnParams));
  props.setProperty('async_execid_' + tid, executionId);
  props.setProperty('async_once_' + tid, '1');
  return { executionId: executionId, triggerId: tid };
}

function _ags_ct(params) {
  var fnName = params.fnName;
  var freq = params.frequency;
  var interval = params.interval || 1;
  var hour = params.hour !== undefined ? params.hour : 9;
  var dow = params.dayOfWeek || 'MONDAY';
  var dom = params.dayOfMonth || 1;
  var fnParams = params.params || [];
  var builder = ScriptApp.newTrigger('_ags_td').timeBased();
  if (freq === 'minutely') builder.everyMinutes(interval);
  else if (freq === 'hourly') builder.everyHours(interval);
  else if (freq === 'daily')
    builder.everyDays(1).atHour(hour);
  else if (freq === 'weekly')
    builder.everyWeeks(1)
      .onWeekDay(ScriptApp.WeekDay[dow]).atHour(hour);
  else if (freq === 'monthly')
    builder.everyMonths(1).onMonthDay(dom).atHour(hour);
  var trigger = builder.create();
  var tid = trigger.getUniqueId();
  var props = PropertiesService.getScriptProperties();
  props.setProperty('trigger_fn_' + tid, fnName);
  props.setProperty('trigger_params_' + tid,
    JSON.stringify(fnParams));
  return { triggerId: tid, fnName: fnName, frequency: freq };
}

function _ags_dt(params) {
  var triggerId = params.triggerId;
  var triggers = ScriptApp.getProjectTriggers();
  var found = false;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getUniqueId() === triggerId) {
      ScriptApp.deleteTrigger(triggers[i]);
      found = true;
    }
  }
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('trigger_fn_' + triggerId);
  props.deleteProperty('trigger_params_' + triggerId);
  return { deleted: found };
}

function _ags_lt() {
  var triggers = ScriptApp.getProjectTriggers();
  var props = PropertiesService.getScriptProperties();
  var result = [];
  for (var i = 0; i < triggers.length; i++) {
    var t = triggers[i];
    var tid = t.getUniqueId();
    result.push({
      triggerId: tid,
      handlerFunction: t.getHandlerFunction(),
      fnName: props.getProperty('trigger_fn_' + tid) || null
    });
  }
  return result;
}

function _ags_cp(params) {
  var file = DriveApp.getFileById(params.sourceId);
  var copy = file.makeCopy(
    '[STAGING] ' + params.title + ' ' +
    new Date().toISOString()
  );
  return {
    tempSheetId: copy.getId(),
    tempSheetUrl:
      'https://docs.google.com/spreadsheets/d/' +
      copy.getId()
  };
}

function _ags_del(params) {
  DriveApp.getFileById(params.fileId).setTrashed(true);
  return { deleted: true };
}`;
