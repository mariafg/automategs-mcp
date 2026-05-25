import fs from 'fs';
import http from 'http';
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import open from 'open';
import { CLASPRC_PATH, CLASP_CLIENT_ID, CLASP_CLIENT_SECRET } from '../utils/constants.js';
import { findAvailablePort } from '../utils/port.js';

// clasp-cli.js is bundled alongside index.js in dist/.
// We run it with process.execPath (the Node.js binary running this server)
// so no system PATH or npx is required.
const CLASP_CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), 'clasp-cli.js');

interface ClaspToken {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  token_type?: string;
  scope?: string;
}

interface ClaspRc {
  token: ClaspToken;
}

// Scopes matching what @google/clasp requests
const CLASP_SCOPES = [
  'https://www.googleapis.com/auth/script.projects',
  'https://www.googleapis.com/auth/script.webapp.deploy',
  'https://www.googleapis.com/auth/script.deployments',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/service.management',
  'https://www.googleapis.com/auth/logging.read',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'openid',
];

export function isClaspAuthenticated(): boolean {
  if (!fs.existsSync(CLASPRC_PATH)) return false;
  try {
    const rc = JSON.parse(fs.readFileSync(CLASPRC_PATH, 'utf8')) as ClaspRc;
    return !!(rc.token?.access_token && rc.token?.refresh_token);
  } catch {
    return false;
  }
}

export async function getAccessToken(): Promise<string> {
  const rc = JSON.parse(fs.readFileSync(CLASPRC_PATH, 'utf8')) as ClaspRc;
  const token = rc.token;

  if (token.expiry_date > Date.now() + 60_000) {
    return token.access_token;
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLASP_CLIENT_ID,
      client_secret: CLASP_CLIENT_SECRET,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }

  const refreshed = (await res.json()) as Partial<ClaspToken>;
  const updatedToken: ClaspToken = {
    ...token,
    access_token: refreshed.access_token ?? token.access_token,
    expiry_date: refreshed.expiry_date ?? Date.now() + 3600_000,
  };

  rc.token = updatedToken;
  fs.writeFileSync(CLASPRC_PATH, JSON.stringify(rc, null, 2));

  return updatedToken.access_token;
}

/**
 * Opens the Google OAuth consent screen in the user's browser,
 * starts a local HTTP server to receive the callback,
 * exchanges the code for tokens, and writes ~/.clasprc.json.
 * Never touches stdin/stdout — safe for use inside an MCP stdio process.
 *
 * @param onUrl  Optional callback fired with the auth URL as soon as the
 *               callback server is ready.  Use this to surface the URL in
 *               tool responses when the browser cannot open automatically.
 */
export async function runClaspLoginBrowser(onUrl?: (url: string) => void): Promise<void> {
  const port = await findAvailablePort();
  const redirectUri = `http://localhost:${port}`;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/auth');
  authUrl.searchParams.set('client_id', CLASP_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', CLASP_SCOPES.join(' '));
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  // Wait for the auth code on a local callback server
  const code = await new Promise<string>((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      const reply = (status: number, html: string) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        srv.close();
      };

      if (error) {
        reply(400, errorPage(error));
        reject(new Error(`OAuth denied: ${error}`));
        return;
      }
      if (code) {
        reply(200, successPage());
        resolve(code);
      }
    });

    const timeout = setTimeout(() => {
      srv.close();
      reject(new Error('OAuth login timed out after 10 minutes.'));
    }, 10 * 60 * 1000);

    srv.on('error', (err) => { clearTimeout(timeout); reject(err); });

    srv.listen(port, 'localhost', () => {
      const urlStr = authUrl.toString();
      console.error(`[AutomateGS] OAuth callback server listening on port ${port}`);
      console.error(`[AutomateGS] Auth URL: ${urlStr}`);

      // Notify the caller so it can surface the URL in tool responses.
      if (onUrl) onUrl(urlStr);

      // Try to open the browser.  In DXT/Electron environments the PATH may
      // not include the directories where `open` (macOS) or `xdg-open` (Linux)
      // live, so we try the absolute path first and fall back to the `open`
      // package as a second attempt.
      const tryOpen = (cmd: string, args: string[]) =>
        new Promise<void>((res) => execFile(cmd, args, () => res()));

      const platform = process.platform;
      const openFns: Array<() => Promise<void>> = platform === 'darwin'
        ? [
            () => tryOpen('/usr/bin/open', [urlStr]),
            () => open(urlStr),
          ]
        : platform === 'linux'
          ? [
              () => tryOpen('/usr/bin/xdg-open', [urlStr]),
              () => open(urlStr),
            ]
          : [() => open(urlStr)];

      (async () => {
        for (const fn of openFns) {
          try { await fn(); return; } catch { /* try next */ }
        }
        console.error(`[AutomateGS] Could not open browser automatically. Open manually: ${urlStr}`);
      })();
    });
  });

  // Exchange the authorization code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLASP_CLIENT_ID,
      client_secret: CLASP_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    scope: string;
  };

  const claspRc: ClaspRc = {
    token: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: Date.now() + tokens.expires_in * 1000,
      token_type: tokens.token_type,
      scope: tokens.scope,
    },
  };

  fs.writeFileSync(CLASPRC_PATH, JSON.stringify(claspRc, null, 2));
  console.error('[AutomateGS] Google authentication complete.');
}

export async function testClaspConnection(): Promise<
  'ok' | 'not_authenticated' | 'api_disabled'
> {
  try {
    await runClasp(['list'], process.cwd());
    return 'ok';
  } catch (err) {
    const msg = String(err);
    if (
      msg.includes('403') ||
      msg.toLowerCase().includes('api not enabled') ||
      msg.toLowerCase().includes('access not configured')
    ) {
      return 'api_disabled';
    }
    return 'not_authenticated';
  }
}

export async function runClasp(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    // stdin:'ignore' — clasp would block waiting for input that never arrives.
    // PATH prepend — dist/ contains a no-op git stub so clasp never triggers
    // the macOS "Install Xcode Command Line Tools" dialog, which blocks the
    // process until the user dismisses it.
    const distDir = dirname(CLASP_CLI_PATH);
    const env = {
      ...process.env,
      PATH: distDir + (process.platform === 'win32' ? ';' : ':') + (process.env.PATH ?? ''),
    };
    const proc = spawn(process.execPath, [CLASP_CLI_PATH, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.stderr.on('data', (c: Buffer) => errChunks.push(c));

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('clasp command timed out after 60 seconds'));
    }, 60_000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(new Error(Buffer.concat(errChunks).toString('utf8') || `clasp exited with code ${code}`));
    });

    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// ---------------------------------------------------------------------------
// OAuth response pages
// ---------------------------------------------------------------------------

function successPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>AutomateGS — Authenticated</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; background: #f9fafb; }
    .card { background: #fff; border-radius: 12px; padding: 48px 56px;
            box-shadow: 0 1px 3px rgba(0,0,0,.1); text-align: center; max-width: 420px; }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { margin: 0 0 8px; font-size: 22px; color: #111; }
    p  { margin: 0; color: #555; font-size: 15px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>Connected to Google</h1>
    <p>AutomateGS is authenticated. You can close this tab and return to Claude.</p>
  </div>
</body>
</html>`;
}

function errorPage(error: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>AutomateGS — Authentication Failed</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; background: #f9fafb; }
    .card { background: #fff; border-radius: 12px; padding: 48px 56px;
            box-shadow: 0 1px 3px rgba(0,0,0,.1); text-align: center; max-width: 420px; }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { margin: 0 0 8px; font-size: 22px; color: #111; }
    p  { margin: 0; color: #555; font-size: 15px; line-height: 1.5; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">❌</div>
    <h1>Authentication failed</h1>
    <p>Google returned: <code>${error}</code><br><br>Please try again in Claude.</p>
  </div>
</body>
</html>`;
}
