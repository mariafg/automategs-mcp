import { SYSTEM_FUNCTIONS } from './system-functions.js';

const BASE_SCOPES = [
  'https://www.googleapis.com/auth/script.scriptapp',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/script.external_request',
];

export function generateUserFunction(params: {
  taskDescription: string;
  fnName: string;
  isEntryPoint: boolean;
  usesSpreadsheet: boolean;
}): string {
  const { taskDescription, fnName, isEntryPoint, usesSpreadsheet } = params;

  if (isEntryPoint && usesSpreadsheet) {
    return `function ${fnName}(params) {
  _agsLog('${fnName} started');
  var sheetId = params.sheetId;
  var ss = SpreadsheetApp.openById(sheetId);
  // TODO: ${taskDescription}
  _agsLog('${fnName} complete');
  return { success: true, rowsAffected: 0 };
}`;
  }

  if (isEntryPoint && !usesSpreadsheet) {
    return `function ${fnName}(params) {
  _agsLog('${fnName} started');
  // TODO: ${taskDescription}
  _agsLog('${fnName} complete');
  return { success: true };
}`;
  }

  return `function ${fnName}() {
  // TODO: ${taskDescription}
}`;
}

export function generateAppsScriptManifest(params: {
  title: string;
  timezone?: string;
  scopes: string[];
}): object {
  const allScopes = Array.from(new Set([...BASE_SCOPES, ...params.scopes]));
  return {
    timeZone: params.timezone ?? 'Europe/Madrid',
    dependencies: {},
    exceptionLogging: 'STACKDRIVER',
    runtimeVersion: 'V8',
    webapp: {
      executeAs: 'USER_DEPLOYING',
      access: 'MYSELF',
    },
    oauthScopes: allScopes,
  };
}

const USER_AUTOMATIONS_SEPARATOR = '\n\n// ─── User Automations ───\n\n';

export function assembleCodeGs(userFunctions: string[]): string {
  return SYSTEM_FUNCTIONS + USER_AUTOMATIONS_SEPARATOR + userFunctions.join('\n\n');
}
