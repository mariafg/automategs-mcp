import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import { resolveTier } from './auth/license.js';
import { isClaspAuthenticated, runClaspLogin, testClaspConnection } from './auth/clasp.js';
import { loadRegistry, saveRegistry } from './registry/projects.js';
import { CONFIG_DIR, SCRIPTS_DIR, APPS_SCRIPT_SETTINGS_URL } from './utils/constants.js';
import type { ToolEntry } from './tools/types.js';

import { registerTool as registerListAutomations } from './tools/list_automations.js';
import { registerTool as registerCreateAutomation } from './tools/create_automation.js';
import { registerTool as registerUpdateAutomation } from './tools/update_automation.js';
import { registerTool as registerRunAutomation } from './tools/run_automation.js';
import { registerTool as registerCheckStatus } from './tools/check_status.js';
import { registerTool as registerScheduleAutomation } from './tools/schedule_automation.js';
import { registerTool as registerUnscheduleAutomation } from './tools/unschedule_automation.js';
import { registerTool as registerViewSchedule } from './tools/view_schedule.js';

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

console.error(
  '[AutomateGS] Ready | tier: ' + tier +
    ' | automations: ' + Object.keys(registry.projects).length +
    ' | executions: ' + registry.totalExecutions,
);

// 6. Collect all tool definitions
const tools: ToolEntry[] = [];
registerListAutomations(tools, tier);
registerCreateAutomation(tools, tier);
registerUpdateAutomation(tools, tier);
registerRunAutomation(tools, tier);
registerCheckStatus(tools, tier);
registerScheduleAutomation(tools, tier);
registerUnscheduleAutomation(tools, tier);
registerViewSchedule(tools, tier);

// 7. Create and configure MCP server
const server = new Server(
  { name: 'automategs-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find((t) => t.name === request.params.name);
  if (!tool) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }
  return tool.handler((request.params.arguments ?? {}) as Record<string, unknown>);
});

const transport = new StdioServerTransport();
await server.connect(transport);
