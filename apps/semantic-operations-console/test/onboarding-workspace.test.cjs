const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { parse, compileScript } = require('@vue/compiler-sfc');
const vue = require('vue');

const filename = resolve(__dirname, '../src/components/SemanticOnboardingWorkspace.vue');
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
const compiled = compileScript(descriptor, { id: 'onboarding-workspace-test', inlineTemplate: true }).content.replace(/import SemanticOnboardingCalculation from '[^']+';/u, 'const SemanticOnboardingCalculation = { render: () => null };');
const executable = compiled.replace(/import SemanticOnboardingAlignment from '[^']+';/u, 'const SemanticOnboardingAlignment = { render: () => null };').replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"];?/gu, (_match, names) => `const { ${names.replace(/\s+as\s+/gu, ': ')} } = Vue;`).replace('export default', 'return');
// Render the real compiled component. Model callbacks are driven directly so no
// browser, port, external service, or DOM implementation is required here.
const Component = new Function('Vue', executable)({ ...vue, vModelText: {}, vModelSelect: {} });
const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null });
const renderer = vue.createRenderer({
  createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (item, text) => { item.text = text; }, setElementText: (item, text) => { item.children = []; item.text = text; },
  parentNode: item => item.parent, nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] || null,
  patchProp: (item, key, _old, value) => { item.props[key] = value; },
  insert: (item, parent, anchor = null) => {
    if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1);
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(index < 0 ? parent.children.length : index, 0, item); item.parent = parent;
  },
  remove: item => { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = null; }
});
const flatten = item => [item, ...item.children.flatMap(flatten)];
const content = item => item.type === '#comment' ? '' : `${item.text}${item.children.map(content).join(' ')}`;
const flush = async () => { await vue.nextTick(); await new Promise(resolve => setImmediate(resolve)); await vue.nextTick(); };
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const scenario = { id: 'fulfillment', label: '订单履约', description: '准备履约资料', systems: ['OMS', 'WMS'], questions: ['哪些订单可能延迟？'] };
const kinds = ['requirements', 'api', 'dictionary', 'samples', 'rules'];
const project = (id = 'p1', revision = 1, override = {}) => ({
  id, name: `项目 ${id}`, scenarioId: 'fulfillment', mode: 'synthetic', revision, materials: [],
  readiness: { status: 'collecting', completed: 0, total: 5, missing: kinds.map(kind => ({ kind, label: kind, reason: `缺少 ${kind}` })), issues: [], nextAction: '请补充业务需求' },
  milestones: [{ id: 'materials', label: '收集材料', status: 'pending', detail: '0/5' }], boundary: '仅进行模拟材料准备', ...override
});
const overview = (projects = []) => ({ mode: 'synthetic', scenarios: [scenario, { ...scenario, id: 'quality_incident', label: '批次异常' }], projects, limits: { materialBytes: 65536 } });
const readyProject = (id = 'p1', revision = 6, verified = false) => project(id, revision, {
  readiness: { status: 'ready_for_review', completed: 5, total: 5, missing: [], issues: [], nextAction: '可进行人工审阅与模拟测试' },
  connection: verified ? { status: 'verified', sourceKind: 'local_mock_http', faultMode: 'none', checkedAt: '2026-09-17T10:00:00Z', materialRevision: 5, systems: ['OMS'], recordCount: 12, pageCount: 3, requests: 3, issue: null } : null
});
const dataPreview = (id = 'p1', revision = 7, objectType = 'Order') => ({
  projectId: id, revision, sourceKind: 'local_mock_http', objectType, system: 'OMS',
  objects: [{ objectType: 'Order', system: 'OMS', totalRows: 12 }, { objectType: 'Shipment', system: 'WMS', totalRows: 12 }],
  fields: [{ name: 'id', type: 'string', required: true }, { name: 'quantity', type: 'integer' }],
  rows: Array.from({ length: 12 }, (_, index) => ({ id: `${id}-${objectType}-${index + 1}`, quantity: index + 1 })),
  totalRows: 12, truncated: true
});
async function mount(t, overrides = {}, canWrite = true) {
  const calls = [];
  const client = {
    onboarding: async () => overview([project()]), onboardingProject: async id => ({ project: project(id) }),
    createOnboardingProject: async payload => { calls.push(['create', payload]); return { project: project('new') }; },
    saveOnboardingMaterial: async (id, payload) => { calls.push(['save', id, payload]); return { project: project(id, payload.expectedRevision + 1) }; },
    testOnboardingConnection: async (id, payload) => { calls.push(['connection', id, payload]); return { project: readyProject(id, payload.expectedRevision + 1, true) }; },
    onboardingPreview: async (id, objectType) => { calls.push(['preview', id, objectType]); return dataPreview(id, 7, objectType); },
    ...overrides
  };
  const root = node('root');
  const app = renderer.createApp(Component, { client, canWrite });
  app.mount(root); t.after(() => app.unmount());
  await flush();
  const find = id => {
    const result = flatten(root).find(item => item.props['data-testid'] === id);
    assert.ok(result, `missing rendered element: ${id}`); return result;
  };
  return {
    app, root, calls, find, text: () => content(root),
    async input(id, value) { find(id).props['onUpdate:modelValue'](value); await vue.nextTick(); },
    click: id => find(id).props.onClick(),
    submit: id => find(id).props.onSubmit({ preventDefault() {}, stopPropagation() {} })
  };
}

test('model handoff requires validated references and suppresses duplicate submissions', async t => {
  const ready = { ...readyProject(), alignment: { status: 'validated_scope', evidenceStatus: 'quotes_verified' } };
  const pending = deferred(); const calls = [];
  const ui = await mount(t, { onboarding: async () => overview([ready]), onboardingProject: async () => ({ project: ready }), handoffOnboarding: (id, body) => { calls.push({ id, body }); return pending.promise; } });
  const first = ui.click('handoff-model'); await ui.click('handoff-model'); await flush();
  assert.equal(ui.find('handoff-model').props.disabled, true); assert.deepEqual(calls, [{ id: 'p1', body: { expectedRevision: 6 } }]);
  pending.resolve({ project: { ...ready, revision: 7, handoff: { taskId: 'task1', current: true } }, taskId: 'task1', reused: false });
  await first; await flush(); assert.match(ui.text(), /已创建待审阅任务 task1/); assert.match(ui.text(), /尚未采纳或发布/);
});

test('uncited mappings and readonly actors cannot invoke a model handoff', async t => {
  for (const [canWrite, evidenceStatus] of [[true, 'needs_review'], [false, 'quotes_verified']]) {
    let calls = 0; const ready = { ...readyProject(), alignment: { status: 'validated_scope', evidenceStatus } };
    const ui = await mount(t, { onboarding: async () => overview([ready]), onboardingProject: async () => ({ project: ready }), handoffOnboarding: async () => { calls++; } }, canWrite);
    assert.equal(ui.find('handoff-model').props.disabled, true); await ui.click('handoff-model'); assert.equal(calls, 0);
  }
});

test('creates a blank scenario project once and never submits client tenant or preset material', async t => {
  const pending = deferred(); const calls = [];
  const ui = await mount(t, { onboarding: async () => overview(), createOnboardingProject: payload => { calls.push(payload); return pending.promise; } });
  assert.match(ui.text(), /还没有接入项目/);
  await ui.input('scenario-select', 'quality_incident'); await ui.input('project-name', '批次检查');
  const first = ui.submit('create-project-form'); const second = ui.submit('create-project-form');
  await vue.nextTick();
  assert.equal(ui.find('create-project').props.disabled, true);
  assert.deepEqual(calls, [{ scenarioId: 'quality_incident', name: '批次检查' }]);
  pending.resolve({ project: project('new', 1, { scenarioId: 'quality_incident' }) }); await Promise.all([first, second]); await flush();
  assert.match(content(ui.find('project-title')), /项目 new/);
  assert.equal(ui.find('material-text').props['onUpdate:modelValue'] instanceof Function, true);
  assert.equal(ui.find('save-material').props.disabled, true);
  assert.match(ui.text(), /不会自动调用模型/);
  assert.match(ui.text(), /空白模拟项目已建立/);
  assert.match(ui.text(), /缺少 requirements/);
});

test('read-only identity sees missing material but cannot create or save even when handlers are invoked', async t => {
  const ui = await mount(t, {}, false);
  assert.match(ui.text(), /当前为只读模式/);
  assert.match(ui.text(), /缺少 dictionary/);
  assert.equal(ui.find('project-name').props.disabled, true);
  assert.equal(ui.find('material-text').props.disabled, true);
  await ui.input('project-name', '不可提交'); await ui.input('material-name', 'rules.txt'); await ui.input('material-text', '只读提交');
  await ui.submit('create-project-form'); await ui.submit('material-form');
  assert.deepEqual(ui.calls, []);
});

test('conflict preserves the draft, refresh uses the new revision, invalid material remains a correction task', async t => {
  let revision = 1; const saves = []; const pending = deferred();
  const ui = await mount(t, {
    onboardingProject: async id => ({ project: project(id, revision) }),
    saveOnboardingMaterial: async (id, payload) => {
      saves.push({ id, ...payload });
      if (saves.length === 1) throw Object.assign(new Error('stale'), { status: 409 });
      return pending.promise;
    }
  });
  await ui.input('material-kind', 'dictionary'); await ui.input('material-name', 'dictionary.json'); await ui.input('material-text', '{broken');
  await ui.submit('material-form'); await flush();
  assert.match(content(ui.find('form-error')), /项目已被更新/);
  assert.equal(ui.find('save-material').props.disabled, true);
  revision = 7; await ui.click('refresh-project'); await flush();
  assert.equal(ui.find('save-material').props.disabled, false, 'draft remains available after refresh');
  assert.match(ui.text(), /项目版本已刷新，编辑内容已保留/);
  const saving = ui.submit('material-form'); await ui.submit('material-form'); await vue.nextTick();
  assert.equal(saves.length, 2, 'duplicate save is rejected while a write is in flight');
  assert.deepEqual(saves[1], { id: 'p1', expectedRevision: 7, kind: 'dictionary', name: 'dictionary.json', text: '{broken' });
  pending.resolve({ project: project('p1', 8, { materials: [{ kind: 'dictionary', name: 'dictionary.json', bytes: 7, issues: ['数据字典不是有效 JSON'] }] }) });
  await saving; await flush();
  assert.match(content(ui.find('notice')), /仍有需要补充或修正/);
  assert.match(ui.text(), /数据字典不是有效 JSON/);
  assert.match(content(ui.find('material-issues')), /数据字典：数据字典不是有效 JSON/, 'missing summary falls back to material issues labeled by kind');
  assert.equal(ui.find('save-material').props.disabled, false, 'invalid source text remains editable');
});

test('summary issues take precedence over material issues so one finding is rendered once', async t => {
  const item = project('p1', 2, { materials: [{ kind: 'dictionary', name: 'dictionary.json', bytes: 7, issues: ['数据字典不是有效 JSON'] }] });
  item.readiness.issues = ['数据字典：数据字典不是有效 JSON'];
  const ui = await mount(t, { onboardingProject: async () => ({ project: item }) });
  const issueList = ui.find('material-issues');
  assert.equal(flatten(issueList).filter(item => item.type === 'li').length, 1);
  assert.equal((content(issueList).match(/不是有效 JSON/gu) || []).length, 1);
  assert.match(content(issueList), /数据字典：数据字典不是有效 JSON/);
});

test('a slower project response cannot overwrite a newer selection', async t => {
  const a = deferred(); const b = deferred(); let first = true;
  const ui = await mount(t, {
    onboarding: async () => overview([project('p1'), project('p2')]),
    onboardingProject: id => { if (first) { first = false; return Promise.resolve({ project: project(id) }); } return id === 'p1' ? a.promise : b.promise; }
  });
  const old = ui.click('project-p1'); const current = ui.click('project-p2');
  b.resolve({ project: project('p2', 4) }); await current; await flush();
  assert.match(content(ui.find('project-title')), /项目 p2/);
  a.resolve({ project: project('p1', 99) }); await old; await flush();
  assert.match(content(ui.find('project-title')), /项目 p2/);
  assert.doesNotMatch(ui.text(), /修订 99/);
});

test('local files are staged without submitting and enforce type and server byte limit', async t => {
  const ui = await mount(t, { onboarding: async () => ({ ...overview([project()]), limits: { materialBytes: 80 } }) });
  const read = file => ui.find('material-file').props.onChange({ target: { files: [file], value: file.name } });
  await read({ name: 'unexpected.exe', size: 2, text: async () => 'bad' }); await flush();
  assert.match(content(ui.find('form-error')), /json 或 .txt/);
  await read({ name: 'large.txt', size: 81, text: async () => 'bad' }); await flush();
  assert.match(content(ui.find('form-error')), /超过材料大小限制/);
  await read({ name: 'rules.txt', size: 12, text: async () => '合成资料' }); await flush();
  assert.match(content(ui.find('notice')), /点击保存后才会提交/);
  assert.deepEqual(ui.calls, []);
  await ui.submit('material-form');
  assert.deepEqual(ui.calls[0], ['save', 'p1', { expectedRevision: 1, kind: 'requirements', name: 'rules.txt', text: '合成资料' }]);
});

test('late overview after unmount cannot start a project request', async t => {
  const pending = deferred(); let detailCalls = 0;
  const ui = await mount(t, { onboarding: () => pending.promise, onboardingProject: async () => { detailCalls += 1; return { project: project() }; } });
  ui.app.unmount(); pending.resolve(overview([project()])); await flush();
  assert.equal(detailCalls, 0);
  assert.equal(ui.root.children.length, 0);
});

test('failed overview shows a retry state and permission failure keeps writes disabled', async t => {
  let attempts = 0;
  const ui = await mount(t, { onboarding: async () => { attempts += 1; throw Object.assign(new Error('forbidden'), { status: 403 }); } });
  assert.match(ui.text(), /当前身份没有执行此操作的权限/);
  assert.equal(ui.find('create-project').props.disabled, true);
  await ui.click('refresh-overview'); await flush();
  assert.equal(attempts, 2);
});

test('mock connection starts only on explicit action after all five materials are ready', async t => {
  const ui = await mount(t);
  assert.equal(ui.find('test-connection').props.disabled, true);
  await ui.click('test-connection');
  assert.deepEqual(ui.calls, []);
  assert.match(ui.text(), /请先补齐并修正五类材料/);
});

test('manual mock test sends revision once and renders fields and at most ten synthetic rows', async t => {
  const pending = deferred(); const tests = [];
  const ui = await mount(t, {
    onboardingProject: async () => ({ project: readyProject() }),
    testOnboardingConnection: (id, payload) => { tests.push([id, payload]); return pending.promise; }
  });
  assert.deepEqual(ui.calls, [], 'opening a ready project performs no connection test or preview read');
  assert.equal(flatten(ui.find('connection-fault')).filter(item => item.type === 'option').length, 7);
  const first = ui.click('test-connection'); await ui.click('test-connection'); await vue.nextTick();
  assert.equal(ui.find('test-connection').props.disabled, true);
  assert.deepEqual(tests, [['p1', { expectedRevision: 6, faultMode: 'none' }]]);
  pending.resolve({ project: readyProject('p1', 7, true) }); await first; await flush();
  assert.deepEqual(ui.calls, [['preview', 'p1', undefined]]);
  assert.match(content(ui.find('connection-result')), /本地合成 HTTP 已验证/);
  const table = ui.find('preview-table');
  assert.equal(flatten(table).filter(item => item.type === 'tr').length, 11, 'one header plus ten rows even if API returns extra rows');
  assert.match(content(table), /integer/);
  assert.match(content(table), /p1-Order-10/);
  assert.doesNotMatch(content(table), /p1-Order-11/);
  assert.match(content(ui.find('preview-caption')), /项目修订 7/);
});

test('read-only users can inspect a verified synthetic preview but cannot launch a connection test', async t => {
  const ui = await mount(t, { onboardingProject: async () => ({ project: readyProject('p1', 7, true) }) }, false);
  assert.equal(ui.find('test-connection').props.disabled, true);
  await ui.click('test-connection'); assert.deepEqual(ui.calls, []);
  assert.equal(ui.find('load-preview').props.disabled, false);
  await ui.click('load-preview'); await flush();
  assert.deepEqual(ui.calls, [['preview', 'p1', undefined]]);
  assert.ok(ui.find('preview-table'));
});

test('fault selection is passive and a failed mock test shows the bounded error without loading preview', async t => {
  const tests = [];
  const failed = readyProject('p1', 7, true);
  failed.connection = { ...failed.connection, status: 'failed', faultMode: 'cross_tenant', issue: { code: 'MOCK_TENANT_MISMATCH', message: '拒绝租户不匹配的模拟记录。' } };
  const ui = await mount(t, {
    onboardingProject: async () => ({ project: readyProject() }),
    testOnboardingConnection: async (id, payload) => { tests.push([id, payload]); return { project: failed }; }
  });
  await ui.input('connection-fault', 'cross_tenant'); assert.deepEqual(tests, []);
  await ui.click('test-connection'); await flush();
  assert.deepEqual(tests, [['p1', { expectedRevision: 6, faultMode: 'cross_tenant' }]]);
  assert.match(content(ui.find('connection-issue')), /MOCK_TENANT_MISMATCH/);
  assert.match(content(ui.find('connection-result')), /模拟连接未通过/);
  assert.deepEqual(ui.calls, []);
});

test('an older object preview cannot overwrite a newer object choice', async t => {
  const shipment = deferred(); let request = 0;
  const ui = await mount(t, {
    onboardingProject: async () => ({ project: readyProject('p1', 7, true) }),
    onboardingPreview: async (id, objectType) => { request += 1; return objectType === 'Shipment' ? shipment.promise : dataPreview(id, 7, 'Order'); }
  });
  await ui.click('load-preview'); await flush();
  await ui.input('preview-object', 'Shipment'); const old = ui.find('preview-object').props.onChange();
  await ui.input('preview-object', 'Order'); await ui.find('preview-object').props.onChange(); await flush();
  assert.match(content(ui.find('preview-caption')), /Order/);
  shipment.resolve(dataPreview('p1', 7, 'Shipment')); await old; await flush();
  assert.match(content(ui.find('preview-caption')), /Order/);
  assert.doesNotMatch(content(ui.find('preview-table')), /p1-Shipment/);
  assert.equal(request, 3);
});

test('switching project discards pending preview results from the previous project', async t => {
  const pending = deferred();
  const ui = await mount(t, {
    onboarding: async () => overview([readyProject('p1', 7, true), readyProject('p2', 7, true)]),
    onboardingProject: async id => ({ project: readyProject(id, 7, true) }),
    onboardingPreview: () => pending.promise
  });
  const old = ui.click('load-preview'); await ui.click('project-p2'); await flush();
  pending.resolve(dataPreview('p1', 7)); await old; await flush();
  assert.match(content(ui.find('project-title')), /项目 p2/);
  assert.equal(flatten(ui.root).some(item => item.props['data-testid'] === 'preview-table'), false);
  assert.doesNotMatch(ui.text(), /p1-Order/);
});

test('material changes clear verified preview and invalidate a late preview response', async t => {
  const pending = deferred(); let reads = 0;
  const ui = await mount(t, {
    onboardingProject: async () => ({ project: readyProject('p1', 7, true) }),
    onboardingPreview: async () => { reads += 1; return reads === 1 ? dataPreview('p1', 7) : pending.promise; }
  });
  await ui.click('load-preview'); await flush();
  assert.ok(ui.find('preview-table'));
  const old = ui.click('load-preview');
  await ui.input('material-name', 'rules-v2.txt'); await ui.input('material-text', '更新合成材料');
  await ui.submit('material-form'); await flush();
  pending.resolve(dataPreview('p1', 7)); await old; await flush();
  assert.equal(flatten(ui.root).some(item => item.props['data-testid'] === 'preview-table'), false);
  assert.match(ui.text(), /此前模拟连接与预览已失效/);
  assert.equal(ui.find('test-connection').props.disabled, true, 'new material readiness is honored');
});

test('first material save does not claim invalidation and starting a connection test clears the material notice', async t => {
  const pending = deferred();
  const ui = await mount(t, {
    saveOnboardingMaterial: async () => ({ project: readyProject('p1', 6) }),
    testOnboardingConnection: () => pending.promise
  });
  await ui.input('material-name', 'rules.txt'); await ui.input('material-text', '首次登记的合成材料');
  await ui.submit('material-form'); await flush();
  assert.match(content(ui.find('notice')), /材料已登记，材料准备进度已更新/);
  assert.doesNotMatch(content(ui.find('notice')), /此前|已失效|重新测试/);
  const testing = ui.click('test-connection'); await vue.nextTick();
  assert.equal(flatten(ui.root).some(item => item.props['data-testid'] === 'notice'), false, 'old material notice clears when testing starts');
  pending.resolve({ project: readyProject('p1', 7, true) }); await testing; await flush();
  assert.match(content(ui.find('connection-result')), /本地合成 HTTP 已验证/);
  assert.equal(flatten(ui.root).some(item => item.props['data-testid'] === 'notice'), false, 'successful connection does not retain stale material messaging');
});

test('preview revision errors require a refresh and never display mismatched rows', async t => {
  const ui = await mount(t, {
    onboardingProject: async () => ({ project: readyProject('p1', 7, true) }),
    onboardingPreview: async () => dataPreview('p1', 6)
  });
  await ui.click('load-preview'); await flush();
  assert.match(content(ui.find('preview-error')), /版本已失效/);
  assert.equal(ui.find('load-preview').props.disabled, true);
  assert.equal(flatten(ui.root).some(item => item.props['data-testid'] === 'preview-table'), false);
});

test('unmounted connection responses cannot start an automatic default preview', async t => {
  const pending = deferred();
  const ui = await mount(t, { onboardingProject: async () => ({ project: readyProject() }), testOnboardingConnection: () => pending.promise });
  const testing = ui.click('test-connection'); ui.app.unmount();
  pending.resolve({ project: readyProject('p1', 7, true) }); await testing; await flush();
  assert.deepEqual(ui.calls, []);
  assert.equal(ui.root.children.length, 0);
});
