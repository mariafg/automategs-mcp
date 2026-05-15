import type { Tier } from '../registry/types.js';
import type { ToolEntry } from './types.js';
import { loadRegistry } from '../registry/projects.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { getAccessToken } from '../auth/clasp.js';
import type { ExecutionResult } from '../registry/types.js';

export function registerTool(tools: ToolEntry[], tier: Tier): void {
  tools.push({
    name: 'check_status',
    description: 'Check the result of an automation that is running in the background.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        executionId: {
          type: 'string',
          description: 'Execution ID returned by run_automation',
        },
      },
      required: ['projectId', 'executionId'],
    },
    handler: async (args) => {
      const { projectId, executionId } = args as {
        projectId: string;
        executionId: string;
      };

      const registry = loadRegistry();
      const project = registry.projects[projectId];
      if (!project) {
        throw new McpError(ErrorCode.InvalidRequest, `Project ${projectId} not found`);
      }
      if (!project.webAppUrl) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Project ${projectId} has no web app URL.`,
        );
      }

      const token = await getAccessToken();
      const url = `${project.webAppUrl}?action=check&id=${encodeURIComponent(executionId)}`;

      const res = await fetch(url, {
        headers: { Authorization: 'Bearer ' + token },
        redirect: 'follow',
      });

      const result = (await res.json()) as ExecutionResult;

      if (result.status === 'pending') {
        return {
          content: [
            {
              type: 'text',
              text: `Automation is still running. Execution ID: ${executionId}\nCheck again in a moment.`,
            },
          ],
        };
      }

      const logs =
        result.logs && result.logs.length > 0
          ? '\n\nLogs:\n' + result.logs.map((l) => `[${l.t}] ${l.m}`).join('\n')
          : '';

      return {
        content: [
          {
            type: 'text',
            text: `Status: ${result.status}\n\nResult:\n${JSON.stringify(result.result ?? result.error, null, 2)}${logs}`,
          },
        ],
      };
    },
  });
}
