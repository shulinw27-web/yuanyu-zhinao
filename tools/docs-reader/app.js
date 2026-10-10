const $ = id => document.getElementById(id);
let category = 'all'; let catalog = []; let groups = []; let requestId = 0; let readingId = 0;
const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
const categoryName = id => groups.find(group => group.id === id)?.label || '其他文档';
const docHref = id => `#doc=${encodeURIComponent(id)}`;
const date = value => new Date(value).toLocaleDateString('zh-CN');
async function refresh() {
  const generation = ++requestId;
  $('notice').textContent = '正在读取文档…';
  try {
    const response = await fetch(`/api/catalog?q=${encodeURIComponent($('search').value)}`);
    if (!response.ok) throw new Error('文档目录读取失败，请稍后刷新。');
    const data = await response.json(); if (generation !== requestId) return;
    catalog = data.entries; groups = data.categories; $('notice').textContent = '';
    renderCategories(); renderList();
  } catch (error) { if (generation === requestId) $('notice').textContent = error.message; }
}
function renderCategories() {
  $('categories').replaceChildren();
  for (const group of [{ id: 'all', label: '全部文档' }, ...groups]) {
    const count = group.id === 'all' ? catalog.length : catalog.filter(doc => doc.category === group.id).length;
    const button = node('button', undefined, category === group.id ? 'active' : ''); button.type = 'button';
    button.append(node('span', group.label), node('small', count)); button.setAttribute('aria-pressed', String(category === group.id));
    button.addEventListener('click', () => { category = group.id; if (category === 'archive') $('archives').checked = true; location.hash = ''; renderCategories(); renderList(); });
    $('categories').append(button);
  }
}
function renderList() {
  const group = groups.find(item => item.id === category);
  $('view-title').textContent = group?.label || '把项目看清楚，从这里开始。';
  $('view-description').textContent = group?.description || '按目的找文档，而不是在文件夹里找文件。';
  $('list-title').textContent = $('search').value ? '搜索结果' : group?.label || '全部文档';
  $('featured').replaceChildren();
  if (category === 'all' && !$('search').value) {
    for (const [id, title, description] of [['overview/PROJECT_STATUS.md', '项目现在做到哪里？', '进展、已实现范围与待验收事项'], ['development/ONTOLOGY_FUSION_CURRENT_STATUS.md', '当前开发与剩余清单', '本体融合的最新状态与边界'], ['guides/ONTOLOGY_GRAPH_WORKSPACE_GUIDE.md', '从操作指南开始', '图谱建模、影响检查与审核步骤']]) {
      if (!catalog.some(doc => doc.id === id)) continue;
      const link = node('a', undefined, 'feature'); link.href = docHref(id);
      link.append(node('small', '推荐阅读 →'), node('strong', title), node('p', description)); $('featured').append(link);
    }
  }
  const entries = catalog.filter(doc => (category === 'all' || doc.category === category) && ($('archives').checked || !doc.archived));
  if ($('sort').value === 'updated') entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  $('count').textContent = `${entries.length} 份 · Markdown可直接阅读`;
  $('documents').replaceChildren();
  for (const doc of entries) {
    const link = node('a', undefined, 'doc-card'); link.href = doc.readable ? docHref(doc.id) : `/api/file?id=${encodeURIComponent(doc.id)}`;
    const footer = node('footer'); footer.append(node('span', `文件修改 ${date(doc.updatedAt)}`), node('span', doc.readable ? '阅读 →' : '下载 ↓'));
    link.append(node('span', `${categoryName(doc.category)} · ${doc.extension.slice(1).toUpperCase()}`, 'tag'), node('h3', doc.title), node('p', doc.summary), footer);
    $('documents').append(link);
  }
  if (!entries.length) $('documents').append(node('p', '没有匹配的文档。换个关键词或开启历史归档试试。', 'empty'));
}
function sectionScroll(id) { if (id) document.getElementById(id)?.scrollIntoView({ block: 'start' }); }
async function route() {
  if (location.hash.startsWith('#section-')) { sectionScroll(decodeURIComponent(location.hash.slice(1))); return; }
  const params = new URLSearchParams(location.hash.slice(1)); const id = params.get('doc');
  const generation = ++readingId;
  if (!id) { $('reader').hidden = true; $('library').hidden = false; document.title = '元域 · 项目文档中心'; return; }
  $('library').hidden = true; $('reader').hidden = false; $('article').replaceChildren(node('p', '正在读取文档…')); $('toc').replaceChildren();
  try {
    const response = await fetch(`/api/doc?id=${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error('文档无法读取，可能已移动或需要下载原文件。');
    const doc = await response.json(); if (generation !== readingId) return;
    // HTML is produced only by our server renderer with raw HTML disabled.
    $('article').innerHTML = doc.html;
    $('doc-meta').textContent = `${doc.id} · 文件修改 ${date(doc.updatedAt)}${doc.archived ? ' · 历史归档' : ''}`;
    $('download').href = `/api/file?id=${encodeURIComponent(id)}`;
    document.title = `${doc.title} · 元域文档中心`;
    for (const heading of doc.headings.filter(item => item.level <= 3)) {
      const link = node('a', heading.title, heading.level === 3 ? 'sub' : ''); link.href = `${docHref(id)}&section=${encodeURIComponent(heading.id.slice(8))}`;
      link.addEventListener('click', event => { event.preventDefault(); history.replaceState(null, '', link.href); sectionScroll(heading.id); }); $('toc').append(link);
    }
    $('article').querySelectorAll('a[href^="#section-"]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); sectionScroll(decodeURIComponent(link.hash.slice(1))); }));
    $('article').querySelectorAll('[data-unavailable]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); $('notice').textContent = '这个链接指向源码或文档目录之外，本地阅读页不开放该文件。'; }));
    if (params.get('section')) sectionScroll(`section-${params.get('section')}`); else window.scrollTo({ top: 0 });
  } catch (error) { if (generation === readingId) { $('article').replaceChildren(node('p', error.message)); $('download').removeAttribute('href'); } }
}
let timer;
$('search').addEventListener('input', () => { location.hash = ''; clearTimeout(timer); timer = setTimeout(refresh, 180); });
$('archives').addEventListener('change', renderList); $('sort').addEventListener('change', renderList);
$('refresh').addEventListener('click', async () => { await refresh(); await route(); });
$('back').addEventListener('click', () => { location.hash = ''; });
window.addEventListener('hashchange', route);
window.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('search').focus(); } });
await refresh(); await route();
