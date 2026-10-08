<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
const props = defineProps({ client: { type: Object, required: true } });
const emit = defineEmits(['open-task']);
const schedules = ref([]); const notifications = ref([]); const busy = ref(false); const error = ref('');
const unread = computed(() => notifications.value.filter((item) => !item.readAt).length);
const actionableReviews = computed(() => notifications.value.filter((item) => !item.readAt && item.action?.type === 'open_semantic_task').slice(0, 3));
async function refresh() { try { const [a, b] = await Promise.all([props.client.inspections(), props.client.notifications()]); schedules.value = a.schedules || []; notifications.value = b.notifications || []; } catch (e) { error.value = e.message; } }
async function createSchedule() { busy.value = true; try { await props.client.createInspection({ name: '语义层日常只读巡检', checks: ['source_readiness', 'schema_integrity', 'deployment_drift', 'mapping_coverage'], intervalMinutes: 1440, runNow: true }); await refresh(); } catch (e) { error.value = e.message; } finally { busy.value = false; } }
async function control(item, action) { busy.value = true; try { await props.client.controlInspection(item.id, action); await refresh(); } catch (e) { error.value = e.message; } finally { busy.value = false; } }
async function read(item) { if (!item.readAt) { await props.client.readNotification(item.id); await refresh(); } }
async function openNotification(item) {
  await read(item);
  if (item.action?.type === 'open_semantic_task' && item.action.taskId) emit('open-task', item.action.taskId);
}
onMounted(refresh);
let notificationTimer = setInterval(refresh, 20000);
onBeforeUnmount(() => { if (notificationTimer) clearInterval(notificationTimer); });
defineExpose({ refresh });
</script>
<template>
  <section class="semantic-ops-center"><header><span>巡检与工作台待办</span><b>{{ unread }} 条未读</b></header><div v-if="actionableReviews.length" class="review-todos"><span>待处理模型</span><button v-for="item in actionableReviews" :key="item.id" @click="openNotification(item)"><b>{{ item.title }}</b><small>{{ item.message }}</small><em>打开审核任务 →</em></button></div><button v-if="!schedules.some(item => item.status === 'active')" :disabled="busy" @click="createSchedule">＋ 启用每日只读巡检</button><article v-for="item in schedules.slice(0, 2)" :key="item.id"><b>{{ item.name }}</b><small>{{ item.status }} · 下次 {{ item.nextRunAt.slice(5,16).replace('T',' ') }}</small><p v-if="item.lastRun">{{ item.lastRun.result?.summary || item.lastRun.error }}</p><div><button v-if="item.status === 'active'" @click="control(item,'pause')">暂停</button><button v-else-if="item.status === 'paused'" @click="control(item,'resume')">恢复</button><button v-if="item.status !== 'cancelled'" @click="control(item,'run-now')">立即检查</button></div></article><details v-if="notifications.length"><summary>查看全部语义通知</summary><button v-for="item in notifications.slice(0, 8)" :key="item.id" :class="['semantic-notification', { unread: !item.readAt, actionable: item.action?.type === 'open_semantic_task' }]" @click="openNotification(item)"><b>{{ item.title }}</b><small>{{ item.message }}</small><em v-if="item.action?.type === 'open_semantic_task'">打开模型审核任务 →</em></button></details><small v-if="error">{{ error }}</small></section>
</template>
<style scoped>
.semantic-notification{display:grid;width:100%;gap:5px;margin-top:6px;padding:9px 10px;text-align:left;border:1px solid #29495a;border-radius:7px;color:#b7d2dd;background:#0a1d29;cursor:pointer}
.semantic-notification b{color:#d4e8ec;font-size:11px}
.semantic-notification small{color:#7f9ca8;font-size:10px;line-height:1.5}
.semantic-notification em{color:#58d2bd;font-size:10px;font-style:normal}
.semantic-notification.unread{border-color:#397a76;background:#0d292d}
.semantic-notification.actionable:hover{border-color:#64cbb7;background:#10343a}
.review-todos{display:grid;gap:6px;margin:8px 0;padding:8px;border:1px solid #526841;border-radius:7px;background:#1d291f}.review-todos>span{color:#c6cb90;font-size:9px}.review-todos>button{display:grid;gap:4px;width:100%;padding:7px;border:1px solid #405c45;border-radius:5px;text-align:left;background:#14221d;cursor:pointer}.review-todos>button b{color:#d7e8d7;font-size:10px}.review-todos>button small{color:#99b0a0;font-size:9px;line-height:1.45}.review-todos>button em{color:#7fe0c3;font-size:9px;font-style:normal}
</style>
