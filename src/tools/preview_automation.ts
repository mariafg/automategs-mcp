import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Tier } from '../registry/types.js';
import { requireTier } from '../utils/require-tier.js';
import { getProject, getFunction, upsertFunction } from '../registry/projects.js';
import { createPreviewSession, executePreview } from './staging.js';

export async function handlePreviewAutomation(
  tier: Tier,
  args: {
    projectId: string;
    functionName: string;
    sheetId: string;
    parameters?: Record<string, unknown>;
  },
) {
  requireTier(tier, 'pro', 'preview_automation');

  const project = getProject(args.projectId);
  if (!project) {
    throw new McpError(ErrorCode.InvalidRequest, `Project ${args.projectId} not found`);
  }
  if (!project.webAppUrl) {
    throw new McpError(ErrorCode.InvalidRequest, 'Project has no deployed web app URL');
  }

  const fn = getFunction(args.projectId, args.functionName);
  if (!fn) {
    throw new McpError(ErrorCode.InvalidRequest, `Function ${args.functionName} not found`);
  }
  if (fn.status !== 'draft' && fn.status !== 'staged') {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Function status is '${fn.status}', expected 'draft' or 'staged'`,
    );
  }

  let session = await createPreviewSession({ project, fn, sheetId: args.sheetId });
  session = await executePreview(session, project, args.parameters);

  fn.status = 'staged';
  upsertFunction(project.id, fn);

  const message =
    `Preview complete. Review your results at ${session.tempSheetUrl}. ` +
    `The preview sheet is a temporary copy -- your real data is unchanged.\n\n` +
    `To activate this automation, call activate_automation with sessionId: ${session.sessionId}\n` +
    `To discard, call discard_preview.`;

  return {
    sessionId: session.sessionId,
    previewSheetUrl: session.tempSheetUrl,
    importRangesFound: session.importRangesFound,
    importRangesAuthorized: session.importRangesAuthorized,
    result: session.executionResult,
    logs: session.executionResult?.logs,
    message,
  };
}
