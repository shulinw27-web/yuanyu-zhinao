<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
const props = defineProps({ client: { type: Object, required: true } });
const emit = defineEmits(['open-task']);
const schedules = ref([]); const notifications = ref([]); const busy = ref(false); const error = ref('');
const selectedInspectionId = ref('');
const unread = computed(() => notifications.value.filter((item) => !item.readAt).length);
const actionableReviews = computed(() => notifications.value.filter((item) => !item.readAt && item.action?.type === 'open_semantic_task').slice(0, 3));
async function refresh() { try { const [a, b] = await Promise.all([props.client.inspections(), props.client.notifications()]); schedules.value = a.schedules || []; notifications.value = b.notifications || []; } catch (e) { error.value = e.message; } }
async function createSchedule() { busy.value = true; try { await props.client.createInspection({ name: '语义层日常只读巡检', checks: ['source_readiness', 'schema_integrity', 'deployment_drift', 'mapping_coverage'], intervalMinutes: 1440, runNow: true }); await refresh(); } catch (e) { error.value = e.message; } finally { busy.value = false; } }
async function control(item, action) { busy.value = true; try { await props.client.controlInspection(item.id, action); await refresh(); } catch (e) { error.value = e.message; } finally { busy.value = false; } }
async function read(item) { if (!item.readAt) { await props.client.readNotification(item.id); await refresh(); } }
async function openNotification(item) {
  await read(item);
  if (item.action?.type === 'open_semantic_task' && item.action.taskId) emit('open-task', item.action.taskId);
  if (item.action?.type === 'open_inspection' && item.action.id) {
    selectedInspectionId.value = item.action.id;
    await nextTick();
    const target = document.querySelector(`[data-inspection-id="${item.action.id}"]`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    else error.value = '对应巡检计划已不存在或当前身份不可见。';
  }
}
onMounted(refresh);
let notificationTimer = setInterval(refresh, 20000);
onBeforeUnmount(() => { if (notificationTimer) clearInterval(notificationTimer); });
defineExpose({ refresh });
</script>
<template>
  <section class="semantic-ops-center" aria-label="语义巡检和工作台待办">
    <header><span>治理提醒</span><b>{{ unread }} 条未读</b></header>
    <section class="ops-center-group inspection-group">
      <header><b>只读语义巡检</b><small>检查来源、模型结构、部署差异和映射覆盖；不会自动修改或发布。</small></header>
      <button v-if="!schedules.some(item => item.status === 'active')" :disabled="busy" @click="createSchedule">＋ 启用每日只读巡检</button>
      <p class="worker-note">“请求立即巡检”会将任务交给后台 Worker；只有 Worker 正在运行时才会执行。</p>
      <article v-for="item in schedules" :key="item.id" :data-inspection-id="item.id" :class="{ 'inspection-selected': selectedInspectionId === item.id }">
        <b>{{ item.name }}</b><small>{{ item.status }} · 下次 {{ item.nextRunAt.slice(5,16).replace('T',' ') }}</small>
        <p v-if="item.lastRun">最近结果：{{ item.lastRun.result?.summary || item.lastRun.error }} · {{ item.lastRun.finishedAt }}</p>
        <div><button v-if="item.status === 'active'" :disabled="busy" @click="control(item,'pause')">暂停</button><button v-else-if="item.status === 'paused'" :disabled="busy" @click="control(item,'resume')">恢复</button><button v-if="item.status !== 'cancelled'" :disabled="busy" @click="control(item,'run-now')">请求立即巡检</button></div>
      </article>
      <p v-if="!schedules.length" class="group-empty">尚未启用巡检计划。</p>
    </section>
    <section class="ops-center-group workbench-todo-group">
      <header><b>工作台待办</b><small>需要人工处理的模型审核等事项，不是巡检任务。</small></header>
      <button v-for="item in actionableReviews" :key="item.id" class="todo-item" @click="openNotification(item)"><b>{{ item.title }}</b><small>{{ item.message }}</small><em>打开 Agent 审核任务 →</em></button>
      <p v-if="!actionableReviews.length" class="group-empty">当前没有未读的工作台审核待办。</p>
    </section>
    <details v-if="notifications.length" class="all-notifications"><summary>查看全部语义通知</summary><button v-for="item in notifications.slice(0, 8)" :key="item.id" :class="['semantic-notification', { unread: !item.readAt, actionable: Boolean(item.action) }]" @click="openNotification(item)"><b>{{ item.title }}</b><small>{{ item.message }}</small><em v-if="item.action?.type === 'open_semantic_task'">打开模型审核任务 →</em><em v-else-if="item.action?.type === 'open_inspection'">定位对应巡检计划 →</em></button></details>
    <small v-if="error" class="center-error">{{ error }}</small>
  </section>
</template>
<style scoped>
.semantic-notification{display:grid;width:100%;gap:5px;margin-top:6px;padding:9px 10px;text-align:left;border:1px solid #29495a;border-radius:7px;color:#b7d2dd;background:#0a1d29;cursor:pointer}
.semantic-notification b{color:#d4e8ec;font-size:11px}
.semantic-notification small{color:#7f9ca8;font-size:10px;line-height:1.5}
.semantic-notification em{color:#58d2bd;font-size:10px;font-style:normal}
.semantic-notification.unread{border-color:#397a76;background:#0d292d}
.semantic-notification.actionable:hover{border-color:#64cbb7;background:#10343a}
.review-todos{display:grid;gap:6px;margin:8px 0;padding:8px;border:1px solid #526841;border-radius:7px;background:#1d291f}.review-todos>span{color:#c6cb90;font-size:9px}.review-todos>button{display:grid;gap:4px;width:100%;padding:7px;border:1px solid #405c45;border-radius:5px;text-align:left;background:#14221d;cursor:pointer}.review-todos>button b{color:#d7e8d7;font-size:10px}.review-todos>button small{color:#99b0a0;font-size:9px;line-height:1.45}.review-todos>button em{color:#7fe0c3;font-size:9px;font-style:normal}
.semantic-ops-center{display:grid;gap:9px}.semantic-ops-center>header{display:flex;justify-content:space-between}.semantic-ops-center>header span{color:#9fc5d1;font-size:10px}.semantic-ops-center>header>b{color:#63d1bd;font-size:9px}.ops-center-group{display:grid;gap:7px;padding:9px;border:1px solid #274959;border-radius:7px;background:#081b27}.ops-center-group>header{display:grid;gap:4px}.ops-center-group>header>b{color:#b8d4db;font-size:10px}.ops-center-group>header>small,.worker-note,.group-empty{margin:0;color:#7594a2;font-size:8px;line-height:1.5}.semantic-ops-center>button,.semantic-ops-center article button,.semantic-ops-center details button,.ops-center-group>button{border:1px solid #31586a;border-radius:5px;padding:6px;color:#85b2bf;background:#0b2634;font-size:8px}.semantic-ops-center article{display:grid;gap:5px;padding:8px;border:1px solid #274959;border-radius:6px;background:#0a202c;scroll-margin:18px;transition:border-color .2s,box-shadow .2s}.semantic-ops-center article.inspection-selected{border-color:#64d6bd;box-shadow:0 0 0 2px #64d6bd30}.semantic-ops-center article>b{color:#b8d4db;font-size:9px}.semantic-ops-center article small,.semantic-ops-center article p{margin:0;color:#6f929f;font-size:8px;line-height:1.5}.semantic-ops-center article div{display:flex;gap:5px;flex-wrap:wrap}.todo-item{display:grid;gap:5px;width:100%;text-align:left}.todo-item b{color:#d4e8ec;font-size:9px}.todo-item small{color:#7f9ca8;font-size:8px;line-height:1.5}.todo-item em,.semantic-notification em{color:#58d2bd;font-size:8px;font-style:normal}.all-notifications>summary{color:#85b2bf;font-size:9px;cursor:pointer}.semantic-ops-center details>button{display:grid;width:100%;margin-top:5px;text-align:left}.semantic-ops-center details>button.unread{border-color:#51cbb0}.semantic-ops-center details small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.center-error{color:#e7a2a6;font-size:8px}
</style>
