import { SYSTEM_FUNCTIONS_CODE } from './system-functions.js';

export const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/script.webapp.deploy',
];

// Every script project declares this full superset of scopes from its very
// first deployment, regardless of which functions it currently has. Google
// only reliably shows the owner an authorization screen for a script's
// *declared* scopes on first deploy / first authorize — adding scopes later
// via a redeploy doesn't reliably re-trigger that screen for an
// already-"authorized" web app (executeAs USER_DEPLOYING just runs the
// script and lets the privileged call throw at runtime instead). Declaring
// everything upfront means there's only ever one authorization needed, no
// matter what functions get added afterwards.
export const ALL_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/script.webapp.deploy',
  'https://www.googleapis.com/auth/script.scriptapp',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/script.send_mail',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/forms',
];

export function buildScriptCode(userCode: string): string {
  return SYSTEM_FUNCTIONS_CODE.trim() + '\n\n' + userCode;
}

export function buildAppsScriptManifest(oauthScopes: string[] = []): Record<string, unknown> {
  const allScopes = Array.from(new Set([...ALL_SCOPES, ...oauthScopes]));
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
