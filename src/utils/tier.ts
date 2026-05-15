import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Tier } from '../registry/types.js';
import { UPGRADE_URL } from './constants.js';

const ORDER: Record<Tier, number> = { free: 0, pro: 1, agency: 2 };

export function requireTier(current: Tier, required: Tier, toolName: string): void {
  if (ORDER[current] < ORDER[required]) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `${toolName} requires ${required} tier. Upgrade at ${UPGRADE_URL}`,
    );
  }
}
