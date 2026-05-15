// Keep stdin open immediately — prevents the process from exiting before the
// MCP transport registers its own stdin listener.  Must be the very first
// executable statement so it takes effect even if later async code is slow.
process.stdin.resume();

// Catch any unhandled async errors that would otherwise kill the process
// silently.  Log them to stderr (visible in MCP logs) and keep running.
process.on('unhandledRejection', (reason: unknown) => {
  console.error('[AutomateGS] UNHANDLED REJECTION — this is a bug, please report it');
  console.error(reason instanceof Error ? reason.stack ?? String(reason) : String(reason));
});

process.on('uncaughtException', (err: Error) => {
  console.error('[AutomateGS] UNCAUGHT EXCEPTION — this is a bug, please report it');
  console.error(err.stack ?? String(err));
});

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
import { isClaspAuthenticated, runClaspLoginBrowser, testClaspConnection } from './auth/clasp.js';
import { loadRegistry, saveRegistry } from './registry/projects.js';
import { CONFIG_DIR, SCRIPTS_DIR, APPS_SCRIPT_SETTINGS_URL } from './utils/constants.js';
import type { Tier } from './registry/types.js';

import { tools as automationTools, handlers as automationHandlers } from './tools/automations.js';
import { tools as schedulingTools, handlers as schedulingHandlers } from './tools/scheduling.js';
import { tools as previewTools, handlers as previewHandlers } from './tools/preview.js';
import { tools as versionTools, handlers as versionHandlers } from './tools/version-control.js';
import { tools as listTemplateTools, handlers as listTemplateHandlers } from './tools/list-templates.js';
import { tools as addTemplateTools, handlers as addTemplateHandlers } from './tools/add-template.js';

// Injected at build time by esbuild define
declare const __PKG_VERSION__: string;
declare const __BUILD_TIME__: string;

// ---------------------------------------------------------------------------
// Banner — appears in MCP logs immediately on launch
// ---------------------------------------------------------------------------
const VERSION = typeof __PKG_VERSION__ !== 'undefined' ? __PKG_VERSION__ : 'dev';
const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'unknown';

console.error(`[AutomateGS] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.error(`[AutomateGS] AutomateGS MCP  v${VERSION}`);
console.error(`[AutomateGS] Built            ${BUILD_TIME}`);
console.error(`[AutomateGS] Node.js          ${process.version}`);
console.error(`[AutomateGS] PID              ${process.pid}`);
console.error(`[AutomateGS] Platform         ${process.platform}`);
console.error(`[AutomateGS] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

// ---------------------------------------------------------------------------
// Config directories
// ---------------------------------------------------------------------------
console.error(`[AutomateGS] [1/6] Ensuring config directories…`);
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
console.error(`[AutomateGS]       CONFIG_DIR  = ${CONFIG_DIR}`);
console.error(`[AutomateGS]       SCRIPTS_DIR = ${SCRIPTS_DIR}`);

// ---------------------------------------------------------------------------
// Startup state
// ---------------------------------------------------------------------------
type StartupState = 'pending' | 'authenticating' | 'auth_required' | 'api_disabled' | 'error' | 'ready';
let startupState: StartupState = 'pending';
let startupMessage = '';
let currentTier: Tier = 'free';

// ---------------------------------------------------------------------------
// Collect tools and handlers
// ---------------------------------------------------------------------------
console.error(`[AutomateGS] [2/6] Registering tools…`);

const allTools = [
  ...automationTools,
  ...schedulingTools,
  ...previewTools,
  ...versionTools,
  ...listTemplateTools,
  ...addTemplateTools,
];

console.error(`[AutomateGS]       ${allTools.length} tools registered: ${allTools.map((t) => t.name).join(', ')}`);

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
// MCP server
// ---------------------------------------------------------------------------
console.error(`[AutomateGS] [3/6] Creating MCP server…`);

const server = new Server(
  { name: 'automategs-mcp', version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  console.error(`[AutomateGS] → tools/list (state: ${startupState})`);
  return { tools: allTools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  console.error(`[AutomateGS] → tools/call "${name}" (state: ${startupState})`);

  const claspFreeTools = new Set(['list_automations', 'list_templates', 'check_status']);

  if (startupState === 'pending' && !claspFreeTools.has(name)) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        status: 'initializing',
        message: 'AutomateGS is still starting up. Please wait a moment and try again.',
      }) }],
    };
  }

  if (startupState === 'authenticating') {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        status: 'authenticating',
        message: 'A Google sign-in tab just opened in your browser. Complete the sign-in there, then try again.',
      }) }],
    };
  }

  if (startupState === 'auth_required') {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: 'authentication failed',
        message: startupMessage,
        instructions: 'Restart AutomateGS to try again. A browser window will open for Google sign-in.',
      }) }],
    };
  }

  if (startupState === 'api_disabled') {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: 'Google Apps Script API not enabled',
        message: startupMessage,
        instructions: `Enable it at: ${APPS_SCRIPT_SETTINGS_URL}\nThen restart AutomateGS.`,
      }) }],
    };
  }

  if (startupState === 'error') {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: 'AutomateGS startup failed',
        message: startupMessage,
      }) }],
    };
  }

  const handler = allHandlers.get(name);
  if (!handler) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }

  const currentRegistry = loadRegistry();
  return handler(args, { registry: currentRegistry, tier: currentTier });
});

// ---------------------------------------------------------------------------
// Connect transport — must happen before background init so the MCP handshake
// completes immediately and the client doesn't time out.
// ---------------------------------------------------------------------------
console.error(`[AutomateGS] [4/6] Connecting MCP transport (stdio)…`);
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[AutomateGS]       Transport connected — MCP handshake ready`);

// ---------------------------------------------------------------------------
// Background initialisation
// ---------------------------------------------------------------------------
console.error(`[AutomateGS] [5/6] Starting background initialisation…`);

(async () => {
  try {
    // License
    console.error(`[AutomateGS]       Resolving license tier…`);
    currentTier = await resolveTier(process.env.LICENSE_KEY);
    console.error(`[AutomateGS]       Tier: ${currentTier}`);

    // Clasp auth
    console.error(`[AutomateGS]       Checking clasp authentication…`);
    const authed = isClaspAuthenticated();
    console.error(`[AutomateGS]       isClaspAuthenticated = ${authed}`);

    if (!authed) {
      startupState = 'authenticating';
      console.error(`[AutomateGS]       Opening Google sign-in in browser…`);
      try {
        await runClaspLoginBrowser();
        console.error(`[AutomateGS]       Google authentication complete`);
      } catch (err) {
        startupState = 'auth_required';
        startupMessage = `Google sign-in failed: ${String(err)}`;
        console.error(`[AutomateGS]       ${startupMessage}`);
        return;
      }
    }

    // Clasp API connectivity
    console.error(`[AutomateGS]       Testing Apps Script API connectivity…`);
    const claspStatus = await testClaspConnection();
    console.error(`[AutomateGS]       Clasp status: ${claspStatus}`);

    if (claspStatus === 'api_disabled') {
      startupState = 'api_disabled';
      startupMessage = `Apps Script API not enabled. Visit ${APPS_SCRIPT_SETTINGS_URL} to enable it.`;
      console.error(`[AutomateGS]       ${startupMessage}`);
      return;
    }

    // Registry
    console.error(`[AutomateGS]       Loading registry…`);
    const registry = loadRegistry();
    registry.tier = currentTier;
    saveRegistry(registry);
    const projectCount = Object.keys(registry.projects).length;
    console.error(`[AutomateGS]       Registry loaded — ${projectCount} automation(s), ${registry.totalExecutions} execution(s)`);

    startupState = 'ready';
    console.error(`[AutomateGS] [6/6] ✓ Ready | v${VERSION} | tier: ${currentTier} | automations: ${projectCount}`);
  } catch (err) {
    startupState = 'error';
    startupMessage = String(err);
    console.error(`[AutomateGS]       STARTUP ERROR: ${startupMessage}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
  }
})();
