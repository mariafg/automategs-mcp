import type { Tier } from '../registry/types.js';
import type { ToolEntry } from './types.js';
import { loadRegistry } from '../registry/projects.js';
import { FREE_TIER_EXECUTION_LIMIT } from '../utils/constants.js';

export function registerTool(tools: ToolEntry[], tier: Tier): void {
  tools.push({
    name: 'list_automations',
    description:
      'Show all your AutomateGS automations, their status, and available actions. Call this at the start of any session.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Filter to a specific project' },
      },
    },
    handler: async (args) => {
      const registry = loadRegistry();
      const { projectId } = args as { projectId?: string };

      let projects = Object.values(registry.projects);
      if (projectId) {
        projects = projects.filter((p) => p.id === projectId);
      }

      const automations = projects.map((p) => ({
        ...p,
        functions: p.functions.filter((f) => !f.fnName.startsWith('_ags_')),
      }));

      const allFunctions = automations.flatMap((p) => p.functions);
      const total = allFunctions.length;
      const draft = allFunctions.filter((f) => f.status === 'draft').length;
      const active = allFunctions.filter((f) => f.status === 'crystallised').length;

      const executionsRemaining =
        tier === 'free'
          ? FREE_TIER_EXECUTION_LIMIT - registry.totalExecutions
          : 'unlimited';

      const hint =
        total === 0
          ? 'No automations yet. Use create_automation to get started.'
          : draft > 0
            ? `You have ${draft} draft automation(s). Run them with force: true or activate them with Pro/Agency.`
            : 'All automations are active. Use run_automation to execute them.';

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { automations, summary: { total, draft, active }, tier, executionsRemaining, hint },
              null,
              2,
            ),
          },
        ],
      };
    },
  });
}
