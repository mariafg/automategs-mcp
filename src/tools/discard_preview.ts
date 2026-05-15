import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Tier } from '../registry/types.js';
import { requireTier } from '../utils/require-tier.js';
import { getProject } from '../registry/projects.js';
import { activeSessions, discardPreview } from './staging.js';

export async function handleDiscardPreview(tier: Tier, args: { sessionId: string }) {
  requireTier(tier, 'pro', 'discard_preview');

  const session = activeSessions.get(args.sessionId);
  if (!session) {
    throw new McpError(ErrorCode.InvalidRequest, `Session ${args.sessionId} not found`);
  }

  const project = getProject(session.projectId);
  if (!project) {
    throw new McpError(ErrorCode.InvalidRequest, `Project ${session.projectId} not found`);
  }

  await discardPreview(session, project);

  return {
    success: true,
    message: 'Preview discarded. The temporary sheet has been deleted.',
  };
}
