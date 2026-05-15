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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'list_automations') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(registry.projects, null, 2),
        },
      ],
    };
  }
  throw new Error(`Unknown tool: ${request.params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
