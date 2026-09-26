<script setup>
import { computed, ref } from 'vue';
import DemoWorkbench from './DemoWorkbench.vue';
import { scenario } from '../demo-scenario.js';
defineProps({ page: { type: String, required: true }, loggedIn: Boolean });
const stepIndex = ref(0);
const step = computed(() => scenario.steps[stepIndex.value]);
const layerIndex = ref(2);
const layers = [
  { title: '业务入口', subtitle: '让不同角色在熟悉的工作环境里使用', tags: ['智脑桌面端', '元域智语端', '移动端适配'], body: '业务人员提出问题，运营人员建设模型。钉钉等入口和身份源按企业配置适配；门户账号不自动获得业务系统权限。', link: 'overview' },
  { title: 'Agent 协作', subtitle: '一端理解业务，一端建设业务模型', tags: ['上下文', '任务编排', '人工确认'], body: '业务智脑负责受控分析与任务；元域智语负责材料理解、候选校对及发布。分析建议、用户确认和执行回执分别记录。', link: 'walkthrough' },
  { title: '语义与知识', subtitle: '把对象、关系与资料放回业务上下文', tags: ['对象与关系', '模型版本', '来源引用'], body: '语义模型描述业务对象和关系，知识检索提供资料依据。Semantica与WeKnora用于相关建模/知识能力，已验证范围不等于任意业务全自动建模。', link: 'modeling' },
  { title: '系统连接', subtitle: '保留现有系统作为业务事实的来源', tags: ['ERP / MES', 'WMS / OMS', 'OA / QMS'], body: '通过接口、数据字典和授权样本建立连接。系统名称表示接入类别，不表示已为你的企业开通生产连接器。源系统授权与数据范围需逐项验收。', link: 'architecture' }
];
const resources = [
  { no: '01', title: '从一个示例开始', text: '看懂双 Agent 如何协作，以及每一步需要的材料。', href: '#/docs/walkthrough' },
  { no: '02', title: '建设业务语义', text: '准备字典，核对关系，验证后再发布。', href: '#/docs/modeling' },
  { no: '03', title: '理解接入边界', text: '身份、模型、系统与企业数据如何受控连接。', href: '#/docs/architecture' }
];
</script>

<template>
  <div class="website-v2">
    <template v-if="page === 'home'">
      <section class="v2-hero v2-wrap">
        <div class="hero-announcement"><span/> 企业 Agent 与语义智能平台 <span class="announcement-divider">/</span> YUANYU</div>
        <h1>连接业务数据，<br/>让 AI <em><span class="hero-phrase">理解业务、</span><span class="hero-phrase">协同工作。</span></em></h1>
        <p class="v2-lead">让散落在系统里的数据，成为可理解的业务关系。<br class="desktop-break"/>从语义建设到业务分析，两个 Agent，一套有依据的工作方式。</p>
        <div class="v2-actions"><a class="button" href="#/demo">查看场景演示 <span>↗</span></a><a class="button secondary" href="#/architecture">探索平台架构 <span>→</span></a></div>
        <div class="hero-proof"><span>业务智脑</span><i/><span>元域智语</span><i/><span>授权与证据贯穿</span></div>
        <DemoWorkbench compact/>
      </section>
      <section class="v2-system-strip"><div class="v2-wrap"><p>连接现有系统<br/><small>按授权与项目接入</small></p><span v-for="name in ['ERP', 'MES', 'WMS', 'OMS', 'OA', 'QMS']" :key="name">{{ name }}</span></div></section>
      <section class="v2-section v2-wrap value-section"><div><p class="v2-kicker">01 / BEYOND THE CHATBOX</p><h2>企业需要的，<br/>不只是一个对话框。</h2></div><div class="value-copy"><p>一个批次的异常，可能牵动生产、库存和订单。答案不在某一张表里，而在它们之间的关系里。</p><p>元域先把业务对象、口径和来源组织起来，再让 Agent 沿着可核对的路径理解问题。知道什么、还缺什么，都说清楚。</p><a class="v2-text-link" href="#/demo">看看一个跨系统问题如何展开 ↗</a></div></section>
      <section class="v2-products v2-section"><div class="v2-wrap"><div class="v2-section-head"><div><p class="v2-kicker">02 / ONE FOUNDATION. TWO AGENTS.</p><h2>让业务向前走。<br/>让模型跟得上。</h2></div><p>业务人员专注问题与工作。<br/>运营人员把业务知识变成可用的模型。</p></div>
        <div class="v2-product-pair"><article><div class="v2-product-number">01 <span>FOR BUSINESS TEAMS</span></div><h3>智脑工作台</h3><p>把问题、材料、上下文和任务连在一起。分析有依据，动作有确认，结果有回执。</p><div class="mini-conversation"><span>我</span><div>这次异常会影响哪些订单？</div><span>元</span><div>先核对批次与分配记录，再区分已知影响和待核实范围。<small>示例 · 不读取真实业务</small></div></div><a href="#/product">探索智脑工作台 <span>↗</span></a></article>
        <article class="semantic-product"><div class="v2-product-number">02 <span>FOR OPERATIONS TEAMS</span></div><h3>元域智语 Agent</h3><p>把业务材料整理成对象和关系。在可视化校对、回放与版本管理中，把模型建设扎实。</p><div class="mini-model"><div><small>DATA DICTIONARY</small><b>接口 · 字段 · 业务口径</b></div><span>↓ 候选提取与人工校对</span><div><b>原料批次 <i>→</i> 生产批次 <i>→</i> 订单</b><small>草稿 → 校验 → 回放 → 发布</small></div></div><a href="#/semantic">探索元域智语 <span>↗</span></a></article></div>
      </div></section>
      <section class="v2-section v2-wrap scenario-teaser"><div><p class="v2-kicker">03 / SEE THE WHOLE PATH</p><span class="v2-pill">合成供应链案例</span><h2>“这批原料出了问题，<br/>接下来会影响什么？”</h2><p>从一份数据字典，到一条有来源的影响路径。逐步查看两个 Agent 如何分工，以及哪些环节需要人来判断。</p><a class="button" href="#/demo">打开交互案例 ↗</a></div><ol><li v-for="(item, index) in scenario.steps" :key="item.title"><span>{{ String(index + 1).padStart(2, '0') }}</span><div><b>{{ item.title }}</b><small>{{ item.actor }}</small></div><span aria-hidden="true">↗</span></li></ol></section>
      <section class="v2-dark-section"><div class="v2-wrap v2-section-head"><div><p class="v2-kicker">04 / BUILT ON BUSINESS CONTEXT</p><h2>模型之下，<br/>是一套清楚的业务结构。</h2></div><div><p>语义定义对象与关系，知识保留来源，连接器尊重系统边界。权限与审计贯穿每一步。</p><a class="v2-text-link" href="#/architecture">展开技术架构 ↗</a></div></div><div class="v2-wrap foundation-row"><div v-for="(layer, index) in layers.slice().reverse()" :key="layer.title"><span>0{{ index + 1 }}</span><h3>{{ layer.title }}</h3><p>{{ layer.tags.join(' · ') }}</p></div></div></section>
      <section class="v2-section v2-wrap"><div class="v2-section-head"><div><p class="v2-kicker">05 / CONTROL IS PART OF THE PRODUCT</p><h2>让每一步，都经得起追问。</h2></div><a class="v2-text-link" href="#/docs/security">了解权限与数据安全 ↗</a></div><div class="v2-trust-grid"><article><span>↳</span><h3>答案从哪里来？</h3><p>引用保留来源，分析保留模型范围。证据不充分时，明确留下未知项。</p></article><article><span>⊙</span><h3>谁有权处理？</h3><p>访问与操作服从企业身份、数据权限和动作确认，不依赖模型自己决定。</p></article><article><span>✓</span><h3>真的执行了吗？</h3><p>分析、建议、确认与回执分别呈现，没有实际回执就不声称已经完成。</p></article></div></section>
      <section class="v2-resources"><div class="v2-wrap"><p class="v2-kicker">BUILD WITH YUANYU</p><h2>从理解，到动手。</h2><div class="resource-row"><a v-for="item in resources" :key="item.no" :href="item.href"><span>{{ item.no }}</span><h3>{{ item.title }} ↗</h3><p>{{ item.text }}</p></a></div></div></section>
    </template>

    <template v-else-if="page === 'product' || page === 'semantic'">
      <section class="v2-wrap v2-detail-hero"><a class="v2-breadcrumb" href="#/home">元域 / 产品</a><p class="v2-kicker">{{ page === 'product' ? 'BUSINESS AGENT' : 'SEMANTIC OPERATIONS' }}</p><h1>{{ page === 'product' ? '智脑工作台' : '元域智语 Agent' }}<br/><em>{{ page === 'product' ? '把问题，推进为有依据的工作。' : '把业务知识，建设成可用模型。' }}</em></h1><p class="v2-lead">{{ page === 'product' ? '面向业务人员的统一工作空间。衔接对话与材料，沿授权的模型理解业务，让分析、建议和执行各有位置。' : '面向建模与实施人员的独立工作台。从需求、接口和数据字典出发，在人的审阅下建立对象、关系与业务口径。' }}</p><div class="v2-actions"><a class="button" href="#/demo">查看双 Agent 案例 ↗</a><a class="button secondary" :href="page === 'product' ? '#/docs/overview' : '#/docs/modeling'">阅读使用文档 →</a></div></section>
      <section class="v2-wrap"><DemoWorkbench v-if="page === 'product'"/><div v-else class="semantic-flow-showcase"><p class="v2-kicker">从材料到已审阅模型 · 流程示意</p><div class="modeling-pipeline"><div v-for="(name, index) in ['输入业务材料', '生成对象候选', '人工校对关系', '回放与发布']" :key="name"><span>0{{ index + 1 }}</span><b>{{ name }}</b><small>{{ ['需求 / API / 数据字典', '对象 / 主键 / 粒度', '基数 / 来源 / 口径', '正反例 / 版本 / 差异'][index] }}</small></div></div><p>候选不是事实。发布不是授权。业务查询仍要通过企业权限检查。</p></div></section>
      <section class="v2-section v2-wrap"><div class="v2-section-head"><div><p class="v2-kicker">HOW IT WORKS</p><h2>{{ page === 'product' ? '围绕工作，而不止围绕消息。' : '让每一条关系，都能被核对。' }}</h2></div></div><div class="v2-trust-grid"><article v-for="(item, index) in (page === 'product' ? [['衔接上下文', '在已有任务中继续追问，结合材料与可用业务证据理解目标；记忆不替代当前权限。'], ['展开业务关联', '依据已发布模型解释对象、关系和来源；样本局部覆盖不能当作全企业范围。'], ['推进受控任务', '建议先展示，再根据具体动作取得确认。桌面操作依赖已注册端点和受控执行能力。']] : [['材料能追溯', '保留资料依据，区分字段含义、对象粒度与来源系统。'], ['差异能校对', '查看候选、修正映射、核对主键与关系基数，不自动采纳模型推测。'], ['发布能验证', '结构校验与正反例回放后审阅版本差异，再交给业务端使用。']])" :key="item[0]"><span>0{{ index + 1 }}</span><h3>{{ item[0] }}</h3><p>{{ item[1] }}</p></article></div></section>
      <section class="v2-screen-section"><div class="v2-wrap"><div class="v2-section-head"><div><p class="v2-kicker">INSIDE THE PRODUCT</p><h2>{{ page === 'product' ? '资料与引用，有自己的工作空间。' : '人工校对，是建模过程的一部分。' }}</h2></div><p>项目既有验证界面截图。<br/>图内为当时的演示状态，不代表当前生产连接。</p></div><a :href="page === 'product' ? '/product/knowledge-workspace.png' : '/product/semantic-review.png'" target="_blank" rel="noopener" class="product-screenshot" aria-label="打开产品验证截图原图（新窗口）"><img :src="page === 'product' ? '/product/knowledge-workspace.png' : '/product/semantic-review.png'" :alt="page === 'product' ? '智脑知识资料工作区历史验证界面，展示检索来源、资料与引用管理' : '元域智语人工校对历史验证界面，展示业务目标、验收问题和语义对象'" loading="lazy" :width="page === 'product' ? 1366 : 1440" :height="page === 'product' ? 768 : 900"/></a><p class="v2-caption">点击查看原图 · 所示为项目演示环境，不是客户部署案例。</p></div></section>
      <section class="v2-section v2-wrap v2-boundary"><h2>适合从一个明确的场景开始。</h2><p>{{ page === 'product' ? '需要已获授权的数据、发布的语义定义，以及可用的模型和运行环境。当前门户测试账号不会自动获得企业智脑访问权。' : '复杂规则仍需要人工建设和回放验证；不能承诺任意文档都能自动形成完整企业模型。建议先准备一条可核对的业务链。' }}</p><a class="v2-text-link" href="#/docs/walkthrough">按指南验证第一个场景 ↗</a></section>
    </template>

    <template v-else-if="page === 'demo'">
      <section class="v2-wrap v2-detail-hero"><p class="v2-kicker">INTERACTIVE WALKTHROUGH / {{ scenario.id }}</p><h1>从一份材料，<br/><em>到一条可核对的业务路径。</em></h1><p class="v2-lead">一步步查看元域智语与智脑如何协作。这里是固定合成样本的交互回放，不调用大模型，不读取或写入企业系统。</p></section>
      <section class="v2-wrap replay-section"><nav class="replay-nav" aria-label="案例步骤"><button v-for="(item, index) in scenario.steps" :key="item.title" :aria-current="stepIndex === index ? 'step' : undefined" @click="stepIndex = index"><span>0{{ index + 1 }}</span>{{ item.title }}</button></nav><div class="replay-content" aria-live="polite"><div><span class="v2-pill">{{ step.actor }} · {{ step.state }}</span><h2>{{ step.heading }}</h2><p>{{ step.body }}</p><div class="replay-detail">{{ step.detail }}</div></div><aside><p class="v2-kicker">REVIEW POINT</p><h3>{{ step.output }}</h3><p>{{ step.evidence }}</p><span class="replay-note">固定样本 v{{ scenario.version }} · 非生产结果</span></aside></div><div class="replay-controls"><button class="button secondary small" :disabled="stepIndex === 0" @click="stepIndex--">← 上一步</button><span>{{ stepIndex + 1 }} / {{ scenario.steps.length }}</span><button v-if="stepIndex < scenario.steps.length - 1" class="button small" @click="stepIndex++">下一步 →</button><button v-else class="button small" @click="stepIndex = 0">重新查看 ↺</button></div></section>
      <section class="v2-section v2-wrap"><div class="v2-section-head"><div><p class="v2-kicker">EXPLORE THE EVIDENCE</p><h2>关系可以点开，依据可以追问。</h2></div><p>试着切换两个 Agent，<br/>再点击不同业务对象。</p></div><DemoWorkbench/></section>
      <section class="v2-wrap v2-boundary"><h2>希望验证你自己的业务？</h2><p>先准备需求、API描述、字段字典及去标识化样本，再在受控运营端建模。门户演示不接受敏感业务材料。</p><a class="button secondary" href="#/docs/walkthrough">查看逐步指南 ↗</a></section>
    </template>

    <template v-else-if="page === 'architecture'">
      <section class="v2-wrap v2-detail-hero"><p class="v2-kicker">PLATFORM ARCHITECTURE</p><h1>在模型与业务之间，<br/><em>建立可理解的连接。</em></h1><p class="v2-lead">入口、Agent、语义知识和系统连接分层协作。点击每一层，查看职责与边界。这是产品概念分层，不是部署拓扑。</p></section>
      <section class="v2-wrap architecture-explorer"><div class="architecture-layers" aria-label="架构层选择"><button v-for="(layer, index) in layers" :key="layer.title" :aria-pressed="layerIndex === index" @click="layerIndex = index"><span>0{{ index + 1 }}</span><div><b>{{ layer.title }}</b><small>{{ layer.tags.join(' / ') }}</small></div><span>↗</span></button><p>贯穿约束：身份 · 数据授权 · 模型策略 · 人工确认 · 审计</p></div><article aria-live="polite"><p class="v2-kicker">LAYER 0{{ layerIndex + 1 }}</p><h2>{{ layers[layerIndex].title }}</h2><h3>{{ layers[layerIndex].subtitle }}</h3><p>{{ layers[layerIndex].body }}</p><a class="v2-text-link" :href="`#/docs/${layers[layerIndex].link}`">阅读相关文档 ↗</a></article></section>
      <section class="v2-section v2-wrap"><div class="v2-section-head"><div><p class="v2-kicker">CLEAR SEPARATION</p><h2>购买服务，不等于获得数据权限。</h2></div></div><div class="control-plane-grid"><article><span>产品客户管理</span><h3>账号、组织、订单与订阅</h3><p>管理客户关系、成员、测试余额与权益记录。使用独立门户API和数据存储。</p></article><div class="bridge-label">开通桥接<br/><b>待生产接入</b></div><article><span>企业执行环境</span><h3>智脑、语义与业务系统</h3><p>访问仍需企业身份、授权数据范围、已发布模型及实际运行环境。</p></article></div></section>
      <section class="v2-resources"><div class="v2-wrap"><h2>部署在哪里，数据去哪里，都要讲清楚。</h2><div class="v2-trust-grid"><article><h3>应用部署</h3><p>私有化方案需明确网络、存储、运维和验收范围，不是注册后自动生成实例。</p></article><article><h3>模型推理</h3><p>应用私有化不代表推理离线。使用云模型时须确认可出网的数据和处理策略。</p></article><article><h3>知识与业务数据</h3><p>资料检索不能代替实时业务事实；需要对来源、版本及权限分别核验。</p></article></div><a class="v2-text-link" href="#/docs/security">查看安全与接入说明 ↗</a></div></section>
    </template>

    <template v-else-if="page === 'pricing'">
      <section class="v2-wrap v2-detail-hero"><p class="v2-kicker">PLANS & DELIVERY</p><h1>先选适合的路径，<br/><em>再确定服务与交付范围。</em></h1><p class="v2-lead">从合成场景体验，到企业协作与系统接入。正式商业价格尚未发布，当前不开放真实收款。</p></section>
      <section class="v2-wrap v2-offerings"><article><span class="v2-kicker">EXPLORE</span><h2>产品体验</h2><p>适合初步了解元域工作方式。</p><ul><li>无需账号查看合成回放</li><li>双Agent与架构交互示意</li><li>公开技术文档</li></ul><a class="button secondary" href="#/demo">查看场景演示 ↗</a></article><article class="offering-featured"><span class="v2-kicker">TEAM VALIDATION</span><h2>团队验证</h2><p>验证组织、成员和订阅流程。</p><ul><li>创建测试管理空间</li><li>成员邀请与角色管理</li><li>沙箱会员、优惠券及账单</li></ul><a class="button" :href="loggedIn ? '#/console' : '#/register'">{{ loggedIn ? '进入客户中心' : '创建测试账号' }} ↗</a><small>不包含自动生产租户交付</small></article><article><span class="v2-kicker">ENTERPRISE</span><h2>企业接入</h2><p>按实际业务与部署要求评估。</p><ul><li>接口、样本与模型准备</li><li>企业身份和权限适配</li><li>部署、回放与交付验收</li></ul><a class="button secondary" href="#/docs/architecture">了解接入准备 ↗</a></article></section>
      <section class="v2-wrap v2-section"><h2>关于会员、余额和费用</h2><div class="v2-faq"><details><summary>现在可以在线付费开通智脑吗？</summary><p>不可以。当前只有明确标记的测试支付和管理空间；尚未开放真实支付，也未将门户账号桥接至生产企业环境。</p></details><details><summary>测试会员与模型用量是什么关系？</summary><p>目前不对真实模型Token计量扣费。测试会员、余额和优惠用于验证账务流程，不构成正式价格或运行配额承诺。</p></details><details><summary>企业接入需要准备什么？</summary><p>明确目标场景、身份源、数据授权、系统接口、字典和去标识化样本。随后建模、回放并验收。<a href="#/docs/modeling">阅读材料准备指南 →</a></p></details></div></section>
    </template>
    <section class="v2-end"><div class="v2-wrap"><div><p class="v2-kicker">START WITH ONE REAL QUESTION</p><h2>从一个业务问题，<br/>开始认识元域。</h2></div><div><a class="button" :href="page === 'demo' ? '#/docs/walkthrough' : '#/demo'">{{ page === 'demo' ? '阅读操作指南' : '查看场景演示' }} ↗</a><p>本地产品预览 · 合成演示 · 不执行真实业务</p></div></div></section>
  </div>
</template>
