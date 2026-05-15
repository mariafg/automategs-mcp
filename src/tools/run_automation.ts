import open from 'open';
import type { Tier } from '../registry/types.js';
import type { ToolEntry } from './types.js';
import {
  loadRegistry,
  incrementExecution,
  checkFreeTierLimits,
} from '../registry/projects.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { callWebApp } from './execution.js';

export function registerTool(tools: ToolEntry[], tier: Tier): void {
  tools.push({
    name: 'run_automation',
    description:
      'Run an automation. Active (crystallised) automations run normally. Draft automations require force: true and will show a warning. Free tier allows 10 total runs across all automations.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project containing the function' },
        functionName: {
          type: 'string',
          description: 'Function name (base name or full fnName with suffix)',
        },
        parameters: { type: 'object', description: 'Parameters to pass to the function' },
        force: { type: 'boolean', description: 'Run even if function is in draft status' },
      },
      required: ['projectId', 'functionName'],
    },
    handler: async (args) => {
      const { projectId, functionName, parameters, force } = args as {
        projectId: string;
        functionName: string;
        parameters?: Record<string, unknown>;
        force?: boolean;
      };

      const registry = loadRegistry();
      const project = registry.projects[projectId];
      if (!project) {
        throw new McpError(ErrorCode.InvalidRequest, `Project ${projectId} not found`);
      }
      if (!project.webAppUrl) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Project ${projectId} has no web app URL. Run setup first.`,
        );
      }

      const fn = project.functions.find(
        (f) => f.name === functionName || f.fnName === functionName,
      );
      if (!fn) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Function "${functionName}" not found in project "${projectId}".`,
        );
      }

      if (fn.status !== 'crystallised' && !force) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  error:
                    'This automation is in draft status. Preview and activate it first (Pro/Agency), or pass force: true to run it without previewing.',
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      if (tier === 'free') {
        checkFreeTierLimits(registry, 'execute');
      }

      const result = await callWebApp({
        webAppUrl: project.webAppUrl,
        fnName: fn.fnName,
        parameters,
      });

      if (result.error === 'AUTH_REQUIRED') {
        open(project.webAppUrl).catch(() => {});
        return {
          content: [
            {
              type: 'text',
              text: 'Google permissions need to be refreshed. I have opened your browser -- please authorise and then ask me to run the automation again.',
            },
          ],
        };
      }

      incrementExecution(projectId);

      const warning =
        fn.status !== 'crystallised'
          ? '\n⚠️  WARNING: This automation is in draft status and has not been reviewed or activated.'
          : '';

      const logs =
        result.logs && result.logs.length > 0
          ? '\n\nLogs:\n' + result.logs.map((l) => `[${l.t}] ${l.m}`).join('\n')
          : '';

      if (result.status === 'async') {
        return {
          content: [
            {
              type: 'text',
              text: `${warning}${result.message ?? 'Running in background.'}\nExecution ID: ${result.executionId}\nUse check_status to retrieve the result.${logs}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text:
              `${warning}Status: ${result.status}\n\nResult:\n${JSON.stringify(result.result, null, 2)}${logs}`.trim(),
          },
        ],
      };
    },
  });
}
