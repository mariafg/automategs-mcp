import type { Tier, ValidationResponse } from '../registry/types.js';
import { VALIDATION_URL, PLAN_TIER_MAP } from '../utils/constants.js';

interface CacheEntry {
  tier: Tier;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

export async function validateLicense(licenseKey: string): Promise<Tier> {
  const cached = cache.get(licenseKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.tier;
  }

  try {
    const url = `${VALIDATION_URL}?licenseKey=${encodeURIComponent(licenseKey)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = (await res.json()) as ValidationResponse;

    if (!data.isAuthorized) {
      const msg =
        data.errorMessage ??
        'Your AutomateGS license key is invalid or expired. Please check your subscription.';
      console.error(`[AutomateGS] License validation failed: ${msg}`);
      process.exit(1);
    }

    const planId =
      data.planId ?? data.subscriptionInfo?.subscription?.plan_id ?? '';
    const tier: Tier = PLAN_TIER_MAP[planId] ?? 'free';

    cache.set(licenseKey, { tier, expiresAt: Date.now() + CACHE_TTL_MS });
    return tier;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_OPERATION_ABORTED' ||
        String(err).includes('exit')) {
      throw err;
    }
    console.error(
      `[AutomateGS] Warning: could not reach license server (${err}). ` +
        'Falling back to free tier.',
    );
    return 'free';
  }
}

export async function resolveTier(licenseKey: string | undefined): Promise<Tier> {
  if (!licenseKey) return 'free';
  return validateLicense(licenseKey);
}
