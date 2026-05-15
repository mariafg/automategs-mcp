import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import { resolveTier } from './auth/license.js';
import { isClaspAuthenticated, runClaspLogin, testClaspConnection } from './auth/clasp.js';
import { loadRegistry, saveRegistry, getProject } from './registry/projects.js';
import { CONFIG_DIR, SCRIPTS_DIR, APPS_SCRIPT_SETTINGS_URL } from './utils/constants.js';
import { callWebApp } from './tools/web-app.js';
import {
  handleCreateAutomation,
  handleUpdateAutomation,
  handleRunAutomation,
  handleCheckStatus,
  handleScheduleAutomation,
  handleUnscheduleAutomation,
  handleViewSchedule,
  handleListTemplates,
  handleInstallTemplate,
} from './tools/automations.js';
import { handlePreviewAutomation } from './tools/preview_automation.js';
import { handleActivateAutomation } from './tools/activate_automation.js';
import { handleDiscardPreview } from './tools/discard_preview.js';
import { handleConnectVersionControl } from './tools/github-tools.js';
import type { Registry } from './registry/types.js';

// 1. Ensure config directories exist
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(SCRIPTS_DIR, { recursive: true });

// 2. Resolve license tier
const licenseKey = process.env.LICENSE_KEY;
const tier = await resolveTier(licenseKey);

// 3. Clasp authentication
if (!isClaspAuthenticated()) {
  await runClaspLogin();
}

// 4. Test clasp connection
const claspStatus = await testClaspConnection();
if (claspStatus === 'api_disabled') {
  console.error(
    '[AutomateGS] Apps Script API is not enabled.\n' +
      'Please visit ' + APPS_SCRIPT_SETTINGS_URL + '\n' +
      'Toggle "Google Apps Script API" on, then restart AutomateGS.',
  );
  process.exit(1);
}

// 5. Load and update registry
const registry = loadRegistry();
registry.tier = tier;
saveRegistry(registry);

// 6. Cleanup orphaned preview sheets from previous sessions
async function cleanupOrphanedPreviews(reg: Registry): Promise<void> {
  try {
    const projects = Object.values(reg.projects).filter((p) => p.stagingTempSheetId);
    for (const project of projects) {
      try {
        if (!project.webAppUrl) continue;
        await callWebApp({
          webAppUrl: project.webAppUrl,
          fnName: '_ags_del',
          parameters: { fileId: project.stagingTempSheetId! },
        });
        project.stagingTempSheetId = undefined;
        const fresh = getProject(project.id);
        if (fresh) {
          fresh.stagingTempSheetId = undefined;
          const { upsertProject } = await import('./registry/projects.js');
          upsertProject(fresh);
        }
        console.error('[AutomateGS] Cleaned up orphaned preview sheet for ' + project.displayName);
      } catch (err) {
        console.error('[AutomateGS] Could not clean up preview for ' + project.displayName + ':', err);
      }
    }
  } catch (err) {
    console.error('[AutomateGS] Orphan cleanup error (non-fatal):', err);
  }
}

await cleanupOrphanedPreviews(registry);

console.error(
  '[AutomateGS] Ready | tier: ' + tier +
    ' | automations: ' + Object.keys(registry.projects).length +
    ' | executions: ' + registry.totalExecutions,
);

// Create MCP server
const server = new Server(
  { name: 'automategs-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_automations',
      description: 'List all your AutomateGS automations.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'create_automation',
      description: 'Create a new AutomateGS automation project and register it.',
      inputSchema: {
        type: 'object',
        properties: {
          displayName: { type: 'string', description: 'Human-readable project name' },
          scriptId: { type: 'string', description: 'Google Apps Script project ID' },
          webAppUrl: { type: 'string', description: 'Deployed web app URL (optional)' },
          functionName: { type: 'string', description: 'Entry-point function name' },
          projectId: { type: 'string', description: 'Optional custom project ID' },
        },
        required: ['displayName', 'scriptId', 'functionName'],
      },
    },
    {
      name: 'update_automation',
      description: 'Update an existing automation with a new web app URL or deployment ID.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          functionName: { type: 'string' },
          webAppUrl: { type: 'string' },
          deploymentId: { type: 'string' },
        },
        required: ['projectId', 'functionName'],
      },
    },
    {
      name: 'run_automation',
      description: 'Run an automation immediately on your real data.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          functionName: { type: 'string' },
          parameters: { type: 'object', description: 'Optional parameters to pass to the function' },
        },
        required: ['projectId', 'functionName'],
      },
    },
    {
      name: 'check_status',
      description: 'Check the current status of an automation project.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
        },
        required: ['projectId'],
      },
    },
    {
      name: 'schedule_automation',
      description: 'Schedule an automation to run on a recurring basis.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          functionName: { type: 'string' },
          frequency: { type: 'string', description: 'e.g. "daily", "hourly", "every 6 hours"' },
          description: { type: 'string' },
          params: { type: 'object' },
        },
        required: ['projectId', 'functionName', 'frequency'],
      },
    },
    {
      name: 'unschedule_automation',
      description: 'Remove a scheduled trigger from an automation.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          triggerId: { type: 'string' },
        },
        required: ['projectId', 'triggerId'],
      },
    },
    {
      name: 'view_schedule',
      description: 'View all active schedules for your automations.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Filter by project (optional)' },
        },
      },
    },
    {
      name: 'list_templates',
      description: 'Browse available AutomateGS automation templates.',
      inputSchema: {
        type: 'object',
        properties: {
          tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
          surface: { type: 'string', description: '"sheets" or "standalone"' },
        },
      },
    },
    {
      name: 'install_template',
      description: 'Create an automation from a template.',
      inputSchema: {
        type: 'object',
        properties: {
          templateId: { type: 'string' },
          displayName: { type: 'string' },
          scriptId: { type: 'string', description: 'Google Apps Script project ID' },
          webAppUrl: { type: 'string' },
        },
        required: ['templateId', 'scriptId'],
      },
    },
    {
      name: 'preview_automation',
      description:
        'Run an automation on a copy of your sheet to check the results before applying them to ' +
        'your real data. Safe to run as many times as needed. Requires Pro or Agency tier.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          functionName: { type: 'string' },
          sheetId: { type: 'string', description: 'Google Sheets ID to copy and preview against' },
          parameters: { type: 'object', description: 'Optional extra parameters for the function' },
        },
        required: ['projectId', 'functionName', 'sheetId'],
      },
    },
    {
      name: 'activate_automation',
      description:
        'Activate an automation after reviewing the preview. Once active, the automation is ' +
        'ready to run on your real data and can be scheduled.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session ID returned by preview_automation' },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'discard_preview',
      description:
        'Discard a preview. The temporary sheet is deleted and the automation returns to ' +
        'draft status for further editing.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'connect_version_control',
      description:
        'Connect GitHub to AutomateGS for version control and portable access to your ' +
        'automations from any device. Agency tier feature.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    let result: unknown;

    if (name === 'list_automations') {
      result = loadRegistry().projects;
    } else if (name === 'create_automation') {
      result = await handleCreateAutomation(tier, a as Parameters<typeof handleCreateAutomation>[1]);
    } else if (name === 'update_automation') {
      result = await handleUpdateAutomation(tier, a as Parameters<typeof handleUpdateAutomation>[1]);
    } else if (name === 'run_automation') {
      result = await handleRunAutomation(tier, a as Parameters<typeof handleRunAutomation>[1]);
    } else if (name === 'check_status') {
      result = await handleCheckStatus(tier, a as Parameters<typeof handleCheckStatus>[1]);
    } else if (name === 'schedule_automation') {
      result = await handleScheduleAutomation(tier, a as Parameters<typeof handleScheduleAutomation>[1]);
    } else if (name === 'unschedule_automation') {
      result = await handleUnscheduleAutomation(tier, a as Parameters<typeof handleUnscheduleAutomation>[1]);
    } else if (name === 'view_schedule') {
      result = await handleViewSchedule(tier, a as Parameters<typeof handleViewSchedule>[1]);
    } else if (name === 'list_templates') {
      result = await handleListTemplates(tier, a as Parameters<typeof handleListTemplates>[1]);
    } else if (name === 'install_template') {
      result = await handleInstallTemplate(tier, a as Parameters<typeof handleInstallTemplate>[1]);
    } else if (name === 'preview_automation') {
      result = await handlePreviewAutomation(tier, a as Parameters<typeof handlePreviewAutomation>[1]);
    } else if (name === 'activate_automation') {
      result = await handleActivateAutomation(tier, a as Parameters<typeof handleActivateAutomation>[1]);
    } else if (name === 'discard_preview') {
      result = await handleDiscardPreview(tier, a as Parameters<typeof handleDiscardPreview>[1]);
    } else if (name === 'connect_version_control') {
      result = await handleConnectVersionControl(tier);
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
