<script setup>
import { computed, onMounted, ref } from 'vue';
const props = defineProps({ client: { type: Object, required: true } });
const schedules = ref([]); const notifications = ref([]); const busy = ref(false); const error = ref('');
const unread = computed(() => notifications.value.filter((item) => !item.readAt).length);
async function refresh() { try { const [a, b] = await Promise.all([props.client.inspections(), props.client.notifications()]); schedules.value = a.schedules || []; notifications.value = b.notifications || []; } catch (e) { error.value = e.message; } }
async function createSchedule() { busy.value = true; try { await props.client.createInspection({ name: '语义层日常只读巡检', checks: ['source_readiness', 'schema_integrity', 'deployment_drift', 'mapping_coverage'], intervalMinutes: 1440, runNow: true }); await refresh(); } catch (e) { error.value = e.message; } finally { busy.value = false; } }
async function control(item, action) { busy.value = true; try { await props.client.controlInspection(item.id, action); await refresh(); } catch (e) { error.value = e.message; } finally { busy.value = false; } }
async function read(item) { if (!item.readAt) { await props.client.readNotification(item.id); await refresh(); } }
onMounted(refresh);
</script>
<template>
  <section class="semantic-ops-center"><header><span>只读巡检与通知</span><b>{{ unread }} 条未读</b></header><button v-if="!schedules.some(item => item.status === 'active')" :disabled="busy" @click="createSchedule">＋ 启用每日只读巡检</button><article v-for="item in schedules.slice(0, 2)" :key="item.id"><b>{{ item.name }}</b><small>{{ item.status }} · 下次 {{ item.nextRunAt.slice(5,16).replace('T',' ') }}</small><p v-if="item.lastRun">{{ item.lastRun.result?.summary || item.lastRun.error }}</p><div><button v-if="item.status === 'active'" @click="control(item,'pause')">暂停</button><button v-else-if="item.status === 'paused'" @click="control(item,'resume')">恢复</button><button v-if="item.status !== 'cancelled'" @click="control(item,'run-now')">立即检查</button></div></article><details v-if="notifications.length"><summary>查看语义通知</summary><button v-for="item in notifications.slice(0, 8)" :key="item.id" :class="{ unread: !item.readAt }" @click="read(item)"><b>{{ item.title }}</b><small>{{ item.message }}</small></button></details><small v-if="error">{{ error }}</small></section>
</template>
