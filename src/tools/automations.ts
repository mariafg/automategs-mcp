import path from 'path';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  loadRegistry,
  saveRegistry,
  checkFreeTierLimits,
  incrementExecution,
} from '../registry/projects.js';
import type { ProjectRecord, FunctionRecord } from '../registry/types.js';
import { SCRIPTS_DIR, FREE_TIER_EXECUTION_LIMIT, UPGRADE_URL } from '../utils/constants.js';
import {
  text,
  ToolContext,
  ToolResult,
  slugify,
  uniqueSlug,
  runProjectSetup,
  deployFunctionCode,
  callWebApp,
} from './common.js';

const ASYNC_EXECUTIONS = new Map<string, { status: string; result?: unknown; error?: string }>();

export const tools = [
  {
    name: 'list_automations',
    description:
      'List all your AutomateGS automations — their names, states, functions, and schedules. Call this at the start of every session.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_automation',
    description:
      'Create a new Google Apps Script automation project. Returns a projectId you will use with all other tools.',
    inputSchema: {
      type: 'object',
      required: ['displayName'],
      properties: {
        displayName: { type: 'string', description: 'Human-readable name, e.g. "Weekly Sales Report"' },
        description: { type: 'string', description: 'Optional description' },
        sheetId: { type: 'string', description: 'Google Sheet ID if this automation reads/writes a spreadsheet' },
      },
    },
  },
  {
    name: 'update_automation',
    description:
      'Write or replace a function inside an existing automation. Sets the function status to draft — preview or run it next.',
    inputSchema: {
      type: 'object',
      required: ['projectId', 'functionName', 'functionCode'],
      properties: {
        projectId: { type: 'string' },
        functionName: { type: 'string', description: 'Valid JS identifier, e.g. "syncSalesData"' },
        functionCode: { type: 'string', description: 'Full JS function definition' },
        description: { type: 'string' },
        usesSpreadsheet: { type: 'boolean', default: false },
        oauthScopes: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'run_automation',
    description:
      'Run an automation function immediately. Draft automations require force: true. Returns logs and a structured result.',
    inputSchema: {
      type: 'object',
      required: ['projectId', 'functionName'],
      properties: {
        projectId: { type: 'string' },
        functionName: { type: 'string' },
        params: { type: 'object', description: 'Parameters passed to the function' },
        force: { type: 'boolean', description: 'Run even if status is draft (not recommended)' },
      },
    },
  },
  {
    name: 'check_status',
    description: 'Check the result of an automation that returned status: async.',
    inputSchema: {
      type: 'object',
      required: ['executionId'],
      properties: {
        executionId: { type: 'string' },
      },
    },
  },
];

export const handlers: Record<
  string,
  (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
> = {
  list_automations: async (_args, ctx) => {
    const { projects, tier, totalExecutions, githubConnected } = ctx.registry;
    const list = Object.values(projects).map((p) => ({
      id: p.id,
      displayName: p.displayName,
      scriptId: p.scriptId,
      webAppUrl: p.webAppUrl,
      setupComplete: p.setupComplete,
      executionCount: p.executionCount,
      functions: p.functions.map((f) => ({
        name: f.name,
        fnName: f.fnName,
        status: f.status,
        createdAt: f.createdAt,
        crystallisedAt: f.crystallisedAt,
      })),
      triggers: p.triggers,
      createdAt: p.createdAt,
      lastDeployed: p.lastDeployed,
    }));
    return text({
      automations: list,
      count: list.length,
      tier,
      totalExecutions,
      githubConnected,
      message:
        list.length > 0
          ? `Found ${list.length} automation${list.length > 1 ? 's' : ''}.`
          : 'No automations yet. Use create_automation to get started.',
    });
  },

  create_automation: async (args, ctx) => {
    const displayName = args.displayName as string;
    const description = (args.description as string | undefined) ?? '';

    const registry = loadRegistry();
    checkFreeTierLimits(registry, 'create_project');

    const base = slugify(displayName);
    const existing = Object.keys(registry.projects);
    const id = uniqueSlug(base, existing);
    const localPath = path.join(SCRIPTS_DIR, id);

    const setup = await runProjectSetup(id, displayName, []);

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

    registry.projects[id] = project;
    saveRegistry(registry);

    return text({
      success: true,
      projectId: id,
      scriptId: setup.scriptId,
      webAppUrl: setup.webAppUrl,
      message: `Automation "${displayName}" created (id: ${id}). Use update_automation to add your function code.`,
    });
  },

  update_automation: async (args, ctx) => {
    const projectId = args.projectId as string;
    const functionName = args.functionName as string;
    const functionCode = args.functionCode as string;
    const usesSpreadsheet = (args.usesSpreadsheet as boolean | undefined) ?? false;
    const oauthScopes = (args.oauthScopes as string[] | undefined) ?? [];

    const registry = loadRegistry();
    const project = registry.projects[projectId];
    if (!project) {
      throw new McpError(ErrorCode.InvalidRequest, `Project "${projectId}" not found.`);
    }

    const newDeploymentId = await deployFunctionCode(
      project.localPath,
      functionName,
      functionCode,
      oauthScopes,
      project.deploymentId,
    );

    const existingFn = project.functions.find((f) => f.fnName === functionName);
    const now = new Date().toISOString();
    const fnRecord: FunctionRecord = {
      name: functionName,
      suffix: '',
      fnName: functionName,
      isEntryPoint: true,
      status: 'draft',
      createdAt: existingFn?.createdAt ?? now,
    };

    const idx = project.functions.findIndex((f) => f.fnName === functionName);
    if (idx >= 0) {
      project.functions[idx] = fnRecord;
    } else {
      project.functions.push(fnRecord);
    }

    if (newDeploymentId && newDeploymentId !== project.deploymentId) {
      project.deploymentId = newDeploymentId;
      project.webAppUrl = `https://script.google.com/macros/s/${newDeploymentId}/exec`;
    }
    project.lastDeployed = now;
    saveRegistry(registry);

    return text({
      success: true,
      projectId,
      functionName,
      status: 'draft',
      webAppUrl: project.webAppUrl,
      message: `Function "${functionName}" updated and pushed. Status: draft. Use preview_automation (Pro/Agency) or run_automation to test it.`,
    });
  },

  run_automation: async (args, ctx) => {
    const projectId = args.projectId as string;
    const functionName = args.functionName as string;
    const params = (args.params as Record<string, unknown> | undefined) ?? {};
    const force = (args.force as boolean | undefined) ?? false;

    const registry = loadRegistry();
    const project = registry.projects[projectId];
    if (!project) {
      throw new McpError(ErrorCode.InvalidRequest, `Project "${projectId}" not found.`);
    }
    if (!project.webAppUrl) {
      throw new McpError(ErrorCode.InvalidRequest, `Project "${projectId}" has no web app URL. Re-run create_automation.`);
    }

    const fn = project.functions.find((f) => f.fnName === functionName);
    if (fn?.status === 'deprecated') {
      throw new McpError(ErrorCode.InvalidRequest, `Function "${functionName}" is deprecated. Use a newer version.`);
    }
    if (fn?.status === 'draft' && !force) {
      return text({
        status: 'blocked',
        message: `Function "${functionName}" is in draft state. Call preview_automation first (Pro/Agency), or pass force: true to run anyway.`,
      });
    }

    checkFreeTierLimits(registry, 'execute');

    const executionId = `${projectId}_${Date.now()}`;
    ASYNC_EXECUTIONS.set(executionId, { status: 'pending' });

    try {
      const result = await callWebApp(project.webAppUrl, functionName, params);
      incrementExecution(projectId);
      ASYNC_EXECUTIONS.delete(executionId);

      const freeRemaining =
        ctx.tier === 'free'
          ? Math.max(0, FREE_TIER_EXECUTION_LIMIT - (registry.totalExecutions + 1))
          : undefined;

      return text({
        status: result.success ? 'success' : 'error',
        result: result.result,
        error: result.error,
        logs: result.logs ?? [],
        ...(freeRemaining !== undefined && { freeRunsRemaining: freeRemaining, upgradeUrl: UPGRADE_URL }),
      });
    } catch (err: unknown) {
      const msg = String(err);
      if (msg.includes('TimeoutError') || msg.includes('AbortError') || msg.includes('timed out')) {
        ASYNC_EXECUTIONS.set(executionId, { status: 'running' });
        return text({
          status: 'async',
          executionId,
          message: 'Automation is running in the background. Wait 90 seconds then call check_status.',
        });
      }
      ASYNC_EXECUTIONS.delete(executionId);
      throw new McpError(ErrorCode.InternalError, `Execution failed: ${msg}`);
    }
  },

  check_status: async (args, _ctx) => {
    const executionId = args.executionId as string;
    const entry = ASYNC_EXECUTIONS.get(executionId);
    if (!entry) {
      return text({
        status: 'unknown',
        executionId,
        message: 'Execution ID not found. It may have completed in a previous session.',
      });
    }
    return text({ executionId, ...entry });
  },
};
