import { createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, rm } from 'node:fs/promises';
import { get } from 'node:https';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(root, 'vendor');
const modelsDir = join(root, 'models');

const modelBase =
  'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights';
const modelFiles = [
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model-shard1',
  'age_gender_model-weights_manifest.json',
  'age_gender_model-shard1'
];

assertInsideRoot(vendorDir);
assertInsideRoot(modelsDir);
await rm(vendorDir, { recursive: true, force: true });
await rm(modelsDir, { recursive: true, force: true });
await mkdir(vendorDir, { recursive: true });
await mkdir(modelsDir, { recursive: true });

await copyFirstExisting(
  [
    'node_modules/@vladmandic/face-api/dist/face-api.js',
    'node_modules/@vladmandic/face-api/dist/face-api.min.js'
  ],
  'vendor/face-api.min.js'
);

await copyFirstExisting(
  [
    'node_modules/@tensorflow-models/coco-ssd/dist/coco-ssd.min.js',
    'node_modules/@tensorflow-models/coco-ssd/dist/coco-ssd.js'
  ],
  'vendor/coco-ssd.min.js'
);

for (const file of modelFiles) {
  await download(`${modelBase}/${file}`, join(modelsDir, file));
}

console.log('NoMoreSoyFace assets ready.');

async function copyFirstExisting(candidates, destination) {
  for (const candidate of candidates) {
    const source = join(root, candidate);
    try {
      await access(source);
      await copyFile(source, join(root, destination));
      return;
    } catch {}
  }

  throw new Error(`Could not find asset for ${destination}. Run npm install first.`);
}

function download(url, destination, redirects = 0) {
  return new Promise((resolveDownload, rejectDownload) => {
    const req = get(url, (res) => {
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location &&
        redirects < 5
      ) {
        res.resume();
        resolveDownload(download(new URL(res.headers.location, url).toString(), destination, redirects + 1));
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        rejectDownload(new Error(`Failed to download ${url}: HTTP ${res.statusCode}`));
        return;
      }

      const file = createWriteStream(destination);
      res.pipe(file);
      file.on('finish', () => file.close(resolveDownload));
      file.on('error', rejectDownload);
    });

    req.on('error', rejectDownload);
  });
}

function assertInsideRoot(target) {
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || resolve(target) === root) {
    throw new Error(`Refusing to clean unsafe asset path: ${target}`);
  }
}
