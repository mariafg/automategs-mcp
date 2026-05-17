import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { loadRegistry, saveRegistry } from '../registry/projects.js';
import { text, ToolContext, ToolResult, requireTier, callWebApp } from './common.js';

export const tools = [
  {
    name: 'preview_automation',
    description:
      'Run an automation against a staging copy of your spreadsheet — your real data is untouched. Returns a preview sheet URL for review. Pro and Agency plans only.',
    inputSchema: {
      type: 'object',
      required: ['projectId', 'functionName'],
      properties: {
        projectId: { type: 'string' },
        functionName: { type: 'string' },
        sheetId: {
          type: 'string',
          description: 'Sheet ID to copy for staging. Required if the function uses a spreadsheet.',
        },
        params: { type: 'object', description: 'Extra parameters to pass to the function' },
      },
    },
  },
  {
    name: 'activate_automation',
    description:
      'Approve a previewed automation and mark it as active (crystallised). Safe for production use and scheduling. Pro and Agency plans only.',
    inputSchema: {
      type: 'object',
      required: ['projectId', 'functionName'],
      properties: {
        projectId: { type: 'string' },
        functionName: { type: 'string' },
      },
    },
  },
  {
    name: 'discard_preview',
    description:
      'Discard a staged preview and delete the staging sheet. The automation returns to draft state.',
    inputSchema: {
      type: 'object',
      required: ['projectId', 'functionName'],
      properties: {
        projectId: { type: 'string' },
        functionName: { type: 'string' },
      },
    },
  },
];

export const handlers: Record<
  string,
  (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
> = {
  preview_automation: async (args, ctx) => {
    requireTier(ctx.tier, 'pro', 'Preview');

    const projectId = args.projectId as string;
    const functionName = args.functionName as string;
    const sheetId = args.sheetId as string | undefined;
    const params = (args.params as Record<string, unknown> | undefined) ?? {};

    const registry = loadRegistry();
    const project = registry.projects[projectId];
    if (!project) throw new McpError(ErrorCode.InvalidRequest, `Project "${projectId}" not found.`);
    if (!project.webAppUrl) throw new McpError(ErrorCode.InvalidRequest, 'Project has no web app URL.');

    const fn = project.functions.find((f) => f.fnName === functionName);
    if (!fn) throw new McpError(ErrorCode.InvalidRequest, `Function "${functionName}" not found.`);
    if (fn.status === 'deprecated') {
      throw new McpError(ErrorCode.InvalidRequest, `Function "${functionName}" is deprecated.`);
    }

    let stagingSheetId: string | undefined;
    let stagingSheetUrl: string | undefined;

    if (sheetId) {
      const copyResult = await callWebApp(project.webAppUrl, '_agsMakeStagingCopy', {
        sheetId,
        label: project.displayName,
      });
      if (!copyResult.success) {
        throw new McpError(ErrorCode.InternalError, `Failed to create staging copy: ${copyResult.error}`);
      }
      const copyData = copyResult.result as { stagingSheetId: string; stagingSheetUrl: string };
      stagingSheetId = copyData.stagingSheetId;
      stagingSheetUrl = copyData.stagingSheetUrl;
    }

    const runParams: Record<string, unknown> = {
      ...params,
      ...(stagingSheetId ? { sheetId: stagingSheetId } : {}),
    };

    const runResult = await callWebApp(project.webAppUrl, functionName, runParams);

    fn.status = 'staged';
    if (stagingSheetId) project.stagingTempSheetId = stagingSheetId;
    saveRegistry(registry);

    return text({
      success: true,
      projectId,
      functionName,
      status: 'staged',
      previewSheetUrl: stagingSheetUrl,
      result: runResult.result,
      logs: runResult.logs ?? [],
      error: runResult.error,
      message: stagingSheetUrl
        ? `Preview complete. Your real data is unchanged. Review the staging sheet: ${stagingSheetUrl}\n\nIf the results look correct, call activate_automation. Otherwise call discard_preview.`
        : 'Preview complete. Your real data is unchanged. Call activate_automation to go live, or discard_preview to cancel.',
    });
  },

  activate_automation: async (args, _ctx) => {
    const projectId = args.projectId as string;
    const functionName = args.functionName as string;

    const registry = loadRegistry();
    const project = registry.projects[projectId];
    if (!project) throw new McpError(ErrorCode.InvalidRequest, `Project "${projectId}" not found.`);

    const fn = project.functions.find((f) => f.fnName === functionName);
    if (!fn) throw new McpError(ErrorCode.InvalidRequest, `Function "${functionName}" not found.`);

    if (fn.status !== 'staged' && fn.status !== 'draft') {
      return text({
        success: false,
        message: `Function "${functionName}" has status "${fn.status}". Only staged or draft functions can be activated.`,
      });
    }

    fn.status = 'crystallised';
    fn.crystallisedAt = new Date().toISOString();

    // Clean up staging sheet reference (but keep it available for a moment)
    project.stagingTempSheetId = undefined;
    saveRegistry(registry);

    return text({
      success: true,
      projectId,
      functionName,
      status: 'crystallised',
      message: `"${functionName}" is now active (crystallised). It can be scheduled or called in production.`,
    });
  },

  discard_preview: async (args, _ctx) => {
    const projectId = args.projectId as string;
    const functionName = args.functionName as string;

    const registry = loadRegistry();
    const project = registry.projects[projectId];
    if (!project) throw new McpError(ErrorCode.InvalidRequest, `Project "${projectId}" not found.`);

    const fn = project.functions.find((f) => f.fnName === functionName);

    if (project.stagingTempSheetId && project.webAppUrl) {
      try {
        await callWebApp(project.webAppUrl, '_agsDeleteFile', {
          fileId: project.stagingTempSheetId,
        });
      } catch {
        // Best-effort deletion
      }
      project.stagingTempSheetId = undefined;
    }

    if (fn && fn.status === 'staged') {
      fn.status = 'draft';
    }
    saveRegistry(registry);

    return text({
      success: true,
      projectId,
      functionName,
      message: 'Preview discarded. Staging sheet deleted. Function is back to draft state.',
    });
  },
};
