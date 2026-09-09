<script setup>
import { ref } from 'vue';
defineProps({ messages: Array, role: String, status: String, runtime: Object });
const emit = defineEmits(['send', 'execute']);
const draft = ref(''); const listening = ref(false);
function submit() { const text = draft.value.trim(); if (!text) return; emit('send', text); draft.value = ''; }
function startVoice() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) { draft.value = '采购 500kg 维生素 C，8 月 10 日前到货'; return; }
  const recognition = new Recognition(); recognition.lang = 'zh-CN'; recognition.interimResults = false; listening.value = true;
  recognition.onresult = (event) => { draft.value = event.results[0][0].transcript; listening.value = false; };
  recognition.onerror = () => { listening.value = false; }; recognition.onend = () => { listening.value = false; }; recognition.start();
}
</script>
<template>
  <div class="page mobile-assistant-page">
    <div class="section-header"><div><span class="eyebrow">MOBILE COPILOT · PRIVATE AGENT</span><h2>移动智能助手</h2><p>面向业务人员的语音与文字入口；私有 Agent 在当前用户授权范围内理解意图、协调子 Agent、组装证据并发起需确认的业务动作。</p></div><div class="assistant-live"><i/> {{ runtime?.runtime?.mode || 'mock' }} · 授权上下文已加载</div></div>
    <section class="assistant-layout"><div class="phone-stage"><div class="phone-frame"><div class="phone-notch"/><div class="phone-header"><div><small>{{ runtime?.agentId || 'PRIVATE AGENT' }}</small><b>企业行动助手</b></div><span>•••</span></div><div class="chat-window"><div v-for="(message,index) in messages" :key="index" :class="['chat-message', message.role]"><span v-if="message.role === 'assistant'" class="bot-avatar">A</span><div><p>{{ message.text }}</p><div v-if="message.citations?.length" class="citation-chips"><span v-for="item in message.citations" :key="item">{{ item }}</span></div><div v-if="message.route?.length" class="citation-chips"><span v-for="agent in message.route" :key="agent.id">{{ agent.label }}</span></div><div v-if="message.plan?.length" class="agent-plan"><span v-for="item in message.plan" :key="item.tool">{{ item.tool }} · {{ item.status }}</span></div><div v-if="message.runId" class="citation-chips"><span>任务 {{ message.runId }}</span></div><div v-if="message.command" class="assistant-command"><b>{{ message.command.impact }}</b><button @click="emit('execute', message.command.id, message.runId, message.command.confirmationToken)">{{ message.command.label }}</button></div></div></div></div><div class="phone-input"><button :class="{ listening }" @click="startVoice">{{ listening ? '●' : '◉' }}</button><input v-model="draft" placeholder="输入或说出你的业务需求…" @keyup.enter="submit"/><button class="send" @click="submit">→</button></div></div><p class="voice-hint">点击左侧圆形按钮使用浏览器语音识别；不可用时自动填入演示语音指令。</p></div>
      <aside class="assistant-side"><article class="panel assistant-context"><span class="eyebrow">RUNTIME CONTEXT</span><h3>Agent 此次可用的上下文</h3><div><span>当前角色</span><b>{{ role }}</b></div><div><span>私有模型</span><b>{{ runtime?.runtime?.model || '加载中' }}</b></div><div><span>世界模型</span><b>已加载受控对象与关系</b></div><div><span>密钥状态</span><b>请求级短时凭据</b></div><div><span>动作状态</span><b>{{ status }}</b></div></article><article class="panel assistant-capabilities"><span class="eyebrow">CAPABILITIES</span><h3>已启用业务能力</h3><div><i>01</i><div><b>生产与采购协同</b><p>核算需求、校验质量与供应商、创建 ERP 草稿并路由审批。</p></div></div><div><i>02</i><div><b>多 Agent 受控分析</b><p>生产、市场、内务子 Agent 只处理授权范围内的数据。</p></div></div><div><i>03</i><div><b>受控行动确认</b><p>涉及写入、资金或质量动作时必须显式确认。</p></div></div></article><article class="panel assistant-guard"><b>私有 Agent 安全承诺</b><p>Agent 不会绕过审批直接写入 ERP、MES 或 LIMS；每项动作都带有权限、证据、审批和审计链。</p></article></aside></section>
  </div>
</template>
