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
import { isClaspAuthenticated, testClaspConnection } from './auth/clasp.js';
import { loadRegistry, saveRegistry } from './registry/projects.js';
import { CONFIG_DIR, SCRIPTS_DIR, APPS_SCRIPT_SETTINGS_URL } from './utils/constants.js';
import type { Tier } from './registry/types.js';

import { tools as automationTools, handlers as automationHandlers } from './tools/automations.js';
import { tools as schedulingTools, handlers as schedulingHandlers } from './tools/scheduling.js';
import { tools as previewTools, handlers as previewHandlers } from './tools/preview.js';
import { tools as versionTools, handlers as versionHandlers } from './tools/version-control.js';
import { tools as listTemplateTools, handlers as listTemplateHandlers } from './tools/list-templates.js';
import { tools as addTemplateTools, handlers as addTemplateHandlers } from './tools/add-template.js';

// Ensure config directories exist (sync, safe at any point)
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(SCRIPTS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Startup state — initialised in the background after transport is connected
// ---------------------------------------------------------------------------
type StartupState = 'pending' | 'auth_required' | 'api_disabled' | 'error' | 'ready';
let startupState: StartupState = 'pending';
let startupMessage = '';
let currentTier: Tier = 'free';

// ---------------------------------------------------------------------------
// Collect tools and handlers
// ---------------------------------------------------------------------------
const allTools = [
  ...automationTools,
  ...schedulingTools,
  ...previewTools,
  ...versionTools,
  ...listTemplateTools,
  ...addTemplateTools,
];

type Handler = (
  args: Record<string, unknown>,
  ctx: { registry: ReturnType<typeof loadRegistry>; tier: Tier },
) => Promise<{ content: Array<{ type: string; text: string }> }>;

const allHandlers = new Map<string, Handler>([
  ...Object.entries(automationHandlers),
  ...Object.entries(schedulingHandlers),
  ...Object.entries(previewHandlers),
  ...Object.entries(versionHandlers),
  ...Object.entries(listTemplateHandlers),
  ...Object.entries(addTemplateHandlers),
]);

// ---------------------------------------------------------------------------
// MCP server — created and connected BEFORE any async startup work
// ---------------------------------------------------------------------------
const server = new Server(
  { name: 'automategs-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  // Tools that work regardless of clasp state
  const claspFreeTools = new Set(['list_automations', 'list_templates', 'check_status']);

  if (startupState === 'pending' && !claspFreeTools.has(name)) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'initializing',
          message: 'AutomateGS is still starting up. Please wait a moment and try again.',
        }),
      }],
    };
  }

  if (startupState === 'auth_required') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'clasp authentication required',
          message: startupMessage,
          instructions: [
            'Run this command in your terminal (outside Claude), then restart AutomateGS:',
            '',
            '  npx @google/clasp login',
            '',
            'A browser window will open for Google sign-in.',
          ].join('\n'),
        }),
      }],
    };
  }

  if (startupState === 'api_disabled') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'Google Apps Script API not enabled',
          message: startupMessage,
          instructions: `Enable it at: ${APPS_SCRIPT_SETTINGS_URL}\nThen restart AutomateGS.`,
        }),
      }],
    };
  }

  if (startupState === 'error') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: 'AutomateGS startup failed', message: startupMessage }),
      }],
    };
  }

  const handler = allHandlers.get(name);
  if (!handler) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }

  const currentRegistry = loadRegistry();
  return handler(args, { registry: currentRegistry, tier: currentTier });
});

// Connect transport first — this lets the MCP client complete its handshake
// immediately, before any slow startup work begins.
const transport = new StdioServerTransport();
await server.connect(transport);

// ---------------------------------------------------------------------------
// Background initialisation — runs after the MCP handshake is complete
// ---------------------------------------------------------------------------
(async () => {
  try {
    // 1. Resolve license tier
    currentTier = await resolveTier(process.env.LICENSE_KEY);

    // 2. Check clasp authentication
    if (!isClaspAuthenticated()) {
      startupState = 'auth_required';
      startupMessage =
        'clasp is not authenticated. Run "npx @google/clasp login" in a terminal, then restart AutomateGS.';
      console.error('[AutomateGS] ' + startupMessage);
      return;
    }

    // 3. Test connection / API availability
    const claspStatus = await testClaspConnection();
    if (claspStatus === 'api_disabled') {
      startupState = 'api_disabled';
      startupMessage =
        `Apps Script API is not enabled. Visit ${APPS_SCRIPT_SETTINGS_URL} and toggle it on, then restart.`;
      console.error('[AutomateGS] ' + startupMessage);
      return;
    }

    // 4. Load and persist registry
    const registry = loadRegistry();
    registry.tier = currentTier;
    saveRegistry(registry);

    startupState = 'ready';
    console.error(
      `[AutomateGS] Ready | tier: ${currentTier}` +
        ` | automations: ${Object.keys(registry.projects).length}` +
        ` | executions: ${registry.totalExecutions}`,
    );
  } catch (err) {
    startupState = 'error';
    startupMessage = String(err);
    console.error(`[AutomateGS] Startup error: ${startupMessage}`);
  }
})();
