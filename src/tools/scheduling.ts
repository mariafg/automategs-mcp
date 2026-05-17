import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { loadRegistry, saveRegistry } from '../registry/projects.js';
import type { TriggerRecord } from '../registry/types.js';
import { text, ToolContext, ToolResult, requireTier, callWebApp } from './common.js';

export const tools = [
  {
    name: 'schedule_automation',
    description:
      'Schedule an automation to run automatically on a time-based trigger. The automation must be active (crystallised). Pro and Agency plans only.',
    inputSchema: {
      type: 'object',
      required: ['projectId', 'functionName', 'scheduleType'],
      properties: {
        projectId: { type: 'string' },
        functionName: { type: 'string' },
        scheduleType: {
          type: 'string',
          enum: ['hourly', 'daily', 'weekly'],
          description: 'How often to run the automation',
        },
        hour: {
          type: 'number',
          description: 'Hour (0–23) for daily/weekly triggers. Default: 9',
        },
        dayOfWeek: {
          type: 'number',
          description: 'Day of week (1=Mon … 7=Sun) for weekly triggers. Default: 1 (Monday)',
        },
      },
    },
  },
  {
    name: 'unschedule_automation',
    description: 'Remove a time-based trigger from an automation.',
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
    name: 'view_schedule',
    description: 'Show the current schedule(s) for an automation project.',
    inputSchema: {
      type: 'object',
      required: ['projectId'],
      properties: {
        projectId: { type: 'string' },
        functionName: { type: 'string', description: 'Filter to a specific function (optional)' },
      },
    },
  },
];

export const handlers: Record<
  string,
  (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
> = {
  schedule_automation: async (args, ctx) => {
    const projectId = args.projectId as string;
    const functionName = args.functionName as string;
    const scheduleType = args.scheduleType as string;
    const hour = (args.hour as number | undefined) ?? 9;
    const dayOfWeek = (args.dayOfWeek as number | undefined) ?? 1;

    const registry = loadRegistry();
    const project = registry.projects[projectId];
    if (!project) throw new McpError(ErrorCode.InvalidRequest, `Project "${projectId}" not found.`);

    // Free tier: max 1 trigger per project. Pro/Agency: unlimited.
    if (ctx.tier === 'free' && project.triggers.length >= 1) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Free tier allows 1 scheduled trigger per project. Upgrade to Pro for unlimited scheduling.',
      );
    }
    const fn = project.functions.find((f) => f.fnName === functionName);
    if (!fn) throw new McpError(ErrorCode.InvalidRequest, `Function "${functionName}" not found in project "${projectId}".`);
    if (!project.webAppUrl) {
      throw new McpError(ErrorCode.InvalidRequest, 'Project has no web app URL.');
    }

    const result = await callWebApp(project.webAppUrl, '_agsSchedule', {
      functionName,
      type: scheduleType,
      hour,
      dayOfWeek,
    });

    if (!result.success) {
      throw new McpError(ErrorCode.InternalError, result.error ?? 'Schedule failed.');
    }

    const now = new Date().toISOString();
    const triggerId = (result.result as { triggerId?: string })?.triggerId ?? `${functionName}_${Date.now()}`;

    const existing = project.triggers.findIndex((t) => t.fnName === functionName);
    const triggerRecord: TriggerRecord = {
      triggerId,
      fnName: functionName,
      frequency: scheduleType,
      description: buildScheduleDescription(scheduleType, hour, dayOfWeek),
      createdAt: now,
      params: { hour, dayOfWeek },
    };

    if (existing >= 0) {
      project.triggers[existing] = triggerRecord;
    } else {
      project.triggers.push(triggerRecord);
    }
    saveRegistry(registry);

    return text({
      success: true,
      projectId,
      functionName,
      schedule: triggerRecord.description,
      triggerId,
      message: `Scheduled. ${triggerRecord.description} To stop, call unschedule_automation.`,
    });
  },

  unschedule_automation: async (args, _ctx) => {

    const projectId = args.projectId as string;
    const functionName = args.functionName as string;

    const registry = loadRegistry();
    const project = registry.projects[projectId];
    if (!project) throw new McpError(ErrorCode.InvalidRequest, `Project "${projectId}" not found.`);

    if (project.webAppUrl) {
      try {
        await callWebApp(project.webAppUrl, '_agsUnschedule', { functionName });
      } catch {
        // Best-effort: remove from registry even if web app call fails
      }
    }

    const before = project.triggers.length;
    project.triggers = project.triggers.filter((t) => t.fnName !== functionName);
    saveRegistry(registry);

    const removed = before - project.triggers.length;
    return text({
      success: true,
      projectId,
      functionName,
      removed,
      message: removed > 0 ? `Schedule removed for "${functionName}".` : `No schedule found for "${functionName}".`,
    });
  },

  view_schedule: async (args, _ctx) => {
    const projectId = args.projectId as string;
    const functionName = args.functionName as string | undefined;

    const registry = loadRegistry();
    const project = registry.projects[projectId];
    if (!project) throw new McpError(ErrorCode.InvalidRequest, `Project "${projectId}" not found.`);

    const triggers = functionName
      ? project.triggers.filter((t) => t.fnName === functionName)
      : project.triggers;

    return text({
      projectId,
      displayName: project.displayName,
      triggers,
      count: triggers.length,
      message:
        triggers.length > 0
          ? `${triggers.length} active schedule(s).`
          : 'No schedules configured. Use schedule_automation to add one.',
    });
  },
};

function buildScheduleDescription(
  type: string,
  hour: number,
  dayOfWeek: number,
): string {
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const h = `${hour}:00`;
  if (type === 'hourly') return 'Runs every hour.';
  if (type === 'daily') return `Runs every day at ${h}.`;
  if (type === 'weekly') return `Runs every ${days[(dayOfWeek - 1) % 7] ?? 'Monday'} at ${h}.`;
  return `Runs on schedule: ${type}.`;
}
