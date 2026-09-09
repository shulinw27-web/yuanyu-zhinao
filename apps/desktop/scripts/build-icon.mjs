import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const desktopDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await sharp(path.join(desktopDirectory, 'public', 'icon.svg'))
  .resize(512, 512)
  .png({ compressionLevel: 9 })
  .toFile(path.join(desktopDirectory, 'build', 'icon.png'));
