import { SYSTEM_FUNCTIONS_CODE } from './system-functions.js';

export const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/script.webapp.deploy',
];

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
