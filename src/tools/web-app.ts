import { getAccessToken } from '../auth/clasp.js';
import type { ExecutionResult } from '../registry/types.js';
import { EXECUTION_TIMEOUT_MS } from '../utils/constants.js';

export async function callWebApp(params: {
  webAppUrl: string;
  fnName: string;
  parameters: Record<string, unknown>;
}): Promise<ExecutionResult> {
  const accessToken = await getAccessToken();
  const url = `${params.webAppUrl}?access_token=${encodeURIComponent(accessToken)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn: params.fnName, params: params.parameters }),
      signal: AbortSignal.timeout(EXECUTION_TIMEOUT_MS),
    });

    if (!res.ok) {
      return { status: 'error', error: `HTTP ${res.status}: ${await res.text()}` };
    }

    return (await res.json()) as ExecutionResult;
  } catch (err) {
    return { status: 'error', error: String(err) };
  }
}
