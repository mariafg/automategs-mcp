import { getSecret, storeSecret } from './keychain.js';
import { GITHUB_CLIENT_ID } from '../utils/constants.js';

export async function isGithubConnected(): Promise<boolean> {
  const token = await getSecret('github-token');
  return token !== null;
}

export async function startGithubDeviceFlow(): Promise<{
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  interval: number;
}> {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: 'repo',
    }),
  });

  if (!res.ok) {
    throw new Error(`GitHub device flow failed: ${res.status}`);
  }

  const data = (await res.json()) as {
    user_code: string;
    verification_uri: string;
    device_code: string;
    interval: number;
  };

  return {
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    deviceCode: data.device_code,
    interval: data.interval,
  };
}

export async function pollGithubDeviceFlow(
  deviceCode: string,
  interval: number,
): Promise<boolean> {
  const deadline = Date.now() + 5 * 60 * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));

    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    if (!res.ok) continue;

    const data = (await res.json()) as {
      access_token?: string;
      error?: string;
    };

    if (data.access_token) {
      await storeSecret('github-token', data.access_token);

      const userRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      if (userRes.ok) {
        const user = (await userRes.json()) as { login: string };
        await storeSecret('github-username', user.login);
      }

      return true;
    }

    if (data.error && data.error !== 'authorization_pending' && data.error !== 'slow_down') {
      return false;
    }
  }

  return false;
}

export async function getGithubToken(): Promise<string | null> {
  return getSecret('github-token');
}

export async function getGithubUsername(): Promise<string | null> {
  return getSecret('github-username');
}
