import fs from 'fs';
import http from 'http';
import os from 'os';
import crypto from 'crypto';
import { spawn, execFile } from 'child_process';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';
import open from 'open';
import { CLASPRC_PATH, CLASP_CLIENT_ID, CLASP_CLIENT_SECRET, DEBUG_LOG_PATH } from '../utils/constants.js';
import { findAvailablePort } from '../utils/port.js';

// clasp-cli.mjs is bundled alongside index.js in dist/. The .mjs extension
// forces ESM parsing even when spawned with a real system Node that has no
// package.json nearby to declare "type": "module".
const CLASP_CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), 'clasp-cli.mjs');

const DBG_LOG = DEBUG_LOG_PATH;
function dbg(msg: string): void {
  try { fs.appendFileSync(DBG_LOG, `${new Date().toISOString()} [clasp] ${msg}\n`); } catch {}
}

// ---------------------------------------------------------------------------
// Portable Node — a private, sandboxed Node.js AutomateGS can download for
// itself when no system Node.js is found. No admin password, no Homebrew,
// no Xcode CLT required: just an HTTPS download + tar extraction into our
// own app-support directory. Installed once, reused on every future run.
// ---------------------------------------------------------------------------
const PORTABLE_NODE_VERSION = 'v20.18.1';
const PORTABLE_NODE_DIR = join(os.homedir(), '.automategs', 'node');
// Windows node-*.zip releases put node.exe at the archive root; every other
// platform's tarball nests it under bin/.
export const PORTABLE_NODE_BIN = process.platform === 'win32'
  ? join(PORTABLE_NODE_DIR, 'node.exe')
  : join(PORTABLE_NODE_DIR, 'bin', 'node');

function portableNodePlatformArch(): { platform: string; arch: string; ext: 'tar.gz' | 'zip' } {
  const platform = process.platform === 'darwin' ? 'darwin'
    : process.platform === 'linux' ? 'linux'
    : process.platform === 'win32' ? 'win'
    : null;
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  if (!platform || !arch) {
    throw new Error(
      `AutomateGS cannot auto-install Node.js on ${process.platform}/${process.arch}. ` +
      'Please install Node.js manually from https://nodejs.org.'
    );
  }
  return { platform, arch, ext: platform === 'win' ? 'zip' : 'tar.gz' };
}

/**
 * Downloads the official Node.js release tarball for this machine, verifies
 * it against nodejs.org's published SHA256 checksum, and extracts it into
 * PORTABLE_NODE_DIR. Returns the path to the resulting `node` binary.
 */
export async function installPortableNode(): Promise<string> {
  if (fs.existsSync(PORTABLE_NODE_BIN) && nodeMinVersion(PORTABLE_NODE_BIN, 16)) {
    dbg(`installPortableNode: already installed at ${PORTABLE_NODE_BIN}`);
    return PORTABLE_NODE_BIN;
  }

  const { platform, arch, ext } = portableNodePlatformArch();
  const fileName = `node-${PORTABLE_NODE_VERSION}-${platform}-${arch}.${ext}`;
  const baseUrl = `https://nodejs.org/dist/${PORTABLE_NODE_VERSION}`;

  dbg(`installPortableNode: downloading ${baseUrl}/${fileName}`);
  const [tarballRes, shasumsRes] = await Promise.all([
    fetch(`${baseUrl}/${fileName}`),
    fetch(`${baseUrl}/SHASUMS256.txt`),
  ]);
  if (!tarballRes.ok) throw new Error(`Failed to download Node.js: ${tarballRes.status}`);
  if (!shasumsRes.ok) throw new Error(`Failed to download Node.js checksums: ${shasumsRes.status}`);

  const tarballBuf = Buffer.from(await tarballRes.arrayBuffer());
  const shasumsText = await shasumsRes.text();
  const expectedLine = shasumsText.split('\n').find((l) => l.trim().endsWith(fileName));
  const expectedHash = expectedLine?.split(/\s+/)[0];
  if (!expectedHash) throw new Error(`Could not find checksum for ${fileName} in SHASUMS256.txt`);

  const actualHash = crypto.createHash('sha256').update(tarballBuf).digest('hex');
  if (actualHash !== expectedHash) {
    throw new Error(`Node.js download checksum mismatch (expected ${expectedHash}, got ${actualHash})`);
  }
  dbg('installPortableNode: checksum verified');

  fs.rmSync(PORTABLE_NODE_DIR, { recursive: true, force: true });
  fs.mkdirSync(PORTABLE_NODE_DIR, { recursive: true });

  const tmpArchive = join(os.tmpdir(), fileName);
  fs.writeFileSync(tmpArchive, tarballBuf);

  if (ext === 'zip') {
    // Windows ships no `tar` that reliably handles .zip; PowerShell's
    // Expand-Archive is present on every supported Windows version.
    // It extracts into a single top-level node-vX.Y.Z-win-<arch> folder
    // (there's no --strip-components equivalent), so extract to a staging
    // dir first and move that folder's contents up into PORTABLE_NODE_DIR.
    const stagingDir = join(os.tmpdir(), `automategs-node-extract-${Date.now()}`);
    await new Promise<void>((resolve, reject) => {
      const ps = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${tmpArchive}' -DestinationPath '${stagingDir}' -Force`,
      ]);
      ps.on('error', reject);
      ps.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Expand-Archive exited with code ${code}`))));
    });
    const extractedRoot = join(stagingDir, fileName.replace(/\.zip$/, ''));
    for (const entry of fs.readdirSync(extractedRoot)) {
      fs.renameSync(join(extractedRoot, entry), join(PORTABLE_NODE_DIR, entry));
    }
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } else {
    await new Promise<void>((resolve, reject) => {
      const tar = spawn('/usr/bin/tar', ['-xzf', tmpArchive, '-C', PORTABLE_NODE_DIR, '--strip-components=1']);
      tar.on('error', reject);
      tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`))));
    });
  }
  fs.rmSync(tmpArchive, { force: true });

  if (!fs.existsSync(PORTABLE_NODE_BIN) || !nodeMinVersion(PORTABLE_NODE_BIN, 16)) {
    throw new Error('Node.js extraction did not produce a working binary.');
  }
  dbg(`installPortableNode: installed at ${PORTABLE_NODE_BIN}`);
  return PORTABLE_NODE_BIN;
}

// ---------------------------------------------------------------------------
// resolveNode — find a real Node.js binary (not Electron's Claude Helper)
// ---------------------------------------------------------------------------
let _resolvedNode: string | null = null;

// Cheap, process-spawn-free check for whether Xcode Command Line Tools are
// installed. Used to skip the login-shell fallback below, which can touch
// the user's shell rc files and trigger macOS's CLT-install dialog if git
// gets invoked there without CLT present.
function hasXcodeCLT(): boolean {
  return (
    fs.existsSync('/Library/Developer/CommandLineTools/usr/bin/git') ||
    fs.existsSync('/Applications/Xcode.app/Contents/Developer/usr/bin/git')
  );
}

async function resolveNode(): Promise<string> {
  if (_resolvedNode) return _resolvedNode;

  // If process.execPath looks like a real node binary, use it directly.
  const execName = basename(process.execPath).toLowerCase();
  if (execName === 'node' || execName.startsWith('node.exe')) {
    dbg(`resolveNode: process.execPath looks like node → ${process.execPath}`);
    _resolvedNode = process.execPath;
    return _resolvedNode;
  }

  dbg(`resolveNode: process.execPath is NOT node (${process.execPath}), searching…`);

  // Common fixed locations
  const homeDir = process.env.HOME ?? os.homedir();
  const candidates: string[] = [
    // Our own private install — see installPortableNode(). Checked first
    // since we know it's a real, version-checked Node we put there ourselves.
    PORTABLE_NODE_BIN,
  ];

  if (process.platform === 'win32') {
    candidates.push(
      // Default nodejs.org Windows installer location
      `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\nodejs\\node.exe`,
      `${process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\nodejs\\node.exe`,
      // nvm-windows symlinks the active version here
      `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\nodejs\\node.exe`,
      `${process.env.APPDATA ?? ''}\\npm\\node.exe`,
      `${process.env.LOCALAPPDATA ?? ''}\\Programs\\nodejs\\node.exe`,
      `${process.env.NVM_SYMLINK ?? ''}\\node.exe`,
    );
  } else {
    candidates.push(
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      '/usr/bin/node',
      '/opt/local/bin/node', // MacPorts
      // nvm default active version symlink
      `${homeDir}/.nvm/alias/default`,
      `${homeDir}/.volta/bin/node`,
      `${homeDir}/.asdf/shims/node`,
      `${homeDir}/.local/share/fnm/aliases/default/bin/node`,
    );
  }

  // Also probe nvm-style versioned paths
  const nvmDir = process.env.NVM_DIR ?? `${homeDir}/.nvm`;
  const nvmVersionsDir = `${nvmDir}/versions/node`;
  if (fs.existsSync(nvmVersionsDir)) {
    try {
      const versions = fs.readdirSync(nvmVersionsDir).sort().reverse(); // newest first
      for (const v of versions.slice(0, 5)) {
        candidates.push(`${nvmVersionsDir}/${v}/bin/node`);
      }
    } catch { /* ignore */ }
  }

  for (const c of candidates) {
    if (fs.existsSync(c) && nodeMinVersion(c, 16)) {
      dbg(`resolveNode: found candidate ${c}`);
      _resolvedNode = c;
      return c;
    }
  }

  // Login shell fallback — macOS PATH is not inherited in DXT processes.
  // A login shell sources ~/.zprofile and ~/.bash_profile, which typically
  // add Homebrew and nvm to PATH. Skip this if Xcode CLT isn't installed:
  // those rc files commonly shell out to git (prompt themes, version
  // managers), and without CLT present that would trigger macOS's
  // "Install Command Line Developer Tools" dialog. This is also a no-op
  // on Windows, where there's no shell/SHELL concept worth probing and
  // hasXcodeCLT() always returns false anyway.
  if (process.platform !== 'darwin' || !hasXcodeCLT()) {
    dbg('resolveNode: skipping login shell fallback (not macOS, or Xcode CLT not installed)');
  } else {
    const shell = process.env.SHELL ?? '/bin/sh';
    try {
      const nodePath = await new Promise<string>((resolve, reject) => {
        execFile(shell, ['-l', '-c', 'which node 2>/dev/null || command -v node 2>/dev/null'], {
          timeout: 5000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        }, (err, stdout) => {
          if (err || !stdout.trim()) reject(new Error('which node failed'));
          else resolve(stdout.trim().split('\n')[0]);
        });
      });
      if (nodePath && fs.existsSync(nodePath) && nodeMinVersion(nodePath, 16)) {
        dbg(`resolveNode: login shell found node at ${nodePath}`);
        _resolvedNode = nodePath;
        return nodePath;
      }
    } catch (e) {
      dbg(`resolveNode: login shell lookup failed: ${e}`);
    }
  }

  // Spawning Electron's own executable as a stand-in Node binary is not a
  // safe last resort: even with ELECTRON_RUN_AS_NODE=1, launching it outside
  // its app bundle can still try to start its GPU/helper process and crash
  // fatally ("Unable to find helper app"). Instead, automatically download a
  // private, checksum-verified copy of Node.js from nodejs.org — no admin
  // password or system-wide install needed, and no extra confirmation step.
  dbg(`resolveNode: no real Node.js binary found (process.execPath = ${process.execPath}), auto-installing…`);
  try {
    const installed = await installPortableNode();
    _resolvedNode = installed;
    return installed;
  } catch (e) {
    dbg(`resolveNode: auto-install failed: ${e}`);
    throw new Error(
      'AutomateGS needs Node.js to run and could not download one automatically ' +
      `(${e instanceof Error ? e.message : String(e)}). ` +
      'Please install Node.js manually from https://nodejs.org and try again.'
    );
  }
}

function nodeMinVersion(nodePath: string, minMajor: number): boolean {
  try {
    const { execFileSync } = require('child_process') as typeof import('child_process');
    const out = (execFileSync(nodePath, ['--version'], {
      timeout: 3000,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }) as Buffer).toString().trim();
    const major = parseInt(out.replace(/^v/, '').split('.')[0], 10);
    dbg(`resolveNode: ${nodePath} is ${out} (major=${major})`);
    return major >= minMajor;
  } catch {
    return false;
  }
}

interface ClaspToken {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  token_type?: string;
  scope?: string;
}

// clasp v3's on-disk credential format: a map of user keys (we only ever
// use 'default') to StoredCredential objects, read/written by clasp's own
// FileCredentialStore. clasp v2 used a flatter { token: {...} } shape —
// writing that here makes clasp v3 unable to find credentials at all
// ("No credentials found"), since its legacy-format fallback requires
// fields (oauth2ClientSettings, or top-level access_token) that the old
// shape didn't carry either.
interface ClaspRcV3 {
  tokens: {
    default?: ClaspToken & { type: 'authorized_user'; client_id: string; client_secret: string };
    [user: string]: unknown;
  };
}

// Scopes matching what @google/clasp requests, plus the broad Drive scope
// (not drive.file — see trashScriptProject below for why) needed to trash
// script projects by file ID.
const CLASP_SCOPES = [
  'https://www.googleapis.com/auth/script.projects',
  'https://www.googleapis.com/auth/script.webapp.deploy',
  'https://www.googleapis.com/auth/script.deployments',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/service.management',
  'https://www.googleapis.com/auth/logging.read',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'openid',
];

export function isClaspAuthenticated(): boolean {
  if (!fs.existsSync(CLASPRC_PATH)) return false;
  try {
    const rc = JSON.parse(fs.readFileSync(CLASPRC_PATH, 'utf8')) as ClaspRcV3;
    const token = rc.tokens?.default;
    return !!(token?.access_token && token?.refresh_token);
  } catch {
    return false;
  }
}

export async function getAccessToken(): Promise<string> {
  const rc = JSON.parse(fs.readFileSync(CLASPRC_PATH, 'utf8')) as ClaspRcV3;
  const token = rc.tokens.default;
  if (!token) {
    throw new Error('No credentials found.');
  }

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
  const updatedToken = {
    ...token,
    access_token: refreshed.access_token ?? token.access_token,
    expiry_date: refreshed.expiry_date ?? Date.now() + 3600_000,
  };

  rc.tokens.default = updatedToken;
  fs.writeFileSync(CLASPRC_PATH, JSON.stringify(rc, null, 2));

  return updatedToken.access_token;
}

function hasGrantedScope(scope: string): boolean {
  try {
    const rc = JSON.parse(fs.readFileSync(CLASPRC_PATH, 'utf8')) as ClaspRcV3;
    const granted = rc.tokens.default?.scope ?? '';
    return granted.split(' ').includes(scope);
  } catch {
    return false;
  }
}

// A standalone Apps Script project's scriptId is also its Drive file ID.
// Trashing it (rather than permanently deleting) lets the owner recover it
// from Drive's trash within Google's normal 30-day window. This requires the
// broad drive scope: drive.file only covers files created/opened through the
// Drive API itself, and project creation goes through the Apps Script API
// instead, so files clasp creates aren't covered by drive.file. Accounts
// that authenticated before drive scope was added to CLASP_SCOPES need a
// one-time re-consent — detect that here and run it inline rather than
// failing, so the trash silently starts working again after this first call.
export async function trashScriptProject(scriptId: string): Promise<void> {
  if (!hasGrantedScope('https://www.googleapis.com/auth/drive')) {
    await runClaspLoginBrowser();
  }

  const token = await getAccessToken();
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${scriptId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ trashed: true }),
  });
  if (!res.ok) {
    throw new Error(`Failed to trash Drive file ${scriptId}: HTTP ${res.status} ${await res.text()}`);
  }
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

  const claspRc: ClaspRcV3 = {
    tokens: {
      default: {
        type: 'authorized_user',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: Date.now() + tokens.expires_in * 1000,
        token_type: tokens.token_type,
        scope: tokens.scope,
        client_id: CLASP_CLIENT_ID,
        client_secret: CLASP_CLIENT_SECRET,
      },
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
  const nodeExec = await resolveNode();

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const env = {
      ...process.env,
      PATH: '',
      GIT_TERMINAL_PROMPT: '0',
      GIT_EXEC_PATH: '/nonexistent',
      // When process.execPath is Electron (Claude Desktop DXT), this flag
      // makes it behave as plain Node.js — skipping GPU/network init that
      // otherwise causes ~77s startup delay.
      ELECTRON_RUN_AS_NODE: '1',
    };

    dbg(`runClasp START: node=${nodeExec} clasp=${CLASP_CLI_PATH}`);
    dbg(`runClasp CMD: ${args.join(' ')} cwd=${cwd}`);
    dbg(`runClasp ENV.PATH="${env.PATH}" HOME="${env.HOME}"`);

    const proc = spawn(nodeExec, [CLASP_CLI_PATH, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    dbg(`runClasp pid=${proc.pid}`);

    proc.stdout.on('data', (c: Buffer) => {
      chunks.push(c);
      dbg(`stdout: ${c.toString().trim()}`);
    });
    proc.stderr.on('data', (c: Buffer) => {
      errChunks.push(c);
      dbg(`stderr: ${c.toString().trim()}`);
    });

    const timer = setTimeout(() => {
      dbg(`TIMEOUT after 60s — stdout so far: ${Buffer.concat(chunks).toString().slice(0, 500)}`);
      dbg(`TIMEOUT stderr so far: ${Buffer.concat(errChunks).toString().slice(0, 500)}`);
      proc.kill();
      reject(new Error('clasp command timed out after 60 seconds'));
    }, 60_000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      dbg(`runClasp EXIT code=${code}`);
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(new Error(Buffer.concat(errChunks).toString('utf8') || `clasp exited with code ${code}`));
    });

    proc.on('error', (err) => {
      dbg(`runClasp ERROR: ${err.message}`);
      clearTimeout(timer);
      reject(err);
    });
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
