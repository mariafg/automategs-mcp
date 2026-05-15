import fs from 'fs';
import { spawn } from 'child_process';
import { CLASPRC_PATH, CLASP_CLIENT_ID, CLASP_CLIENT_SECRET } from '../utils/constants.js';

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

export async function runClaspLogin(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('npx', ['clasp', 'login'], { stdio: 'inherit' });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`clasp login exited with code ${code}`));
    });
    proc.on('error', reject);
  });

  if (!fs.existsSync(CLASPRC_PATH)) {
    throw new Error('clasp login completed but .clasprc.json was not created');
  }
}

export async function testClaspConnection(): Promise<
  'ok' | 'not_authenticated' | 'api_disabled'
> {
  try {
    await runClasp(['list'], process.cwd());
    return 'ok';
  } catch (err) {
    const msg = String(err);
    if (msg.includes('403') || msg.toLowerCase().includes('api not enabled') || msg.toLowerCase().includes('access not configured')) {
      return 'api_disabled';
    }
    return 'not_authenticated';
  }
}

export async function runClasp(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const proc = spawn('npx', ['clasp', ...args], { cwd });

    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('clasp command timed out after 60 seconds'));
    }, 60_000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString('utf8'));
      } else {
        reject(new Error(Buffer.concat(errChunks).toString('utf8') || `clasp exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
