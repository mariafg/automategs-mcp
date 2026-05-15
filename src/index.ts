import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import { resolveTier } from './auth/license.js';
import { isClaspAuthenticated, runClaspLogin, testClaspConnection } from './auth/clasp.js';
import { loadRegistry, saveRegistry } from './registry/projects.js';
import { CONFIG_DIR, SCRIPTS_DIR, APPS_SCRIPT_SETTINGS_URL } from './utils/constants.js';

import { tools as automationTools, handlers as automationHandlers } from './tools/automations.js';
import { tools as schedulingTools, handlers as schedulingHandlers } from './tools/scheduling.js';
import { tools as previewTools, handlers as previewHandlers } from './tools/preview.js';
import { tools as versionTools, handlers as versionHandlers } from './tools/version-control.js';
import { tools as listTemplateTools, handlers as listTemplateHandlers } from './tools/list-templates.js';
import { tools as addTemplateTools, handlers as addTemplateHandlers } from './tools/add-template.js';

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

// Collect all tool definitions
const allTools = [
  ...automationTools,
  ...schedulingTools,
  ...previewTools,
  ...versionTools,
  ...listTemplateTools,
  ...addTemplateTools,
];

// Collect all handlers
const allHandlers = new Map<
  string,
  (args: Record<string, unknown>, ctx: { registry: typeof registry; tier: typeof tier }) => Promise<{ content: Array<{ type: string; text: string }> }>
>([
  ...Object.entries(automationHandlers),
  ...Object.entries(schedulingHandlers),
  ...Object.entries(previewHandlers),
  ...Object.entries(versionHandlers),
  ...Object.entries(listTemplateHandlers),
  ...Object.entries(addTemplateHandlers),
]);

// Create MCP server
const server = new Server(
  { name: 'automategs-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allTools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  const handler = allHandlers.get(name);
  if (!handler) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }

  // Reload registry on each call to pick up external changes
  const currentRegistry = loadRegistry();
  const ctx = { registry: currentRegistry, tier };

  return handler(args, ctx);
});

const transport = new StdioServerTransport();
await server.connect(transport);
