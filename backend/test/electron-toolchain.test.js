import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { listenOnFetchableLoopback } from './http-fixture-port.js';

// Resolve exactly the downloader used by app-builder-lib, not Electron's own copy.
const rootRequire = createRequire(import.meta.url);
const builderRequire = createRequire(rootRequire.resolve('app-builder-lib/package.json'));
const downloader = builderRequire('@electron/get');

test('packager resolves the pinned downloader override and preserves its required API', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.overrides['@electron/get'], '5.1.0');
  assert.equal(typeof downloader.downloadArtifact, 'function');
  assert.equal(typeof downloader.initializeProxy, 'function');
  assert.equal(typeof downloader.ElectronDownloadCacheMode.ReadWrite, 'number');
  assert.doesNotThrow(() => builderRequire('./out/util/electronGet.js'));
  const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'));
  const copies = Object.entries(lock.packages).filter(([name]) => name.endsWith('node_modules/@electron/get'));
  assert.ok(copies.length > 0);
  assert.ok(copies.every(([, info]) => info.version === '5.1.0'));
  assert.ok(!Object.keys(lock.packages).some(name => /node_modules\/(?:sprintf-js|global-agent|roarr)$/u.test(name)));
});

test('packager downloader uses loopback HTTP and verifies hashes without disabling checksums', async t => {
  const bytes = Buffer.from('synthetic-electron-artifact');
  let requests = 0;
  const server = createServer((req, res) => {
    if (req.method === 'HEAD') { res.end(); return; }
    requests++; res.writeHead(200, { 'Content-Length': bytes.length }); res.end(bytes);
  });
  const url = await listenOnFetchableLoopback(server);
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'yuanyu-electron-download-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const details = { version: '43.7.9', artifactName: 'fixture.txt', isGeneric: true,
    cacheRoot: path.join(temporary, 'cache'), tempDirectory: temporary,
    mirrorOptions: { mirror: `${url}/`, customDir: 'fixture', customFilename: 'fixture.txt',
      resolveAssetURL: () => `${url}/fixture/fixture.txt` },
    checksums: { 'fixture.txt': createHash('sha256').update(bytes).digest('hex') },
    downloadOptions: { quiet: true } };
  const file = await downloader.downloadArtifact(details);
  assert.deepEqual(await readFile(file), bytes);
  assert.ok(requests > 0);
  await assert.rejects(downloader.downloadArtifact({ ...details, cacheMode: downloader.ElectronDownloadCacheMode.Bypass,
    checksums: { 'fixture.txt': '0'.repeat(64) } }), /checksum|mismatch/iu);
});
