import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workspaceSource = await readFile(new URL('../src/components/SemanticAgentWorkspace.vue', import.meta.url), 'utf8');
const shellStyles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const electronSource = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');

test('conversation content and composer use independent layout regions', () => {
  assert.match(workspaceSource, /ref="transcript" class="task-transcript"/);
  assert.match(workspaceSource, /class="task-input-dock"/);
  assert.match(workspaceSource, /\.task-conversation\{display:grid;grid-template-rows:minmax\(0,1fr\) auto;/);
  assert.match(workspaceSource, /\.task-transcript\{[^}]*overflow-y:auto;/);
});

test('composer stays docked instead of following long transcript content', () => {
  assert.match(workspaceSource, /\.task-composer\{position:static;/);
  assert.doesNotMatch(workspaceSource, /\.task-composer\{position:absolute;/);
  assert.match(workspaceSource, /\.task-input-dock\{position:relative;/);
});

test('ordinary conversation does not duplicate its response in the bottom status bar', () => {
  assert.match(workspaceSource, /\['conversation', 'needs_clarification', 'unsupported_operation', 'permission_denied'\]\.includes\(task\.intent\)\s*\? ''/);
});

test('desktop shell covers common compact, standard, and ultra-wide viewports', () => {
  assert.match(shellStyles, /@media \(max-width: 1180px\)/);
  assert.match(shellStyles, /@media \(max-width: 1366px\)/);
  assert.match(shellStyles, /@media \(min-width: 2200px\)/);
  assert.match(shellStyles, /@media \(max-height: 800px\) and \(min-width: 1181px\)/);
  assert.match(shellStyles, /min-height: 100dvh/);
});

test('unassigned candidate sources remain editable before server validation', () => {
  assert.match(workspaceSource, /来源系统<input[^>]*:disabled="!canEditProposal \|\| busy"/);
  // 阶段 4c 第二段：改写来源系统不再内联「拆串 + 大写」，而是走 setObjectSourceSystem——
  // 因为它必须**同时**把这条归属记进 sourceAssignments（并带上依据），
  // 否则服务端拿不到依据，会把它当「未经确认」处理。
  assert.match(workspaceSource, /@input="setObjectSourceSystem\(object, \$event\.target\.value\)"/);
  assert.match(workspaceSource, /function setObjectSourceSystem\(object, value\)/);
  assert.match(workspaceSource, /upsertSourceAssignment\(object\.id, system, sourceEvidence\.value\[object\.id\] \|\| ''\)/);
  // 候选归属：一键按材料确认，以及未确认候选在界面上的可见性。
  assert.match(workspaceSource, /function confirmSourceCandidate\(object\)/);
  assert.match(workspaceSource, /按材料确认归属/);
  assert.match(workspaceSource, /推断归属落在所选范围外/);
  // 归属依据不得为空：提交前先拦一次，把人名与缺哪一条对应起来。
  assert.match(workspaceSource, /const missingSourceEvidence = sourceAssignments\.filter\(item => !item\.evidence\)/);
});

test('desktop window can shrink to a 1024-wide effective viewport', () => {
  assert.match(electronSource, /minWidth: 960/);
  assert.match(electronSource, /minHeight: 640/);
});

test('modeling scope panel is explicit, gated, and reports coverage without hiding mismatches', () => {
  // 面板数据源：显式请求全量已登记系统（不是「没给范围就默认全量」）。
  assert.match(workspaceSource, /client\.semanticSources\(\{ scope: 'all_registered' \}\)/);
  assert.match(workspaceSource, /v-for="option in systemScopeOptions"/);
  assert.match(workspaceSource, /@click="toggleSystem\(option\.code\)"/);
  // 前端门禁：诉求看起来要建模且未选系统时不得提交，并给出可读原因。
  assert.match(workspaceSource, /const scopeRequiredReason = computed/);
  assert.match(workspaceSource, /&& !scopeRequiredReason\.value/);
  assert.match(workspaceSource, /v-if="scopeRequiredReason" class="scope-note blocked"/);
  // 范围始终随请求提交，客户端不替服务端决定哪些意图需要范围。
  assert.match(workspaceSource, /systemCodes: \[\.\.\.selectedSystems\.value\]/);
  // 范围拒绝按 code 识别并高亮面板：既包括任务创建阶段的范围校验，也包括提案阶段「对象全被范围排除」。
  assert.match(workspaceSource, /error\.body\?\.code/);
  assert.match(workspaceSource, /startsWith\('SEMANTIC_SYSTEM_'\)/);
  assert.match(workspaceSource, /SEMANTIC_PROPOSAL_SCOPE_EXCLUDED_ALL/);
  // 覆盖结果必须显式展示（ADR-013 之后）：未覆盖、被排除的对象、随对象排除的关系、部分超出、来源未标注、文本提到但未选。
  assert.match(workspaceSource, /selected\.systemScope\.uncovered/);
  assert.match(workspaceSource, /selected\.systemScope\.excludedObjects/);
  assert.match(workspaceSource, /selected\.systemScope\.excludedRelationships/);
  assert.match(workspaceSource, /selected\.systemScope\.partialScopeObjects/);
  assert.match(workspaceSource, /selected\.systemScope\.unassignedObjects/);
  assert.match(workspaceSource, /selected\.systemScope\.mentionedNotSelected/);
  // 旧的并集字段已被 ADR-013 拆开，不能在任何地方残留。
  assert.ok(!/outOfScopeObjects/.test(workspaceSource), '组件里仍残留已被 ADR-013 移除的 outOfScopeObjects');
  // 标识对应复核（阶段 4b）：推断必须逐条人工确认才并入，界面不能提供直接编辑这类边的入口。
  assert.match(workspaceSource, /IDENTITY LINK CONFIRMATION/);
  assert.match(workspaceSource, /identityLinkConfirmations/);
  assert.match(workspaceSource, /toggleIdentityLink\(link\.key\)/);
  // 确认集合整包提交（含空数组），否则界面无法表达「撤销全部确认」。
  assert.match(workspaceSource, /identityLinkConfirmations, identityConflictRulings, declarationRulings: declarationPayload, sourceAssignments \}/);
  // requires_mapping 必须就地收**结构化映射定义**——阶段 4d（ADR-019）起只给自由文本会被服务端拒绝，
  // 因为「这条边需要经外部映射、谁维护、哪一版」必须能随关系进草稿被下游机器读到。
  assert.match(workspaceSource, /v-model="identityLinkEvidence\[link\.key\]"/);
  assert.match(workspaceSource, /class="key-mapping-editor"/);
  assert.match(workspaceSource, /结构化映射定义/);
  assert.match(workspaceSource, /setLinkMapping\(link\.key, 'basis', \$event\.target\.value\)/);
  assert.match(workspaceSource, /setLinkMapping\(link\.key, 'owner'/);
  assert.match(workspaceSource, /setLinkMapping\(link\.key, 'version'/);
  // 形状未判定的对应必须**就地判形状**，且判定后按判定结果重新定级（不能「先确认再说」）。
  // 阶段 4e 起编辑器只在**可确认**的对应上出现：不可并入的没有可填的东西。
  assert.match(workspaceSource, /v-if="link\.eligible && link\.status === 'shape_unknown'" class="shape-judgement"/);
  assert.match(workspaceSource, /setLinkShape\(link\.key, option\.value\)/);
  assert.match(workspaceSource, /const effectiveLinkStatus/);
  assert.match(workspaceSource, /shapeUnknown/);
  // 保存前把「是哪一条缺什么」直接指出来，而不是丢回一个 400 让运营自己数。
  assert.match(workspaceSource, /标识对应还没填完/);
  // 并入的边不可直接改谓词/端点/删除：服务端每次重建，改了也会被丢弃。
  assert.match(workspaceSource, /Boolean\(relation\.derivedFrom\)/);
  assert.match(workspaceSource, /推断（人工确认并入）· 由标识对应复核控制/);
  // 三类拒绝要给出下一步动作，而不是把服务端原文丢给运营。
  assert.match(workspaceSource, /SEMANTIC_IDENTITY_CONFIRMATION_STALE/);
  // 阶段 4d：旧的「缺映射依据」码已被结构化映射定义的三类拒绝取代（判形状 / 补定义 / 刷新）。
  assert.match(workspaceSource, /SEMANTIC_IDENTITY_CONFIRMATION_MAPPING_INVALID/);
  assert.match(workspaceSource, /SEMANTIC_IDENTITY_CONFIRMATION_SHAPE_REQUIRED/);
  assert.ok(!/SEMANTIC_IDENTITY_CONFIRMATION_REQUIRES_MAPPING_EVIDENCE/.test(workspaceSource), '组件里仍残留已被 ADR-019 取代的旧错误码');
  // 阶段 4e（ADR-020）：资格是**第四种**要分开呈现的状态（「本次不可并入」），且它有自己的拒绝码。
  // 界面不能再从「依据是否来自系统声明」推断可确认性——那个判据实测会误报。
  assert.match(workspaceSource, /SEMANTIC_IDENTITY_CONFIRMATION_ENDPOINT_OUT_OF_SCOPE/);
  assert.match(workspaceSource, /const linkEligibilityNote/);
  assert.match(workspaceSource, /!link\.eligible/);
  assert.match(workspaceSource, /:disabled="!canEditProposal \|\| busy \|\| !link\.eligible"/);
  assert.ok(!/link\.notInProposal/.test(workspaceSource), '组件仍读旧字段 notInProposal：它用「依据来自声明」冒充「不可确认」');
  assert.ok(!/该来源系统本次未进入候选对象/.test(workspaceSource), '组件仍在陈述那句被实测推翻的话');
  assert.match(workspaceSource, /const eligibleLinkCount/);
  assert.match(workspaceSource, /有 \$\{ineligibleIssues\.length\} 条对应本次不可并入/);
  // 标识等价裁定（阶段 4c）：等价前提是确认的**前置**动作，界面必须同时给出裁定入口、被撤下结果
  // 与「还有多少条对应的前提没被看过」，否则运营会在没看过前提的情况下逐条确认。
  assert.match(workspaceSource, /IDENTITY EQUIVALENCE RULING/);
  assert.match(workspaceSource, /identityConflictRulings, declarationRulings: declarationPayload, sourceAssignments \}/);
  assert.match(workspaceSource, /setConflictRuling\(conflict\.concept, 'same_entity'\)/);
  assert.match(workspaceSource, /setConflictRuling\(conflict\.concept, 'distinct_entity'\)/);
  assert.match(workspaceSource, /withdrawnIdentityLinks/);
  assert.match(workspaceSource, /unresolvedAssumptionLinkCount/);
  assert.match(workspaceSource, /SEMANTIC_IDENTITY_RULING_GROUPS_INVALID/);
  // 来源归属确认（阶段 4c 第二段）：候选必须可见、可一键按材料确认，且「候选在范围外」不得被静默排除。
  assert.match(workspaceSource, /SOURCE ATTRIBUTION/);
  assert.match(workspaceSource, /const sourceAssignments = ref\(\[\]\)/);
  assert.match(workspaceSource, /sourceAssignments\.value = clone\(proposal\.sourceAssignments \|\| \[\]\)/);
  assert.match(workspaceSource, /object\.candidateSourceSystems\?\.length && !sourceAssignmentsOf\(object\.id\)/);
  assert.match(workspaceSource, /selected\.value\?\.proposal\?\.scopeExclusions\?\.candidateScopeObjects\?\.outOfScope/);
  assert.match(workspaceSource, /SEMANTIC_SOURCE_ASSIGNMENT_EVIDENCE_REQUIRED/);
  // 同名声明裁定（阶段 4c 第三段）：字段并集是**默认动作**，所以界面必须同时给出
  // ① 裁定入口（合并 / 区分）、② 逐处声明的字段出处、③ 「还有多少并集条目没人看过」。
  // 缺任何一项，运营就只会看到「这个对象有 7 个字段」，而没有任何一处声明说过这句话。
  assert.match(workspaceSource, /DECLARATION DIVERGENCE RULING/);
  assert.match(workspaceSource, /const declarationRulings = ref\(\[\]\)/);
  assert.match(workspaceSource, /declarationRulings\.value = clone\(proposal\.declarationRulings \|\| \[\]\)/);
  assert.match(workspaceSource, /setDeclarationRuling\(conflict, 'merge'\)/);
  assert.match(workspaceSource, /setDeclarationRuling\(conflict, 'distinct'\)/);
  // 分组靠名字表达：同名同组、不同名不同对象；空名会被前置校验拦住（不许隐含分组）。
  assert.match(workspaceSource, /buildDeclarationGroups\(conflict\)/);
  assert.match(workspaceSource, /declarationSplitProblem\(conflict\)/);
  // 并集披露与后果必须可见：复合条目本身、被排除了哪些声明、哪些对应因此消失。
  assert.match(workspaceSource, /mergedUnruledEntries/);
  assert.match(workspaceSource, /declarationReport\?\.droppedLinks/);
  assert.match(workspaceSource, /declarationReport\?\.droppedDeclarations/);
  assert.match(workspaceSource, /SEMANTIC_DECLARATION_RULING_NAME_TAKEN/);
  assert.match(workspaceSource, /clearAllSourceAssignments/);
});

// ── 阶段 4g：候选对象的**覆盖面**必须在界面上可见（ADR-022）─────────────────────
//
// 上一阶段（4f）把「命中依据」写进了服务端的审阅说明，但这个界面**不渲染 reviewNotes**：
// 披露只落在字符串里而界面不读，等于运营看不到——这是「披露了」与「可读到」之间的缺口。
// 本组钉住两块披露在界面上真的存在，并反向锁死两处**永远不会显示**的死界面。
test('候选对象覆盖面（目录空白 / 未覆盖提及）必须在提案审阅区可见', () => {
  const templateSource = workspaceSource.slice(workspaceSource.indexOf('<template>'), workspaceSource.indexOf('</template>'));
  assert.match(workspaceSource, /class="candidate-coverage"/);
  assert.match(workspaceSource, /selected\.proposal\.candidateCoverage\?\.fallbackApplied/);
  // 命中依据：必须点名「哪个目录条目被哪几个词命中」。只说「命中 2 类」回答不了「为什么没有发运单」。
  assert.match(workspaceSource, /candidateCoverage\.matched/);
  assert.match(workspaceSource, /entry\.matchedTerms\.join\('、'\)/);
  // 目录空白（确定性）：点名哪些已治理对象类在受控目录里没有词条。
  assert.match(workspaceSource, /目录里没有词条的对象类/);
  assert.match(workspaceSource, /candidateCoverage\.gaps/);
  // 未覆盖提及（启发式）：既要列出来，也要自我标注它**不是**抽取结果——否则会被当成结论。
  assert.match(workspaceSource, /candidateCoverage\.uncoveredMentions/);
  assert.match(workspaceSource, /不是对象抽取结果/);
  // 反向锁死：模板里不许出现 `selected.value`。`selected` 是 ref，模板中已解包，
  // `selected.value` 恒为 undefined——被它守卫的两段「失效披露」永远不会显示。
  // 这个缺陷此前被 `declarationReport?.droppedLinks` 那条断言掩盖：断言用了宽松的可选链匹配，
  // 组件里写着错的前缀也照样通过，属「看着覆盖了、实际没覆盖」。
  assert.ok(!/selected\.value/.test(templateSource), '模板中存在 selected.value（恒为 undefined，会静默隐藏整块披露）');
});

// ── 接入生命周期操作面（ADR-023 / ADR-024）：新增接入登记与已接通系统管理必须在界面上可执行 ──
//
// 此前系统接入视图只能「看」：状态是种子给的静态值，没有新增接入入口，也没有已接通
// 系统的管理动作——状态机在后端定义了却从未暴露。ADR-023 补齐生命周期操作面；
// ADR-024 进一步把「新增接入」改成租户提交接入物料、任意命名的登记动作，
// 必填项 schema 由服务端下发（前端不得复制第二份字段规则）。本组钉住操作面真实存在。
test('系统接入：新增接入登记表单、生命周期操作面板与停用筛选必须可见', async () => {
  const accessSource = await readFile(new URL('../src/components/SystemAccessWorkspace.vue', import.meta.url), 'utf8');
  // 注意：根 <template> 内部还有 <template v-if>，必须用 lastIndexOf 取到根闭合标签，
  // 否则切片会在第一个内层 </template> 处提前结束，后面的断言全部「假失败」。
  const templateSource = accessSource.slice(accessSource.indexOf('<template>'), accessSource.lastIndexOf('</template>'));
  // 新增接入入口：打开登记表单（不再只是切换筛选）。
  assert.match(templateSource, /data-testid="start-onboarding"/);
  assert.match(templateSource, /＋ 新增接入/);
  assert.match(accessSource, /function openRegistration\(\)/);
  assert.match(templateSource, /data-testid="register-system-form"/);
  // 登记表单必须按服务端下发的 schema 渲染（必填项单一事实源在后端），
  // 数据域与模拟场景选项同样来自服务端，前端不本地硬编码。
  assert.match(templateSource, /v-for="field in registrationFields"/);
  assert.match(accessSource, /const registrationFields = computed\(\(\) => registrationSchema\.value\?\.fields \|\| \[\]\)/);
  assert.match(templateSource, /v-for="option in registrationDataDomains"/);
  assert.match(templateSource, /v-for="scenario in registrationScenarios"/);
  assert.match(templateSource, /data-testid="register-submit"/);
  // 提交走服务端登记（201 进入「已登记」），前端不落任何本地状态旁路。
  assert.match(accessSource, /client\.registerSystemOnboarding\(/);
  // 生命周期操作面板：状态步骤 + 下一步动作 + 必填理由。
  assert.match(templateSource, /aria-label="接入流程与生命周期"/);
  assert.match(templateSource, /data-testid="lifecycle-steps"/);
  assert.match(templateSource, /data-testid="lifecycle-reason"/);
  assert.match(templateSource, /:data-testid="`lifecycle-\$\{action\.to\}`"/);
  // 接通门禁必须预判提示：没有 verified 探测时按钮禁用并说明原因，而不是点了才报错。
  assert.match(accessSource, /接通前必须先完成一次通过验证的连通性测试/);
  // 已接通系统管理：停用筛选 + 停用计数。
  assert.match(accessSource, /'suspended', label: '已停用'/);
  assert.match(templateSource, /overview\.summary\.suspended/);
  // 操作走服务端状态机，前端不得出现「本地改状态」的旁路。
  assert.match(accessSource, /client\.transitionSystemConnection\(/);
  assert.ok(!/lifecycleState\s*=\s*'connected'/.test(templateSource), '模板中不得硬编码生命周期状态');
  // 去预设（ADR-024）：界面上不得再出现「平台目录里尚未开始接入的系统」这类预设表述。
  assert.ok(!/平台目录里尚未开始接入/.test(accessSource), '不得残留预设待接入系统的表述');
  // 连接配置段（ADR-028）：心跳接口、授权方式、附加文档必须在登记表单中可见。
  assert.match(templateSource, /data-testid="register-field-heartbeat"/);
  assert.match(templateSource, /data-testid="register-heartbeat-endpoint"/);
  assert.match(templateSource, /data-testid="register-heartbeat-method"/);
  assert.match(templateSource, /data-testid="register-heartbeat-status"/);
  assert.match(templateSource, /data-testid="register-field-auth"/);
  assert.match(templateSource, /data-testid="register-auth-scheme"/);
  assert.match(templateSource, /v-for="option in registrationAuthSchemes"/);
  // service_principal 方式才出现的凭据引用与 scope（条件渲染）
  assert.match(templateSource, /v-if="registrationForm\.auth\.scheme === 'service_principal'"/);
  assert.match(templateSource, /data-testid="register-auth-credentialRef"/);
  assert.match(templateSource, /data-testid="register-auth-scope"/);
  // 附加文档（可选）：文件上传 + 文档清单
  assert.match(templateSource, /data-testid="register-field-attachmentDocuments"/);
  assert.match(templateSource, /data-testid="register-docs-file"/);
  // 授权方式选项由服务端 schema 下发（authSchemes），前端不本地硬编码
  assert.match(accessSource, /const registrationAuthSchemes = computed\(\(\) => registrationSchema\.value\?\.authSchemes \|\| \[\]\)/);
  // 接通门禁文案升级：心跳 verified（不再只说「探测 verified」）
  assert.match(accessSource, /心跳 verified/);
});

test('系统接入：物料补充、可审阅系统理解与监控控制必须走后端受控入口', async () => {
  const accessSource = await readFile(new URL('../src/components/SystemAccessWorkspace.vue', import.meta.url), 'utf8');
  const templateSource = accessSource.slice(accessSource.indexOf('<template>'), accessSource.lastIndexOf('</template>'));
  // 补充物料不允许只在前端改变候选：必须提交到同一受控解析管线。
  assert.match(templateSource, /data-testid="system-supplement-submit"/);
  assert.match(accessSource, /client\.supplementSystemMaterials\(code,/);
  assert.match(accessSource, /旧系统理解已失效/);
  // 理解读取与重算分离：读取 GET 缓存，用户显式触发 POST 重算。
  assert.match(templateSource, /data-testid="system-understanding"/);
  assert.match(templateSource, /data-testid="system-understanding-generate"/);
  assert.match(accessSource, /client\.systemUnderstanding\(code\)/);
  assert.match(accessSource, /client\.regenerateSystemUnderstanding\(code\)/);
  assert.match(templateSource, /事实不足会明确标为“材料未覆盖”/);
  // 监控面板只展示后端挂载状态；暂停/恢复也必须走服务端控制，不可本地改 paused。
  assert.match(templateSource, /data-testid="system-monitoring-panel"/);
  assert.match(templateSource, /data-testid="system-monitoring-toggle"/);
  assert.match(accessSource, /client\.systemMonitoring\(\)/);
  assert.match(accessSource, /client\.controlSystemMonitoring\(code, action\)/);
  assert.ok(!/selectedMonitoring\.value\.paused\s*=/.test(accessSource), '监控暂停状态不得由浏览器本地改写');
});

test('流程语义中心：流程图、变更校对和只读边界必须在独立模块可见', async () => {
  const appSource = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8');
  const workflowSource = await readFile(new URL('../src/components/WorkflowSemanticCenter.vue', import.meta.url), 'utf8');
  assert.match(appSource, /activeView === 'workflows'/);
  assert.match(appSource, />流程语义</);
  assert.match(appSource, /<WorkflowSemanticCenter/);
  assert.match(appSource, /:can-replay="buttonPermissionIds\.includes\('event\.outbox\.replay'\)"/);
  assert.match(workflowSource, />流程语义中心</);
  assert.match(workflowSource, /结构事实由连接器确定性解析/);
  assert.match(workflowSource, /不会自动提交、审批或撤回/);
  assert.match(workflowSource, /client\.syncWorkflows\(mode === 'configured' \? \{ mode \} : \{ scenario \}\)/);
  assert.match(workflowSource, />同步已配置连接器</);
  assert.match(workflowSource, /client\.reviewWorkflowVersion\(selectedCode\.value, latest\.value\.version, action\)/);
  assert.match(workflowSource, /当前 v\{\{ detail\.activeVersion \}\} 仍为智脑生效版本/);
  assert.match(workflowSource, /latest\.diff\?\.changes/);
  assert.match(workflowSource, /latest\.nodes/);
  assert.match(workflowSource, /latest\.fields/);
  assert.match(workflowSource, /detail\.instances/);
  assert.match(workflowSource, /instance\.timeline\?\.length/);
  assert.match(workflowSource, /查看 \{\{ instance\.timeline\.length \}\} 条流转记录/);
  assert.match(workflowSource, /runtime-timeline/);
  assert.match(workflowSource, /overview\?\.webhookInbox\?\.deadLetter/);
  assert.match(workflowSource, /client\.replayWorkflowEvent\(eventId\)/);
  assert.match(workflowSource, /签名通知只触发重新拉取/);
  assert.match(workflowSource, /@media\(max-width:900px\)/);
});
