import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Tier } from '../registry/types.js';
import { UPGRADE_URL } from './constants.js';

const TIER_ORDER: Tier[] = ['free', 'pro', 'agency'];

export function requireTier(tier: Tier, required: Tier, toolName: string): void {
  if (TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(required)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `${toolName} requires ${required} tier or above. Upgrade at ${UPGRADE_URL}`,
    );
  }
}
