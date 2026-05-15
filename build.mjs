import { rimraf } from 'rimraf';
import esbuild from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 1. Clean dist/
await rimraf(join(__dirname, 'dist'));

// 2. esbuild bundle
await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: 'dist/index.js',
  format: 'esm',
  external: ['keytar'],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});

console.log('esbuild bundle complete');

// 3. javascript-obfuscator on dist/index.js
const code = readFileSync(join(__dirname, 'dist/index.js'), 'utf8');
const obfuscated = JavaScriptObfuscator.obfuscate(code, {
  compact: true,
  stringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayThreshold: 0.75,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
  identifierNamesGenerator: 'hexadecimal',
  selfDefending: true,
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
    // Create empty icon.png if not present
    writeFileSync(dest, '');
    console.log('Created empty icon.png in dist/');
  }
}

console.log('Build complete');
