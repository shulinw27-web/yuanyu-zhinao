<script setup>
import { computed, onUnmounted, ref } from 'vue';
import * as sdk from 'dingtalk-jsapi';
import { AgentWorkbench } from '@healthcare-ai/agent-workbench';
import { createAgentClient } from '@healthcare-ai/agent-sdk';
import { authenticateDingTalk, dingTalkPlatform, workbenchLayout } from './dingtalk-host.js';

const platform = dingTalkPlatform(navigator.userAgent);
// Do not silently reuse an earlier employee's localStorage session after a
// DingTalk account switch. Each document load verifies the current host user.
const client = createAgentClient({ platform, appVersion: '0.3.0', role: null, persistIdentity: false, identityProviderId: 'dingtalk' });
const width = ref(window.innerWidth);
const height = ref(window.visualViewport?.height || window.innerHeight);
const layout = computed(() => workbenchLayout(width.value));
const compact = computed(() => width.value <= 900 && height.value < 600);
const resize = () => {
  width.value = window.innerWidth;
  height.value = window.visualViewport?.scale === 1 ? window.visualViewport.height : window.innerHeight;
};
window.addEventListener('resize', resize);
window.visualViewport?.addEventListener('resize', resize);
onUnmounted(() => {
  window.removeEventListener('resize', resize);
  window.visualViewport?.removeEventListener('resize', resize);
});
const login = () => authenticateDingTalk({ client, sdk });
</script>

<template>
  <AgentWorkbench class="dingtalk-host" :class="{ 'compact-viewport': compact }" :style="{ '--dingtalk-viewport-height': `${height}px` }" :layout="layout" :platform="platform" app-version="0.3.0" :agent-client="client" :identity-login-provider="login" identity-provider-name="钉钉" identity-entry-hint="支持手机钉钉与电脑钉钉。请从企业工作台打开本应用。" :disable-desktop-bridge="true"/>
</template>
