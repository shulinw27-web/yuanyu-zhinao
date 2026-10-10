import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import http from 'node:http';
import { listenOnFetchableLoopback } from './http-fixture-port.js';
import { buildDocsCatalog, renderDocument, createDocsServer } from '../../scripts/local-docs.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuanyu-docs-reader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const folder of ['guides', 'architecture', 'archive', 'reference/exports']) await mkdir(path.join(root, 'docs', folder), { recursive: true });
  await writeFile(path.join(root, 'docs', 'guides', '阅读.md'), '# 中文操作指南\n\n独特正文词\n\n## 章节一\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst test = 1;\n```\n\n## 章节一\n');
  await writeFile(path.join(root, 'docs', 'architecture', 'model.md'), '# 架构说明\n\n[指南](../guides/阅读.md#章节一)');
  await writeFile(path.join(root, 'docs', 'archive', 'old.md'), '# 历史说明\n');
  await writeFile(path.join(root, 'docs', 'reference', 'exports', '交付.docx'), 'binary-fixture');
  await writeFile(path.join(root, 'docs', '.secret.md'), 'secret');
  await writeFile(path.join(root, 'docs', 'private.env'), 'key');
  await writeFile(path.join(root, 'README.md'), '# 项目入口\n');
  return root;
}
async function serving(t) {
  const root = await fixture(t); const server = createDocsServer({ root });
  const url = await listenOnFetchableLoopback(server);
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { root, server, url };
}

test('catalog classifies current, historical and downloadable material without hidden/private files', async t => {
  const root = await fixture(t); const catalog = await buildDocsCatalog(root);
  assert.equal(catalog.entries.length, 5);
  assert.equal(catalog.files.get('guides/阅读.md').title, '中文操作指南');
  assert.equal(catalog.files.get('archive/old.md').archived, true);
  assert.equal(catalog.files.get('reference/exports/交付.docx').readable, false);
  assert.ok(!catalog.files.has('.secret.md')); assert.ok(!catalog.files.has('private.env'));
});

test('renderer handles tables, code, duplicate anchors and internal links', async t => {
  const catalog = await buildDocsCatalog(await fixture(t));
  const guide = renderDocument(catalog.files.get('guides/阅读.md'), catalog);
  assert.match(guide.html, /<table>/u); assert.match(guide.html, /language-js/u);
  assert.deepEqual(guide.headings.map(item => item.id), ['section-中文操作指南', 'section-章节一', 'section-章节一-1']);
  const model = renderDocument(catalog.files.get('architecture/model.md'), catalog);
  assert.match(model.html, /#doc=guides%2F/u); assert.match(model.html, /&amp;section=/u);
});

test('untrusted HTML, unsafe URLs, remote images and outside-root links cannot execute or expose files', async t => {
  const catalog = await buildDocsCatalog(await fixture(t)); const file = catalog.files.get('architecture/model.md');
  file.text = '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))\n\n[private](../../private.json)\n\n![remote](https://example.com/track.png)\n\n[official](https://example.com/docs)';
  const { html } = renderDocument(file, catalog);
  assert.ok(!/<script|<img[^>]+onerror=|href="javascript:/u.test(html));
  assert.match(html, /data-unavailable/u); assert.ok(!html.includes('src="https://'));
  assert.match(html, /noopener noreferrer/u);
});

test('server serves local UI, full-text search, reader content and binary downloads', async t => {
  const { url } = await serving(t);
  const page = await fetch(url); assert.equal(page.status, 200); assert.match(await page.text(), /文档分类/u);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/u);
  const results = await (await fetch(`${url}/api/catalog?q=${encodeURIComponent('独特正文词')}`)).json(); assert.equal(results.entries.length, 1);
  const doc = await (await fetch(`${url}/api/doc?id=${encodeURIComponent('guides/阅读.md')}`)).json(); assert.match(doc.html, /<table>/u); assert.equal(doc.headings.length, 3);
  const binary = await fetch(`${url}/api/file?id=${encodeURIComponent('reference/exports/交付.docx')}`); assert.equal(await binary.text(), 'binary-fixture'); assert.match(binary.headers.get('content-disposition'), /attachment/u);
});

test('host/origin/write/traversal restrictions keep the service read-only and local', async t => {
  const { url } = await serving(t);
  const rebinding = await new Promise((resolve, reject) => { const request = http.get(url, { headers: { host: 'attacker.example' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }); request.on('error', reject); });
  assert.equal(rebinding, 403);
  assert.equal((await fetch(url, { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  for (const id of ['../README.md', '../../private.json', '.secret.md', 'private.env', 'C:/Windows/win.ini']) assert.equal((await fetch(`${url}/api/file?id=${encodeURIComponent(id)}`)).status, 404);
  assert.equal((await fetch(`${url}/api/doc?id=reference%2Fexports%2F%E4%BA%A4%E4%BB%98.docx`)).status, 415);
});

test('symbolic directory escape is excluded from the catalog', async t => {
  const root = await fixture(t); const outside = path.join(root, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'secret.md'), '# secret');
  await symlink(outside, path.join(root, 'docs', 'linked'), 'junction');
  const catalog = await buildDocsCatalog(root); assert.ok(!catalog.files.has('linked/secret.md'));
});

test('catalog refresh reflects changed documents without generating document copies', async t => {
  const { root, url } = await serving(t);
  await fetch(`${url}/api/catalog`);
  await writeFile(path.join(root, 'docs', 'guides', 'new.md'), '# 新增文档\n\n刷新验证');
  await new Promise(resolve => setTimeout(resolve, 1050));
  const data = await (await fetch(`${url}/api/catalog?q=${encodeURIComponent('刷新验证')}`)).json();
  assert.equal(data.entries.length, 1); assert.equal(data.entries[0].id, 'guides/new.md');
});
