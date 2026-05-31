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
    const url = `${VALIDATION_URL}?subscription_id=${encodeURIComponent(licenseKey)}`;
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
      // Never exit — an invalid key degrades to free tier so the server keeps running.
      // process.exit() would crash the MCP server in Claude Desktop's DXT runner.
      cache.set(licenseKey, { tier: 'free', expiresAt: Date.now() + CACHE_TTL_MS });
      return 'free';
    }

    const planId = data.subscriptionInfo?.subscription?.plan_id ?? '';
    const tier: Tier = PLAN_TIER_MAP[planId] ?? 'pro';

    cache.set(licenseKey, { tier, expiresAt: Date.now() + CACHE_TTL_MS });
    return tier;
  } catch (err) {
    // Network errors, timeouts, unexpected responses → fall back to free tier.
    console.error(
      `[AutomateGS] Warning: could not reach license server (${err}). ` +
        'Falling back to free tier.',
    );
    return 'free';
  }
}

export async function resolveTier(licenseKey: string | undefined): Promise<Tier> {
  // Treat missing, empty, or unresolved DXT template placeholders as "no key".
  // Claude Desktop's DXT runner may pass the literal string "${user_config.license_key}"
  // when the user hasn't entered a key, instead of an empty string.
  if (!licenseKey || licenseKey.startsWith('${')) return 'free';
  return validateLicense(licenseKey);
}
