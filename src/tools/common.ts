import fs from 'fs';
import path from 'path';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import open from 'open';
import { runClasp, getAccessToken } from '../auth/clasp.js';
import { SCRIPTS_DIR, EXECUTION_TIMEOUT_MS } from '../utils/constants.js';
import { buildScriptCode, buildAppsScriptManifest, DEFAULT_SCOPES } from '../gas/template.js';
import type { Registry, Tier } from '../registry/types.js';

export type Content = { type: 'text'; text: string };
export type ToolResult = { content: Content[] };
export type ToolContext = { registry: Registry; tier: Tier };

export function text(obj: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

export function requireTier(
  actual: Tier,
  required: Tier,
  feature: string,
): void {
  const order: Tier[] = ['free', 'pro', 'agency'];
  if (order.indexOf(actual) < order.indexOf(required)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `${feature} requires ${required} plan (current: ${actual}).`,
    );
  }
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

export function uniqueSlug(base: string, existing: string[]): string {
  let slug = base;
  let i = 2;
  while (existing.includes(slug)) slug = `${base}-${i++}`;
  return slug;
}

function parseScriptId(output: string): string | null {
  const m = output.match(/\/d\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function parseDeploymentId(output: string): string | null {
  const m = output.match(/[A-Za-z0-9_-]{30,}/);
  return m ? m[0] : null;
}

export interface SetupResult {
  scriptId: string;
  webAppUrl: string;
  localPath: string;
  deploymentId: string;
}

export async function runProjectSetup(
  slug: string,
  displayName: string,
  oauthScopes: string[],
): Promise<SetupResult> {
  const localPath = path.join(SCRIPTS_DIR, slug);
  fs.mkdirSync(localPath, { recursive: true });

  // Create a standalone Apps Script project. Web app behaviour comes from
  // appsscript.json's `webapp` block (written below by finishProjectSetup)
  // plus `clasp deploy` — clasp v3 removed 'webapp' as a --type value for
  // create-script (only standalone/docs/sheets/slides/forms remain).
  const createOut = await runClasp(
    ['create', '--type', 'standalone', '--title', displayName],
    localPath,
  );

  let scriptId = parseScriptId(createOut);
  if (!scriptId) {
    try {
      const rc = JSON.parse(
        fs.readFileSync(path.join(localPath, '.clasp.json'), 'utf8'),
      ) as { scriptId: string };
      scriptId = rc.scriptId;
    } catch {
      // ignore
    }
  }
  if (!scriptId) {
    throw new McpError(ErrorCode.InternalError, `Could not determine scriptId. clasp output: ${createOut}`);
  }

  return finishProjectSetup(localPath, scriptId, displayName, oauthScopes);
}

export async function finishProjectSetup(
  localPath: string,
  scriptId: string,
  displayName: string,
  oauthScopes: string[],
): Promise<SetupResult> {
  const placeholder = [
    `function placeholder_${slugify(displayName).replace(/-/g, '_')}(params) {`,
    `  _agsLog('Use update_automation to add real code.');`,
    `  return { success: true, summary: 'Placeholder' };`,
    `}`,
  ].join('\n');

  fs.writeFileSync(
    path.join(localPath, 'Code.gs'),
    buildScriptCode(placeholder),
    'utf8',
  );
  fs.writeFileSync(
    path.join(localPath, 'appsscript.json'),
    JSON.stringify(buildAppsScriptManifest([...DEFAULT_SCOPES, ...oauthScopes]), null, 2),
    'utf8',
  );

  await runClasp(['push', '--force'], localPath);

  const deployOut = await runClasp(
    ['deploy', '--description', 'Initial AutomateGS deployment'],
    localPath,
  );

  const deploymentId = parseDeploymentId(deployOut);
  if (!deploymentId) {
    throw new McpError(
      ErrorCode.InternalError,
      `Could not parse deploymentId from: ${deployOut}`,
    );
  }

  const webAppUrl = `https://script.google.com/macros/s/${deploymentId}/exec`;

  // Open the web app URL in the browser immediately after deployment so the
  // owner can complete the one-time Google script-project authorization.
  // Without this step Google returns 403 when the web app tries to execute
  // on the owner's behalf.  Best-effort — don't block on failure.
  open(webAppUrl).catch(() => {
    console.error(`[AutomateGS] Could not auto-open browser. Please visit: ${webAppUrl}`);
  });
  console.error(`[AutomateGS] Opened browser for web app authorization: ${webAppUrl}`);

  return { scriptId, webAppUrl, localPath, deploymentId };
}

export async function deployFunctionCode(
  localPath: string,
  fnName: string,
  functionCode: string,
  oauthScopes: string[],
  deploymentId?: string,
): Promise<string> {
  const existing = fs.existsSync(path.join(localPath, 'Code.gs'))
    ? fs.readFileSync(path.join(localPath, 'Code.gs'), 'utf8')
    : '';

  const systemEnd = existing.indexOf('\n\nfunction ');
  const sysCode = systemEnd > 0 ? existing.slice(0, systemEnd) : '';
  const userBlock = existing.slice(systemEnd > 0 ? systemEnd + 2 : 0);

  const fnRegex = new RegExp(`function\\s+${fnName}\\s*\\(`, 'm');
  let newUserBlock: string;
  if (fnRegex.test(userBlock)) {
    // Replace the existing function
    const start = userBlock.search(fnRegex);
    const before = userBlock.slice(0, start).trimEnd();
    const rest = userBlock.slice(start);
    const end = findFunctionEnd(rest);
    const after = rest.slice(end).replace(/^\n+/, '\n');
    newUserBlock = (before ? before + '\n\n' : '') + functionCode + after;
  } else {
    newUserBlock = (userBlock.trim() ? userBlock.trim() + '\n\n' : '') + functionCode;
  }

  const fullCode = sysCode
    ? sysCode + '\n\n' + newUserBlock.trim()
    : buildScriptCode(newUserBlock.trim());

  fs.writeFileSync(path.join(localPath, 'Code.gs'), fullCode, 'utf8');
  fs.writeFileSync(
    path.join(localPath, 'appsscript.json'),
    JSON.stringify(buildAppsScriptManifest([...DEFAULT_SCOPES, ...oauthScopes]), null, 2),
    'utf8',
  );

  await runClasp(['push', '--force'], localPath);

  const deployArgs = deploymentId
    ? ['deploy', '--deploymentId', deploymentId, '--description', 'AutomateGS update']
    : ['deploy', '--description', 'AutomateGS update'];
  const deployOut = await runClasp(deployArgs, localPath);
  const newId = parseDeploymentId(deployOut);
  return newId ?? (deploymentId ?? '');
}

function findFunctionEnd(code: string): number {
  let depth = 0;
  let inString = false;
  let strChar = '';
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (inString) {
      if (ch === strChar && code[i - 1] !== '\\') inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = true; strChar = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return code.length;
}

export interface WebAppResponse {
  success: boolean;
  result?: unknown;
  error?: string;
  logs?: Array<{ t: string; m: string }>;
}

/**
 * Call a Google Apps Script web app endpoint.
 *
 * Sends the owner's OAuth token as a Bearer header so the call is
 * authenticated even before the owner has completed the one-time browser
 * authorization of the script project.  The web app manifest uses
 * `executeAs: USER_DEPLOYING` + `access: ANYONE_ANONYMOUS`, so anonymous
 * calls also work after the initial browser authorization is done.
 */
export async function callWebApp(
  webAppUrl: string,
  fn: string,
  params: Record<string, unknown>,
): Promise<WebAppResponse> {
  const token = await getAccessToken();

  const res = await fetch(webAppUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ _fn: fn, _params: params }),
    signal: AbortSignal.timeout(EXECUTION_TIMEOUT_MS),
  });

  // Google Apps Script web apps return an HTML login/auth page (with status
  // 200 or 403) when the script project hasn't been authorized by the owner
  // yet.  Detect this before attempting JSON.parse so callers get a clear
  // WEB_APP_AUTH_REQUIRED error instead of a SyntaxError.
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    throw new McpError(
      ErrorCode.InternalError,
      `WEB_APP_AUTH_REQUIRED: ${res.status}`,
    );
  }

  if (!res.ok) {
    throw new McpError(
      ErrorCode.InternalError,
      `Web app returned HTTP ${res.status}: ${await res.text()}`,
    );
  }
  return res.json() as Promise<WebAppResponse>;
}
