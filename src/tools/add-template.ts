import path from 'path';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { loadRegistry, saveRegistry, checkFreeTierLimits } from '../registry/projects.js';
import type { ProjectRecord, FunctionRecord } from '../registry/types.js';
import { SCRIPTS_DIR } from '../utils/constants.js';
import {
  text,
  ToolContext,
  ToolResult,
  slugify,
  uniqueSlug,
  runProjectSetup,
  deployFunctionCode,
} from './common.js';
import { fetchTemplateRegistry, filterByTier } from './templates.js';

export const tools = [
  {
    name: 'add_template',
    description:
      'Install a template from the AutomateGS library as a new automation. Ready to run in seconds.',
    inputSchema: {
      type: 'object',
      required: ['templateId'],
      properties: {
        templateId: { type: 'string', description: 'Template ID from list_templates' },
        displayName: { type: 'string', description: 'Override the automation name (optional)' },
        sheetId: { type: 'string', description: 'Google Sheet ID (required if template uses a spreadsheet)' },
      },
    },
  },
];

export const handlers: Record<
  string,
  (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
> = {
  add_template: async (args, ctx) => {
    const templateId = args.templateId as string;
    const sheetId = args.sheetId as string | undefined;

    // 1. Fetch template manifest
    const registry_data = await fetchTemplateRegistry();
    const template = registry_data.templates.find((t) => t.id === templateId);
    if (!template) {
      throw new McpError(ErrorCode.InvalidRequest, `Template "${templateId}" not found.`);
    }

    // 2. Check tier allows this template
    const allowed = filterByTier([template], ctx.tier);
    if (allowed.length === 0) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Template "${templateId}" requires ${template.tier} plan (current: ${ctx.tier}).`,
      );
    }

    // 3. Determine display name
    const displayName = (args.displayName as string | undefined) ?? template.name;

    // 4. Create automation (same logic as create_automation)
    const registry = loadRegistry();
    checkFreeTierLimits(registry, 'create_project');

    const base = slugify(displayName);
    const existing = Object.keys(registry.projects);
    const id = uniqueSlug(base, existing);

    const setup = await runProjectSetup(id, displayName, template.requiredScopes);

    const now = new Date().toISOString();
    const project: ProjectRecord = {
      id,
      displayName,
      scriptId: setup.scriptId,
      webAppUrl: setup.webAppUrl,
      deploymentId: setup.deploymentId,
      localPath: setup.localPath,
      functions: [],
      triggers: [],
      executionCount: 0,
      setupComplete: true,
      createdAt: now,
      lastDeployed: now,
    };

    // 5. Deploy the template function (same logic as update_automation)
    const newDeploymentId = await deployFunctionCode(
      project.localPath,
      template.entryFunctionName,
      template.scriptCode,
      template.requiredScopes,
      project.deploymentId,
    );

    if (newDeploymentId && newDeploymentId !== project.deploymentId) {
      project.deploymentId = newDeploymentId;
      project.webAppUrl = `https://script.google.com/macros/s/${newDeploymentId}/exec`;
    }

    const fnRecord: FunctionRecord = {
      name: template.entryFunctionName,
      suffix: '',
      fnName: template.entryFunctionName,
      isEntryPoint: true,
      status: 'draft',
      createdAt: now,
    };
    project.functions.push(fnRecord);

    registry.projects[id] = project;
    saveRegistry(registry);

    // 6. Return with config requirements if present
    const configRequired = template.configRequired ?? [];
    return text({
      success: true,
      projectId: id,
      functionName: template.entryFunctionName,
      configRequired,
      message:
        configRequired.length > 0
          ? `Template installed. Before running, please provide: ${configRequired.join(', ')}`
          : 'Template ready. Preview it with preview_automation or run it with run_automation.',
    });
  },
};
