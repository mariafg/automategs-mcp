// Keep stdin open immediately — prevents the process from exiting before the
// MCP transport registers its own stdin listener.  Must be the very first
// executable statement so it takes effect even if later async code is slow.
process.stdin.resume();

// File-based debug logger — writes to /tmp so it's visible even when the DXT
// runner doesn't forward stderr to the MCP log.
import fs from 'fs';
const _dbg = (msg: string) => {
  try { fs.appendFileSync('/tmp/automategs-debug.log', `${new Date().toISOString()} ${msg}\n`); } catch {}
};
_dbg(`PROCESS START pid=${process.pid} node=${process.execPath}`);
// Build version is injected at compile time — log it immediately so the
// debug file always shows which .mcpb is installed.
declare const __PKG_VERSION__: string;
declare const __BUILD_TIME__: string;
const _VERSION = typeof __PKG_VERSION__ !== 'undefined' ? __PKG_VERSION__ : 'dev';
const _BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'unknown';
_dbg(`BUILD v${_VERSION} built=${_BUILD_TIME}`);

// Catch any unhandled async errors that would otherwise kill the process
// silently.  Log them to stderr (visible in MCP logs) and keep running.
process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.stack ?? String(reason) : String(reason);
  console.error('[AutomateGS] UNHANDLED REJECTION — this is a bug, please report it');
  console.error(msg);
  _dbg(`UNHANDLED_REJECTION ${msg}`);
});

process.on('uncaughtException', (err: Error) => {
  const msg = err.stack ?? String(err);
  console.error('[AutomateGS] UNCAUGHT EXCEPTION — this is a bug, please report it');
  console.error(msg);
  _dbg(`UNCAUGHT_EXCEPTION ${msg}`);
});

process.on('exit', (code) => {
  _dbg(`PROCESS EXIT code=${code}`);
});

process.on('SIGTERM', () => {
  _dbg('SIGTERM received');
  process.exit(0);
});

process.on('SIGINT', () => {
  _dbg('SIGINT received');
  process.exit(0);
});

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
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
let pendingAuthUrl: string | null = null;

// Resolves as soon as startupState leaves 'pending' (auth check done).
// Tool calls await this so they don't fire back an error during the first
// 1-2 seconds of init — eliminating the spurious "Failed to call tool" UI flash.
let _startupResolve: () => void;
const startupSettled = new Promise<void>(resolve => { _startupResolve = resolve; });
function settleStartup() { try { _startupResolve(); } catch {} }

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
    // Wait up to 15 s for init to finish — covers the normal 1-2 s startup
    // without triggering the "Failed to call tool" flash in Claude Desktop.
    await Promise.race([startupSettled, new Promise(r => setTimeout(r, 15_000))]);
  }

  if (startupState === 'authenticating') {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        status: 'authenticating',
        message: pendingAuthUrl
          ? `AutomateGS needs to connect to your Google account. Please open this URL in your browser to sign in:\n\n${pendingAuthUrl}\n\nOnce you complete sign-in, try your request again.`
          : 'A Google sign-in tab is opening in your browser. Complete the sign-in there, then try again.',
        auth_url: pendingAuthUrl,
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

// Debug: log if stdin closes unexpectedly so we can diagnose crashes in
// DXT environments where stderr is not forwarded to the MCP log.
process.stdin.once('end', () => {
  try { fs.appendFileSync('/tmp/automategs-debug.log', `${new Date().toISOString()} stdin EOF\n`); } catch {}
});
process.stdin.once('close', () => {
  try { fs.appendFileSync('/tmp/automategs-debug.log', `${new Date().toISOString()} stdin CLOSE\n`); } catch {}
});

// ---------------------------------------------------------------------------
// Background initialisation
// ---------------------------------------------------------------------------
console.error(`[AutomateGS] [5/6] Starting background initialisation…`);

(async () => {
  _dbg('IIFE start');
  try {
    // License
    _dbg('license start');
    console.error(`[AutomateGS]       Resolving license tier…`);
    currentTier = await resolveTier(process.env.LICENSE_KEY);
    _dbg(`license done tier=${currentTier}`);
    console.error(`[AutomateGS]       Tier: ${currentTier}`);

    // Clasp auth
    _dbg('clasp auth check');
    console.error(`[AutomateGS]       Checking clasp authentication…`);
    const authed = isClaspAuthenticated();
    _dbg(`clasp authed=${authed}`);
    console.error(`[AutomateGS]       isClaspAuthenticated = ${authed}`);

    if (!authed) {
      startupState = 'authenticating';
      settleStartup();
      console.error(`[AutomateGS]       Opening Google sign-in in browser…`);
      try {
        await runClaspLoginBrowser((url) => {
          pendingAuthUrl = url;
          _dbg(`auth_url ready: ${url}`);
          console.error(`[AutomateGS]       Auth URL: ${url}`);
        });
        pendingAuthUrl = null;
        console.error(`[AutomateGS]       Google authentication complete`);
      } catch (err) {
        startupState = 'auth_required';
        startupMessage = `Google sign-in failed: ${String(err)}`;
        console.error(`[AutomateGS]       ${startupMessage}`);
        _dbg(`auth_required: ${startupMessage}`);
        return;
      }
    }

    // Clasp API connectivity
    _dbg('clasp connection test start');
    console.error(`[AutomateGS]       Testing Apps Script API connectivity…`);
    const claspStatus = await testClaspConnection();
    _dbg(`clasp connection test done status=${claspStatus}`);
    console.error(`[AutomateGS]       Clasp status: ${claspStatus}`);

    if (claspStatus === 'api_disabled') {
      startupState = 'api_disabled';
      settleStartup();
      startupMessage = `Apps Script API not enabled. Visit ${APPS_SCRIPT_SETTINGS_URL} to enable it.`;
      console.error(`[AutomateGS]       ${startupMessage}`);
      _dbg(`api_disabled`);
      return;
    }

    // Registry
    _dbg('registry load start');
    console.error(`[AutomateGS]       Loading registry…`);
    const registry = loadRegistry();
    registry.tier = currentTier;
    saveRegistry(registry);
    const projectCount = Object.keys(registry.projects).length;
    console.error(`[AutomateGS]       Registry loaded — ${projectCount} automation(s), ${registry.totalExecutions} execution(s)`);

    startupState = 'ready';
    settleStartup();
    _dbg(`READY tier=${currentTier} automations=${projectCount}`);
    console.error(`[AutomateGS] [6/6] ✓ Ready | v${VERSION} | tier: ${currentTier} | automations: ${projectCount}`);
  } catch (err) {
    startupState = 'error';
    settleStartup();
    startupMessage = String(err);
    const errStack = err instanceof Error ? err.stack ?? String(err) : String(err);
    console.error(`[AutomateGS]       STARTUP ERROR: ${startupMessage}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    _dbg(`IIFE ERROR: ${errStack}`);
  }
  _dbg('IIFE complete');
})();
