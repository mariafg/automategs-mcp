import { SYSTEM_FUNCTIONS_CODE } from './system-functions.js';

// Nothing is forced on every script — scopes are exactly what the function
// (or template) actually needs, sourced via oauthScopes. SPREADSHEETS_SCOPE
// and DRIVE_SCOPE are auto-added only for automations whose usesSpreadsheet
// flag is set: Drive is needed there too because preview_automation's
// staging-copy workflow (_agsMakeStagingCopy / _agsDeleteFile in
// system-functions.ts) operates on the user's sheet by file ID, which only
// works under the broad Drive scope, not drive.file.
export const DEFAULT_SCOPES: string[] = [];
export const SPREADSHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

export function buildScriptCode(userCode: string): string {
  return SYSTEM_FUNCTIONS_CODE.trim() + '\n\n' + userCode;
}

export function buildAppsScriptManifest(oauthScopes: string[] = []): Record<string, unknown> {
  const allScopes = Array.from(new Set(oauthScopes));
  return {
    timeZone: 'America/New_York',
    dependencies: {},
    exceptionLogging: 'STACKDRIVER',
    runtimeVersion: 'V8',
    webapp: {
      executeAs: 'USER_DEPLOYING',
      access: 'ANYONE_ANONYMOUS',
    },
    oauthScopes: allScopes,
  };
}

export function makeFunctionCode(
  fnName: string,
  body: string,
  usesSpreadsheet: boolean,
): string {
  if (usesSpreadsheet) {
    return `function ${fnName}(params) {\n${body}\n}`;
  }
  return `function ${fnName}(params) {\n${body}\n}`;
}
