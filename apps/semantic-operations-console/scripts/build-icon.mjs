import fs from 'node:fs/promises';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDirectory = path.join(appDirectory, 'build');
await fs.mkdir(buildDirectory, { recursive: true });
await sharp(path.join(appDirectory, 'public', 'icon.svg'))
  .resize(512, 512)
  .png({ compressionLevel: 9 })
  .toFile(path.join(buildDirectory, 'icon.png'));
