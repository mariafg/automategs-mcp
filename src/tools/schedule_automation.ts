import type { Tier, TriggerRecord } from '../registry/types.js';
import type { ToolEntry } from './types.js';
import { loadRegistry, upsertProject } from '../registry/projects.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { callWebApp } from './execution.js';
import { requireTier } from '../utils/tier.js';

export function registerTool(tools: ToolEntry[], tier: Tier): void {
  tools.push({
    name: 'schedule_automation',
    description:
      'Schedule an automation to run automatically on a recurring basis. Requires Pro or Agency tier. The automation must be active (crystallised) before scheduling.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        functionName: { type: 'string' },
        frequency: {
          type: 'string',
          enum: ['minutely', 'hourly', 'daily', 'weekly', 'monthly'],
        },
        interval: { type: 'number', description: 'Interval for minutely/hourly frequencies' },
        dayOfWeek: { type: 'string', description: 'e.g. MONDAY (for weekly)' },
        dayOfMonth: { type: 'number', description: 'Day of month 1-31 (for monthly)' },
        hour: { type: 'number', description: 'Hour of day 0-23' },
        parameters: { type: 'object', description: 'Parameters to pass each run' },
        description: { type: 'string', description: 'Human-readable description of when/why this runs' },
      },
      required: ['projectId', 'functionName', 'frequency', 'description'],
    },
    handler: async (args) => {
      requireTier(tier, 'pro', 'schedule_automation');

      const {
        projectId,
        functionName,
        frequency,
        interval,
        dayOfWeek,
        dayOfMonth,
        hour,
        parameters,
        description,
      } = args as {
        projectId: string;
        functionName: string;
        frequency: 'minutely' | 'hourly' | 'daily' | 'weekly' | 'monthly';
        interval?: number;
        dayOfWeek?: string;
        dayOfMonth?: number;
        hour?: number;
        parameters?: Record<string, unknown>;
        description: string;
      };

      const registry = loadRegistry();
      const project = registry.projects[projectId];
      if (!project) {
        throw new McpError(ErrorCode.InvalidRequest, `Project ${projectId} not found`);
      }
      if (!project.webAppUrl) {
        throw new McpError(ErrorCode.InvalidRequest, `Project ${projectId} has no web app URL.`);
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

      if (fn.status !== 'crystallised') {
        return {
          content: [
            {
              type: 'text',
              text: 'Please activate this automation before scheduling it.',
            },
          ],
        };
      }

      const result = await callWebApp({
        webAppUrl: project.webAppUrl,
        fnName: '_ags_ct',
        parameters: {
          fnName: fn.fnName,
          frequency,
          interval,
          hour,
          dayOfWeek,
          dayOfMonth,
          params: parameters ?? [],
        },
      });

      if (result.status === 'error') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: result.error }, null, 2),
            },
          ],
        };
      }

      const trigResult = result.result as { triggerId: string };
      const triggerRecord: TriggerRecord = {
        triggerId: trigResult.triggerId,
        fnName: fn.fnName,
        frequency,
        description,
        createdAt: new Date().toISOString(),
        params: parameters ?? {},
      };

      project.triggers.push(triggerRecord);
      upsertProject(project);

      return {
        content: [
          {
            type: 'text',
            text: `Your automation is scheduled. ${description}\n\nTrigger ID: ${trigResult.triggerId}`,
          },
        ],
      };
    },
  });
}
