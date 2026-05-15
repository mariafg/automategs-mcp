export const SYSTEM_FUNCTIONS = `
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var fn = body.fn;
    var params = body.params || {};
    var result;
    if (fn === '_ags_cp') result = _ags_cp(params);
    else if (fn === '_ags_del') result = _ags_del(params);
    else if (fn === '_ags_air') result = _ags_air(params);
    else return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', error: 'Unknown function: ' + fn }))
      .setMimeType(ContentService.MimeType.JSON);
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'success', result: result }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function _ags_cp(params) {
  var sourceId = params.sourceId;
  var title = params.title || 'AutomateGS Preview';
  var file = DriveApp.getFileById(sourceId).makeCopy('[Preview] ' + title);
  return {
    tempSheetId: file.getId(),
    tempSheetUrl: 'https://docs.google.com/spreadsheets/d/' + file.getId() + '/edit'
  };
}

function _ags_del(params) {
  var fileId = params.fileId;
  try {
    DriveApp.getFileById(fileId).setTrashed(true);
    return { success: true };
  } catch(err) {
    return { success: false, error: err.message };
  }
}

function _ags_air(params) {
  var spreadsheetId = params.spreadsheetId;
  var donorIds = params.donorIds || [];
  var authorized = 0;
  var skipped = 0;
  for (var i = 0; i < donorIds.length; i++) {
    var url =
      'https://docs.google.com/spreadsheets/d/' +
      spreadsheetId +
      '/externaldata/addimportrangepermissions' +
      '?donorDocId=' + donorIds[i];
    var backoff = [2000, 4000, 8000];
    var success = false;
    for (var attempt = 0; attempt <= backoff.length; attempt++) {
      try {
        var resp = UrlFetchApp.fetch(url, {
          method: 'post',
          headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
          muteHttpExceptions: true
        });
        if (resp.getResponseCode() >= 200 && resp.getResponseCode() < 300) {
          success = true;
          break;
        }
      } catch(err) {
        if (attempt < backoff.length) {
          Utilities.sleep(backoff[attempt]);
        }
      }
    }
    if (success) authorized++;
    else skipped++;
    if (i < donorIds.length - 1) Utilities.sleep(500);
  }
  return { authorized: authorized, skipped: skipped };
}
`;
