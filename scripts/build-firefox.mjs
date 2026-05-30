import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');
const outDir = resolve(root, 'dist/firefox');

const srcFiles = [
  'background-firefox.js',
  'content.js',
  'popup.html',
  'popup.js',
  'bridge.js',
];

const directories = [
  'vendor',
  'models'
];

assertInsideRoot(outDir);

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// Firefox manifest replaces manifest.json at the extension root
await cp(join(srcDir, 'manifest-firefox.json'), join(outDir, 'manifest.json'));

for (const file of srcFiles) {
  await cp(join(srcDir, file), join(outDir, file));
}

await cp(join(root, 'LICENSE'), join(outDir, 'LICENSE'));

for (const directory of directories) {
  await cp(join(root, directory), join(outDir, directory), { recursive: true });
}

console.log(`Firefox extension build written to ${relative(root, outDir).replaceAll('\\', '/')}`);

function assertInsideRoot(target) {
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || resolve(target) === root) {
    throw new Error(`Refusing to clean unsafe build path: ${target}`);
  }
}
