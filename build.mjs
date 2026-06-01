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
await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: 'dist/index.js',
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
//     ESM format is required because @google/clasp uses top-level await.
//     resolveNode() ensures only Node.js ≥ v16 (stable ESM) is used;
//     on machines without a suitable node it falls back to Electron with
//     ELECTRON_RUN_AS_NODE=1, which also supports ESM.
await esbuild.build({
  entryPoints: ['node_modules/@google/clasp/build/src/index.js'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: 'dist/clasp-cli.js',
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
const code = readFileSync(join(__dirname, 'dist/index.js'), 'utf8');
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
writeFileSync(join(__dirname, 'dist/index.js'), obfuscated.getObfuscatedCode());

console.log('Obfuscation complete');

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
