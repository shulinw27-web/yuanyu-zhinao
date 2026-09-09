<script setup>
import { AgentWorkbench } from '@healthcare-ai/agent-workbench';

const isElectron = Boolean(globalThis.zhinaoDesktop);
</script>

<template>
  <AgentWorkbench layout="desktop" platform="desktop" app-version="0.3.0" :class="{ 'electron-host': isElectron }"/>
</template>
