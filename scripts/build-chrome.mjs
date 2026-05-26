import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'dist/chrome');

const files = [
  'manifest.json',
  'background.js',
  'content.js',
  'offscreen.html',
  'offscreen.js',
  'popup.html',
  'popup.js',
  'bridge.js',
  'LICENSE'
];

const directories = [
  'vendor',
  'models'
];

assertInsideRoot(outDir);

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const file of files) {
  await cp(join(root, file), join(outDir, file));
}

for (const directory of directories) {
  await cp(join(root, directory), join(outDir, directory), { recursive: true });
}

console.log(`Chrome extension build written to ${relative(root, outDir).replaceAll('\\', '/')}`);

function assertInsideRoot(target) {
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || resolve(target) === root) {
    throw new Error(`Refusing to clean unsafe build path: ${target}`);
  }
}
