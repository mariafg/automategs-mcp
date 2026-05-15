import crypto from 'crypto';
import { getAccessToken } from '../auth/clasp.js';
import type { ExecutionResult } from '../registry/types.js';
import { EXECUTION_TIMEOUT_MS } from '../utils/constants.js';

async function fetchWebApp(params: {
  webAppUrl: string;
  fnName: string;
  parameters?: unknown;
  signal?: AbortSignal;
}): Promise<ExecutionResult> {
  const token = await getAccessToken();
  const body = JSON.stringify({
    function: params.fnName,
    parameters: params.parameters ?? [],
  });

  const res = await fetch(params.webAppUrl, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body,
    signal: params.signal,
    redirect: 'follow',
  } as RequestInit);

  if (res.status === 401 || res.status === 403) {
    return { status: 'error', error: 'AUTH_REQUIRED' };
  }

  return (await res.json()) as ExecutionResult;
}

export async function callWebApp(params: {
  webAppUrl: string;
  fnName: string;
  parameters?: unknown;
  timeoutMs?: number;
}): Promise<ExecutionResult> {
  const timeoutMs = params.timeoutMs ?? EXECUTION_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await fetchWebApp({
      webAppUrl: params.webAppUrl,
      fnName: params.fnName,
      parameters: params.parameters,
      signal: controller.signal,
    });
    clearTimeout(timer);
    return result;
  } catch (err) {
    clearTimeout(timer);
    const isAbort =
      err instanceof Error &&
      (err.name === 'AbortError' || err.name === 'TimeoutError');

    if (isAbort) {
      const executionId = crypto.randomUUID();
      await fetchWebApp({
        webAppUrl: params.webAppUrl,
        fnName: '_ags_trg',
        parameters: {
          fnName: params.fnName,
          fnParams: params.parameters,
          executionId,
        },
      });
      return {
        status: 'async',
        executionId,
        message:
          'Your automation is running in the background. I will check the result automatically.',
      };
    }

    throw err;
  }
}
