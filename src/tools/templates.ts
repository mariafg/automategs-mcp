import fs from 'fs';
import {
  TEMPLATE_CACHE_PATH,
  TEMPLATE_CACHE_TTL_MS,
  TEMPLATE_REGISTRY_URL,
} from '../utils/constants.js';
import type { TemplateManifest, TemplateRegistry, Tier } from '../registry/types.js';

export async function fetchTemplateRegistry(): Promise<TemplateRegistry> {
  // 1. Check cache freshness
  if (fs.existsSync(TEMPLATE_CACHE_PATH)) {
    try {
      const stat = fs.statSync(TEMPLATE_CACHE_PATH);
      const age = Date.now() - stat.mtimeMs;
      if (age < TEMPLATE_CACHE_TTL_MS) {
        const raw = fs.readFileSync(TEMPLATE_CACHE_PATH, 'utf8');
        return JSON.parse(raw) as TemplateRegistry;
      }
    } catch {
      // Cache read failed — fall through to network
    }
  }

  // 2. Fetch from network
  try {
    const res = await fetch(TEMPLATE_REGISTRY_URL, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const registry = (await res.json()) as TemplateRegistry;

    // 3. Persist to cache
    try {
      fs.writeFileSync(TEMPLATE_CACHE_PATH, JSON.stringify(registry, null, 2), 'utf8');
    } catch {
      // Cache write failure is non-fatal
    }
    return registry;
  } catch (err) {
    console.error(`[AutomateGS] Warning: could not fetch template registry (${err}).`);

    // 4. Fall back to stale cache if it exists
    if (fs.existsSync(TEMPLATE_CACHE_PATH)) {
      try {
        console.error('[AutomateGS] Using stale template cache.');
        const raw = fs.readFileSync(TEMPLATE_CACHE_PATH, 'utf8');
        return JSON.parse(raw) as TemplateRegistry;
      } catch {
        // Cache unreadable — return empty
      }
    }

    // 5. Return empty registry — never throw
    return { version: '1.0', updatedAt: '', templates: [] };
  }
}

export function filterByTier(
  templates: TemplateManifest[],
  tier: Tier,
): TemplateManifest[] {
  if (tier === 'agency') return templates;
  if (tier === 'pro') return templates.filter((t) => t.tier === 'free' || t.tier === 'pro');
  return templates.filter((t) => t.tier === 'free');
}
