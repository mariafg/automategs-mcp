import { text, ToolContext, ToolResult } from './common.js';
import { fetchTemplateRegistry, filterByTier } from './templates.js';

export const tools = [
  {
    name: 'list_templates',
    description:
      'Browse ready-made automations from the AutomateGS template library. Templates let you get started in seconds without writing any code.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: {
          type: 'string',
          enum: ['sheets', 'standalone'],
          description: 'Filter by surface: "sheets" for spreadsheet automations, "standalone" for others',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by tags, e.g. ["reporting", "email"]',
        },
      },
    },
  },
];

export const handlers: Record<
  string,
  (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
> = {
  list_templates: async (args, ctx) => {
    const surface = args.surface as string | undefined;
    const tags = (args.tags as string[] | undefined) ?? [];

    const registry = await fetchTemplateRegistry();
    let templates = filterByTier(registry.templates, ctx.tier);

    if (surface) {
      templates = templates.filter((t) => t.surface === surface);
    }
    if (tags.length > 0) {
      templates = templates.filter((t) => tags.some((tag) => t.tags.includes(tag)));
    }

    const count = templates.length;
    return text({
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        tier: t.tier,
        surface: t.surface,
        tags: t.tags,
        configRequired: t.configRequired ?? [],
        entryFunctionName: t.entryFunctionName,
      })),
      count,
      tier: ctx.tier,
      message:
        count > 0
          ? `Found ${count} template${count > 1 ? 's' : ''} available for your ${ctx.tier} plan. Use add_template to install one.`
          : 'No templates found. The template library may be temporarily unavailable.',
    });
  },
};
