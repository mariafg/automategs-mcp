import type { Tier } from '../registry/types.js';
import type { ToolEntry } from './types.js';
import { loadRegistry } from '../registry/projects.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { callWebApp } from './execution.js';
import { requireTier } from '../utils/tier.js';

interface GasTrigger {
  triggerId: string;
  handlerFunction: string;
  fnName: string | null;
}

export function registerTool(tools: ToolEntry[], tier: Tier): void {
  tools.push({
    name: 'view_schedule',
    description: 'See all scheduled automations and when they run.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
      },
      required: ['projectId'],
    },
    handler: async (args) => {
      requireTier(tier, 'pro', 'view_schedule');

      const { projectId } = args as { projectId: string };

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
        fnName: '_ags_lt',
        parameters: [],
      });

      const gasTriggers = (result.result as GasTrigger[]) ?? [];

      const merged = gasTriggers
        .filter((t) => t.handlerFunction === '_ags_td' && t.fnName)
        .map((t) => {
          const stored = project.triggers.find((r) => r.triggerId === t.triggerId);
          return {
            triggerId: t.triggerId,
            fnName: t.fnName,
            frequency: stored?.frequency ?? 'unknown',
            description: stored?.description ?? '',
            createdAt: stored?.createdAt ?? '',
            params: stored?.params ?? {},
          };
        });

      if (merged.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No scheduled automations for project "${projectId}".`,
            },
          ],
        };
      }

      const lines = merged.map(
        (t) =>
          `• ${t.fnName} — ${t.frequency}${t.description ? ': ' + t.description : ''} (ID: ${t.triggerId})`,
      );

      return {
        content: [
          {
            type: 'text',
            text: `Scheduled automations for "${projectId}":\n\n${lines.join('\n')}`,
          },
        ],
      };
    },
  });
}
