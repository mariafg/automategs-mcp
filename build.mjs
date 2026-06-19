import { rimraf } from 'rimraf';
import esbuild from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
const buildTime = new Date().toISOString();

console.log(`Building automategs-mcp v${pkg.version} at ${buildTime}`);

// 1. Clean dist/
await rimraf(join(__dirname, 'dist'));

// 2. esbuild bundle — inject version + build timestamp as compile-time constants
//    Output as .mjs (not .js): the .mcpb ships no package.json, so a plain
//    .js file's module type depends on Node auto-detecting ESM syntax from
//    the bare file — a feature only on by default since Node 22.7. When
//    Claude Desktop falls back to its own (older) bundled Electron Node
//    because no system Node was found, that auto-detection isn't there,
//    so the bundle gets parsed as CommonJS and crashes immediately on the
//    top-level `import` statement, before any of our own logging runs.
//    .mjs always parses as ESM regardless of Node version or nearby
//    package.json — same fix already applied to clasp-cli below.
await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: 'dist/index.mjs',
  format: 'esm',
  external: [],
  define: {
    __PKG_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});

console.log('esbuild bundle complete');

// 2b. Bundle clasp CLI as a sibling script — used at runtime via
//     spawn(nodeExec, [claspCliPath, ...args]) so npx is not required.
//     Output as .mjs (not .js): when nodeExec is a real system Node found
//     on the user's machine (not the Electron host's own launcher), Node
//     determines module type purely from file extension / nearest
//     package.json. We ship no package.json next to dist/, so a plain .js
//     file would default to CommonJS and fail on the bundle's top-level
//     `import` statements. .mjs always parses as ESM regardless of that.
await esbuild.build({
  entryPoints: ['node_modules/@google/clasp/build/src/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: 'dist/clasp-cli.mjs',
  format: 'esm',
  external: [],
  // esbuild sometimes auto-injects var __dirname / var __filename.
  // Using var (not const) in the banner means two var declarations of the
  // same name are legal (they merge); const + var would be a SyntaxError.
  banner: {
    js: [
      "import { createRequire as __cr } from 'module';",
      "import { fileURLToPath as __fu } from 'url';",
      "import { dirname as __pd } from 'path';",
      'const require = __cr(import.meta.url);',
      'var __filename = __fu(import.meta.url);',
      'var __dirname = __pd(__filename);',
    ].join('\n'),
  },
});

console.log('clasp-cli bundle complete');

// 3. Obfuscate — string array only.
//    controlFlowFlattening and deadCodeInjection both restructure async/await
//    into switch-state machines that break Promise chains in Node.js MCP servers.
//    rc4 encoding removed: RC4 key-scheduling runs a 256-step init loop per encoded
//    string, which is too slow in Electron's V8 context — Claude Desktop kills the
//    process before initialize can respond. base64 decodes in O(n), startup is instant.
const code = readFileSync(join(__dirname, 'dist/index.mjs'), 'utf8');
const obfuscated = JavaScriptObfuscator.obfuscate(code, {
  compact: true,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  identifierNamesGenerator: 'hexadecimal',
  selfDefending: false,
});
writeFileSync(join(__dirname, 'dist/index.mjs'), obfuscated.getObfuscatedCode());

console.log('Obfuscation complete');

// 3b. Write a tiny, unbundled, unobfuscated launcher as the real entry point.
//     This exists purely for diagnostics: if dist/index.mjs ever fails during
//     its own module evaluation (a SyntaxError from a Node-version mismatch,
//     a native module ABI mismatch, etc.), a *static* import of it would
//     crash the whole process before any of our own console.error/dbg calls
//     inside index.mjs get a chance to run — which is exactly why earlier
//     crashes showed up as total silence in the MCP logs. Loading it via
//     dynamic import() instead means a throw during evaluation surfaces as a
//     rejected promise we can catch right here and log, with the running
//     version/build time printed unconditionally first.
const launcherSrc = [
  "import fs from 'fs';",
  "import os from 'os';",
  "import { dirname, join } from 'path';",
  "import { fileURLToPath } from 'url';",
  '',
  "const __dirname = dirname(fileURLToPath(import.meta.url));",
  `const VERSION = ${JSON.stringify(pkg.version)};`,
  `const BUILD_TIME = ${JSON.stringify(buildTime)};`,
  "const DBG_LOG = join(os.tmpdir(), 'automategs-debug.log');",
  'function dbg(msg) { try { fs.appendFileSync(DBG_LOG, `${new Date().toISOString()} [launcher] ${msg}\\n`); } catch {} }',
  '',
  'console.error(`[AutomateGS] launcher starting — v${VERSION} built ${BUILD_TIME} — node ${process.version} — pid ${process.pid}`);',
  'dbg(`launcher starting v${VERSION} built ${BUILD_TIME} node ${process.version} pid ${process.pid} execPath ${process.execPath} platform ${process.platform} arch ${process.arch}`);',
  '',
  'try {',
  "  await import(join(__dirname, 'index.mjs'));",
  "  dbg('launcher: index.mjs loaded and ran without throwing during import');",
  '} catch (err) {',
  '  const detail = err && err.stack ? err.stack : String(err);',
  '  console.error(`[AutomateGS] FATAL: index.mjs failed to load (v${VERSION})`);',
  '  console.error(detail);',
  "  dbg(`launcher: FATAL index.mjs failed to load: ${detail}`);",
  '  process.exitCode = 1;',
  '}',
  '',
].join('\n');
writeFileSync(join(__dirname, 'dist/launcher.mjs'), launcherSrc);
console.log('Wrote launcher.mjs');

// 4. Copy manifest.json, CLAUDE.md, icon.png to dist/
const filesToCopy = ['manifest.json', 'CLAUDE.md', 'icon.png'];
for (const file of filesToCopy) {
  const src = join(__dirname, file);
  const dest = join(__dirname, 'dist', file);
  if (existsSync(src)) {
    copyFileSync(src, dest);
    console.log(`Copied ${file} to dist/`);
  } else if (file === 'icon.png') {
    writeFileSync(dest, '');
    console.log('Created empty icon.png in dist/');
  } else {
    console.warn(`WARNING: ${file} not found — skipped`);
  }
}

console.log('Build complete');
