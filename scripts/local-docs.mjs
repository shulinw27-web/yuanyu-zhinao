import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import MarkdownIt from 'markdown-it';

export const categories = [
  ['overview', '项目概览', '先了解产品定位、能力范围与当前进展'],
  ['architecture', '技术架构', '系统设计、语义模型与安全边界'],
  ['guides', '操作指南', '按步骤使用智脑、运营端和接入工具'],
  ['modules', '模块说明', '各模块的职责、接口和数据契约'],
  ['development', '开发与验证', '开发计划、联调、测试与验收记录'],
  ['operations', '部署与运维', '部署准备、运行维护和故障处理'],
  ['reference', '参考与交付', '术语、文档规范及Word等交付文件'],
  ['public', '公开资料', '产品网站使用的公开说明'],
  ['archive', '历史归档', '用于追溯，不代表当前实现'],
  ['index', '阅读入口', '项目和文档中心索引']
].map(([id, label, description]) => ({ id, label, description }));
const supported = new Set(['.md', '.txt', '.json', '.csv', '.pdf', '.docx', '.pptx', '.xlsx', '.png', '.jpg', '.jpeg', '.gif', '.webp']);
const images = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const readable = new Set(['.md', '.txt', '.json', '.csv']);
const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(here, '..');
const assets = path.join(defaultRoot, 'tools', 'docs-reader');
const inside = (root, target) => { const relative = path.relative(root, target); return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative); };
const escape = text => String(text).replace(/[&<>"']/gu, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]);

export async function buildDocsCatalog(root = defaultRoot) {
  root = await realpath(root);
  const docs = await realpath(path.join(root, 'docs'));
  const files = new Map(); const entries = [];
  async function add(absolute, id, category) {
    const extension = path.extname(id).toLowerCase();
    if (!supported.has(extension)) return;
    if (files.size >= 2000) throw new Error('文档目录超过2000文件预算');
    const info = await stat(absolute);
    const text = readable.has(extension) && info.size <= 2 * 1024 * 1024 ? await readFile(absolute, 'utf8') : '';
    const title = (extension === '.md' ? text.match(/^#\s+(.+)$/mu)?.[1] : null) || path.basename(id, extension);
    const summary = text.split(/\r?\n/u).find(line => line.trim() && !/^(?:#|\||```|---)/u.test(line))?.replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1').slice(0, 160) || '可下载的项目交付文件';
    const entry = { id, title, summary, category, extension, size: info.size, updatedAt: info.mtime.toISOString(), readable: readable.has(extension) && Boolean(text), archived: category === 'archive' };
    files.set(id, { ...entry, absolute, text });
    if (!images.has(extension)) entries.push(entry);
  }
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.name.startsWith('.') || item.isSymbolicLink()) continue;
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) await walk(absolute);
      else if (item.isFile()) {
        const id = path.relative(docs, absolute).split(path.sep).join('/');
        await add(absolute, id, id.includes('/') ? id.split('/')[0] : 'index');
      }
    }
  }
  await walk(docs);
  try {
    const readme = path.join(root, 'README.md');
    if ((await realpath(readme)) === readme) await add(readme, '_project/README.md', 'index');
  } catch { /* README is optional. */ }
  entries.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  return { docs, root: path.resolve(root), entries, files };
}

export function renderDocument(file, catalog) {
  const parser = new MarkdownIt({ html: false, linkify: false });
  const headings = []; const counts = new Map();
  function target(href) {
    if (/^https?:\/\//iu.test(href)) return { href, external: true };
    if (href.startsWith('#')) return { href: `#section-${encodeURIComponent(href.slice(1))}` };
    if (/^[a-z][a-z\d+.-]*:|^\/\//iu.test(href)) return null;
    try {
      const [source, anchor] = href.split('#');
      const absolute = path.resolve(path.dirname(file.absolute), decodeURIComponent(source.split('?')[0]));
      const id = absolute === path.join(catalog.root, 'README.md') ? '_project/README.md' : inside(catalog.docs, absolute) ? path.relative(catalog.docs, absolute).split(path.sep).join('/') : null;
      const linked = catalog.files.get(id);
      if (!linked) return null;
      return { href: linked.extension === '.md' ? `#doc=${encodeURIComponent(id)}${anchor ? `&section=${encodeURIComponent(decodeURIComponent(anchor))}` : ''}` : `/api/file?id=${encodeURIComponent(id)}`, local: true };
    } catch { return null; }
  }
  parser.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    const token = tokens[index]; const link = target(token.attrGet('href') || '');
    token.attrSet('href', link?.href || '#');
    if (!link) { token.attrSet('title', '该链接指向文档目录之外，阅读页不开放源码或私有文件'); token.attrSet('data-unavailable', 'true'); }
    if (link?.external) { token.attrSet('target', '_blank'); token.attrSet('rel', 'noopener noreferrer'); }
    return renderer.renderToken(tokens, index, options);
  };
  parser.renderer.rules.image = (tokens, index) => {
    const token = tokens[index]; const image = target(token.attrGet('src') || '');
    if (!image?.local || !image.href.startsWith('/api/file')) return `<span class="image-note">[图片：${escape(token.content)}；外部图片不自动加载]</span>`;
    return `<img src="${escape(image.href)}" alt="${escape(token.content)}" loading="lazy">`;
  };
  parser.renderer.rules.heading_open = (tokens, index) => {
    const title = tokens[index + 1]?.content || '章节';
    const slug = title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/gu, '-');
    const occurrence = counts.get(slug) || 0; counts.set(slug, occurrence + 1);
    const id = `section-${slug}${occurrence ? `-${occurrence}` : ''}`;
    headings.push({ id, title, level: Number(tokens[index].tag.slice(1)) });
    return `<${tokens[index].tag} id="${escape(id)}">`;
  };
  const html = file.extension === '.md' ? parser.render(file.text) : `<pre><code>${escape(file.text)}</code></pre>`;
  return { html, headings };
}

export function createDocsServer({ root = defaultRoot } = {}) {
  let cached; let cachedAt = 0; let pending;
  async function catalog() {
    if (cached && Date.now() - cachedAt < 1000) return cached;
    pending ||= buildDocsCatalog(root).then(value => { cached = value; cachedAt = Date.now(); return value; }).finally(() => { pending = null; });
    return pending;
  }
  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const send = (status, type, body) => { res.writeHead(status, { 'Content-Type': type }); res.end(req.method === 'HEAD' ? undefined : body); };
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'");
    if (!allowed.has(req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site' || req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) return send(403, 'text/plain', '仅允许本机同源阅读');
    if (!['GET', 'HEAD'].includes(req.method)) return send(405, 'text/plain', '只读文档服务');
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const asset = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] }[url.pathname];
      if (asset) return send(200, asset[1], await readFile(path.join(assets, asset[0])));
      const current = await catalog();
      if (url.pathname === '/api/catalog') {
        const q = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 100);
        const terms = q.split(/\s+/u).filter(Boolean);
        const entries = current.entries.filter(entry => terms.every(term => `${entry.title}\n${entry.id}\n${current.files.get(entry.id).text}`.toLowerCase().includes(term)));
        return send(200, 'application/json; charset=utf-8', JSON.stringify({ categories, entries, total: current.entries.length }));
      }
      const file = current.files.get(url.searchParams.get('id'));
      if (!file || !['/api/doc', '/api/file'].includes(url.pathname)) return send(404, 'text/plain', '文档不存在');
      const resolved = await realpath(file.absolute);
      if (resolved !== file.absolute || !inside(current.docs, resolved) && resolved !== path.join(current.root, 'README.md')) return send(403, 'text/plain', '不允许文档目录之外的文件');
      if (url.pathname === '/api/doc') {
        if (!file.readable) return send(415, 'text/plain', '该文件请下载后阅读');
        return send(200, 'application/json; charset=utf-8', JSON.stringify({ ...current.entries.find(entry => entry.id === file.id), ...renderDocument(file, current) }));
      }
      if ((await stat(resolved)).size > 20 * 1024 * 1024) return send(413, 'text/plain', '文件超过20MB下载预算');
      res.setHeader('Content-Disposition', `${images.has(file.extension) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(file.id))}`);
      const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[file.extension] || 'application/octet-stream';
      return send(200, type, await readFile(resolved));
    } catch { return send(500, 'text/plain', '文档读取失败，请检查文件后刷新'); }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv.find(value => value.startsWith('--port='))?.split('=')[1] || 15200);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口须在1024–65535之间');
  const server = createDocsServer();
  server.on('error', error => { console.error(`文档服务启动失败：${error.code || 'UNKNOWN'}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`元域本地文档中心：http://127.0.0.1:${port}/（只读，不公开到互联网）`));
}
