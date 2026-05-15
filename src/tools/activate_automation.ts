import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Tier } from '../registry/types.js';
import { requireTier } from '../utils/require-tier.js';
import { loadRegistry, getProject } from '../registry/projects.js';
import { activeSessions, activateAutomation } from './staging.js';

export async function handleActivateAutomation(
  tier: Tier,
  args: { sessionId: string },
) {
  requireTier(tier, 'pro', 'activate_automation');

  const session = activeSessions.get(args.sessionId);
  if (!session) {
    throw new McpError(ErrorCode.InvalidRequest, `Session ${args.sessionId} not found`);
  }
  if (session.status !== 'awaiting_approval') {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Session status is '${session.status}', expected 'awaiting_approval'`,
    );
  }

  const registry = loadRegistry();
  const project = getProject(session.projectId);
  if (!project) {
    throw new McpError(ErrorCode.InvalidRequest, `Project ${session.projectId} not found`);
  }

  await activateAutomation(session, project, registry, tier);

  return {
    success: true,
    fnName: session.fnName,
    activatedAt: new Date().toISOString(),
    message:
      'Automation activated. It is now ready to run on your real data. ' +
      'You can schedule it with schedule_automation.',
  };
}
