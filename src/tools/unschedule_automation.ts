import type { Tier } from '../registry/types.js';
import type { ToolEntry } from './types.js';
import { loadRegistry, upsertProject } from '../registry/projects.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { callWebApp } from './execution.js';
import { requireTier } from '../utils/tier.js';

export function registerTool(tools: ToolEntry[], tier: Tier): void {
  tools.push({
    name: 'unschedule_automation',
    description: 'Stop a scheduled automation from running automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        triggerId: { type: 'string', description: 'Trigger ID returned by schedule_automation' },
      },
      required: ['projectId', 'triggerId'],
    },
    handler: async (args) => {
      requireTier(tier, 'pro', 'unschedule_automation');

      const { projectId, triggerId } = args as { projectId: string; triggerId: string };

      const registry = loadRegistry();
      const project = registry.projects[projectId];
      if (!project) {
        throw new McpError(ErrorCode.InvalidRequest, `Project ${projectId} not found`);
      }
      if (!project.webAppUrl) {
        throw new McpError(ErrorCode.InvalidRequest, `Project ${projectId} has no web app URL.`);
      }

      const result = await callWebApp({
        webAppUrl: project.webAppUrl,
        fnName: '_ags_dt',
        parameters: { triggerId },
      });

      project.triggers = project.triggers.filter((t) => t.triggerId !== triggerId);
      upsertProject(project);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { status: 'unscheduled', triggerId, deleted: (result.result as { deleted?: boolean })?.deleted ?? true },
              null,
              2,
            ),
          },
        ],
      };
    },
  });
}
