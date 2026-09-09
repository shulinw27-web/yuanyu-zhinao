<script setup>defineProps({ label: String, value: [String, Number], hint: String, tone: { type: String, default: 'blue' } });</script>
<template><article :class="['metric-card', tone]"><span>{{ label }}</span><strong>{{ value }}</strong><small>{{ hint }}</small></article></template>
