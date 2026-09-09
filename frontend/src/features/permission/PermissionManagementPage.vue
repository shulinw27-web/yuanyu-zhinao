<script setup>
import { computed, ref, watch } from 'vue';

const props = defineProps({
  workspace: { type: Object, default: null },
  role: { type: String, default: '' },
  message: { type: String, default: '' },
  saving: { type: Boolean, default: false },
});

const emit = defineEmits(['assign-user', 'save-policy']);

const tabs = [
  { id: 'people', name: '人员角色', eyebrow: 'IDENTITY' },
  { id: 'permissions', name: '角色权限', eyebrow: 'RBAC' },
  { id: 'data', name: '数据权限', eyebrow: 'DATA SCOPE' },
  { id: 'audits', name: '审计记录', eyebrow: 'AUDIT' },
];

const activeTab = ref('people');
const selectedOrganizationId = ref('all');
const selectedRoleId = ref('');
const userSearch = ref('');
const policyReason = ref('');
const userDrafts = ref({});
const policyDraft = ref({ menuIds: [], buttonPermissionIds: [], dataScope: { mode: 'self', organizationIds: [] } });

const organizations = computed(() => props.workspace?.organizations || []);
const users = computed(() => props.workspace?.users || []);
const roles = computed(() => props.workspace?.roles || []);
const permissionCatalog = computed(() => props.workspace?.permissionCatalog || []);
const dataScopeModes = computed(() => props.workspace?.dataScopeModes || []);
const audits = computed(() => props.workspace?.audits || []);
const canManage = computed(() => Boolean(props.workspace?.canManage));
const canViewAudits = computed(() => (props.workspace?.effectiveAccess?.buttonPermissionIds || []).includes('permission.audit.view'));
const visibleTabs = computed(() => tabs.filter((tab) => tab.id !== 'audits' || canViewAudits.value));
const selectedRole = computed(() => roles.value.find((item) => item.id === selectedRoleId.value) || null);

const organizationRows = computed(() => {
  const children = new Map();
  organizations.value.forEach((organization) => {
    const parentId = organization.parentId || '__root__';
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(organization);
  });
  const output = [];
  const visited = new Set();
  const append = (parentId, depth) => {
    (children.get(parentId) || []).forEach((organization) => {
      if (visited.has(organization.id)) return;
      visited.add(organization.id);
      output.push({ ...organization, depth });
      append(organization.id, depth + 1);
    });
  };
  append('__root__', 0);
  organizations.value.forEach((organization) => {
    if (!visited.has(organization.id)) output.push({ ...organization, depth: 0 });
  });
  return output;
});

const selectedOrganizationIds = computed(() => {
  if (selectedOrganizationId.value === 'all') return null;
  const result = new Set([selectedOrganizationId.value]);
  let changed = true;
  while (changed) {
    changed = false;
    organizations.value.forEach((organization) => {
      if (result.has(organization.parentId) && !result.has(organization.id)) {
        result.add(organization.id);
        changed = true;
      }
    });
  }
  return result;
});

const filteredUsers = computed(() => {
  const keyword = userSearch.value.trim().toLowerCase();
  return users.value.filter((user) => {
    const matchesOrganization = !selectedOrganizationIds.value || selectedOrganizationIds.value.has(user.orgUnitId);
    const text = [user.name, user.account, user.title, user.department, ...(user.sources || [])].filter(Boolean).join(' ').toLowerCase();
    return matchesOrganization && (!keyword || text.includes(keyword));
  });
});

const summaryCards = computed(() => [
  { label: '组织节点', value: props.workspace?.summary?.organizationCount ?? organizations.value.length, note: '数据权限继承边界' },
  { label: '平台人员', value: props.workspace?.summary?.userCount ?? users.value.length, note: `${users.value.filter((item) => item.status === 'active' || item.status === '启用').length} 人状态正常` },
  { label: '角色策略', value: props.workspace?.summary?.roleCount ?? roles.value.length, note: '菜单、按钮与数据域统一版本' },
  { label: '按钮权限', value: props.workspace?.summary?.buttonPermissionCount ?? permissionCatalog.value.reduce((total, menu) => total + (menu.buttons?.length || 0), 0), note: '最小授权粒度' },
]);

const selectedScopeMode = computed(() => dataScopeModes.value.find((item) => item.id === policyDraft.value.dataScope.mode));
const selectedScopeOrganizations = computed(() => organizationRows.value.filter((item) => policyDraft.value.dataScope.organizationIds.includes(item.id)));
const policyCanSave = computed(() => {
  if (!canManage.value || props.saving || !selectedRole.value || !policyReason.value.trim()) return false;
  if (policyDraft.value.dataScope.mode === 'selected_orgs' && !policyDraft.value.dataScope.organizationIds.length) return false;
  return true;
});

function normalizeIds(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function syncUserDrafts() {
  userDrafts.value = Object.fromEntries(users.value.map((user) => [user.id, {
    orgUnitId: user.orgUnitId || '',
    roleIds: normalizeIds(user.roleIds || (user.primaryRoleId ? [user.primaryRoleId] : [])),
  }]));
}

function syncPolicyDraft() {
  const policy = selectedRole.value?.policy;
  policyDraft.value = {
    menuIds: normalizeIds(policy?.menuIds),
    buttonPermissionIds: normalizeIds(policy?.buttonPermissionIds),
    dataScope: {
      mode: policy?.dataScope?.mode || 'self',
      organizationIds: normalizeIds(policy?.dataScope?.organizationIds),
    },
  };
  policyReason.value = '';
}

watch(users, syncUserDrafts, { immediate: true, deep: true });
watch(roles, (nextRoles) => {
  if (!nextRoles.some((item) => item.id === selectedRoleId.value)) selectedRoleId.value = nextRoles[0]?.id || '';
  syncPolicyDraft();
}, { immediate: true, deep: true });
watch(selectedRoleId, syncPolicyDraft);
watch(canViewAudits, (allowed) => {
  if (!allowed && activeTab.value === 'audits') activeTab.value = 'people';
});

function isUserDirty(user) {
  const draft = userDrafts.value[user.id];
  if (!draft) return false;
  const originalRoleIds = normalizeIds(user.roleIds || (user.primaryRoleId ? [user.primaryRoleId] : [])).sort();
  return draft.orgUnitId !== (user.orgUnitId || '') || [...draft.roleIds].sort().join('|') !== originalRoleIds.join('|');
}

function toggleUserRole(userId, roleId) {
  const draft = userDrafts.value[userId];
  if (!draft || !canManage.value || props.saving) return;
  draft.roleIds = draft.roleIds.includes(roleId)
    ? draft.roleIds.filter((id) => id !== roleId)
    : [...draft.roleIds, roleId];
}

function assignUser(user) {
  const draft = userDrafts.value[user.id];
  if (!draft || !canManage.value || props.saving || !draft.orgUnitId || !draft.roleIds.length) return;
  emit('assign-user', {
    userId: user.id,
    orgUnitId: draft.orgUnitId,
    roleIds: [...draft.roleIds],
    expectedVersion: user.version ?? props.workspace?.version,
  });
}

function menuChecked(menuId) {
  return policyDraft.value.menuIds.includes(menuId);
}

function buttonChecked(buttonId) {
  return policyDraft.value.buttonPermissionIds.includes(buttonId);
}

function toggleMenu(menu, checked) {
  if (!canManage.value || props.saving) return;
  policyDraft.value.menuIds = checked
    ? normalizeIds([...policyDraft.value.menuIds, menu.menuId])
    : policyDraft.value.menuIds.filter((id) => id !== menu.menuId);
  if (!checked) {
    const childIds = new Set((menu.buttons || []).map((button) => button.id));
    policyDraft.value.buttonPermissionIds = policyDraft.value.buttonPermissionIds.filter((id) => !childIds.has(id));
  }
}

function toggleButton(menu, buttonId, checked) {
  if (!canManage.value || props.saving) return;
  policyDraft.value.buttonPermissionIds = checked
    ? normalizeIds([...policyDraft.value.buttonPermissionIds, buttonId])
    : policyDraft.value.buttonPermissionIds.filter((id) => id !== buttonId);
  if (checked && !policyDraft.value.menuIds.includes(menu.menuId)) {
    policyDraft.value.menuIds = [...policyDraft.value.menuIds, menu.menuId];
  }
}

function selectAllButtons(menu) {
  toggleMenu(menu, true);
  policyDraft.value.buttonPermissionIds = normalizeIds([
    ...policyDraft.value.buttonPermissionIds,
    ...(menu.buttons || []).map((button) => button.id),
  ]);
}

function changeDataScope(mode) {
  policyDraft.value.dataScope.mode = mode;
  if (mode !== 'selected_orgs') policyDraft.value.dataScope.organizationIds = [];
}

function toggleScopeOrganization(organizationId, checked) {
  policyDraft.value.dataScope.organizationIds = checked
    ? normalizeIds([...policyDraft.value.dataScope.organizationIds, organizationId])
    : policyDraft.value.dataScope.organizationIds.filter((id) => id !== organizationId);
}

function savePolicy() {
  if (!policyCanSave.value) return;
  emit('save-policy', {
    roleId: selectedRole.value.id,
    menuIds: [...policyDraft.value.menuIds],
    buttonPermissionIds: [...policyDraft.value.buttonPermissionIds],
    dataScope: {
      mode: policyDraft.value.dataScope.mode,
      organizationIds: policyDraft.value.dataScope.mode === 'selected_orgs' ? [...policyDraft.value.dataScope.organizationIds] : [],
    },
    expectedVersion: selectedRole.value.version ?? props.workspace?.version,
    reason: policyReason.value.trim(),
  });
}

function auditTime(audit) {
  const raw = audit.createdAt || audit.timestamp || audit.at || audit.time;
  if (!raw) return '时间未记录';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString('zh-CN', { hour12: false });
}
</script>

<template>
  <div v-if="workspace" class="page permission-management-page">
    <section class="permission-hero">
      <div>
        <span class="eyebrow">IDENTITY · ROLE · PERMISSION · ORGANIZATION</span>
        <h2>权限与人员角色管理</h2>
        <p>以组织架构为数据边界，统一管理人员多角色、页面访问和按钮级操作权限。所有变更均携带版本号并写入审计。</p>
      </div>
      <div class="permission-hero-status">
        <span>当前配置版本</span>
        <strong>v{{ workspace.version ?? '—' }}</strong>
        <em :class="canManage ? 'can-manage' : 'read-only'">{{ canManage ? '可管理' : '只读访问' }}</em>
      </div>
    </section>

    <div class="permission-summary-grid">
      <article v-for="item in summaryCards" :key="item.label">
        <span>{{ item.label }}</span><strong>{{ item.value }}</strong><small>{{ item.note }}</small>
      </article>
    </div>

    <div v-if="message" class="permission-message" role="status">{{ message }}</div>
    <div v-if="!canManage" class="permission-readonly-note">当前角色 {{ role }} 仅可查看权限快照，人员分配和策略保存已禁用。</div>

    <nav class="permission-tabs" aria-label="权限管理模块">
      <button v-for="tab in visibleTabs" :key="tab.id" type="button" :class="{ active: activeTab === tab.id }" :aria-selected="activeTab === tab.id" @click="activeTab = tab.id">
        <span>{{ tab.eyebrow }}</span><b>{{ tab.name }}</b>
      </button>
    </nav>

    <section v-if="activeTab === 'people'" class="permission-workspace people-workspace">
      <aside class="panel organization-filter">
        <div class="permission-subhead"><div><span>ORGANIZATION TREE</span><h3>组织架构</h3></div><b>{{ organizations.length }}</b></div>
        <div class="organization-tree" role="tree">
          <button type="button" :class="{ selected: selectedOrganizationId === 'all' }" role="treeitem" @click="selectedOrganizationId = 'all'">
            <i class="tree-node root">企</i><span><b>全部组织</b><small>{{ users.length }} 名人员</small></span>
          </button>
          <button v-for="organization in organizationRows" :key="organization.id" type="button" :class="{ selected: selectedOrganizationId === organization.id }" :style="{ '--tree-depth': organization.depth }" role="treeitem" @click="selectedOrganizationId = organization.id">
            <i class="tree-node">{{ organization.depth ? '└' : '◆' }}</i><span><b>{{ organization.name }}</b><small>{{ organization.code }} · {{ organization.memberCount ?? 0 }} 人</small></span><em :class="organization.status">{{ organization.status || 'active' }}</em>
          </button>
        </div>
        <div class="role-legend">
          <span>角色目录</span>
          <div v-for="item in roles" :key="item.id"><i :style="{ background: item.color || '#35d7ff' }"/><b>{{ item.name }}</b><small>{{ item.memberCount ?? 0 }}</small></div>
        </div>
      </aside>

      <div class="panel people-directory">
        <div class="permission-subhead people-heading">
          <div><span>PEOPLE & ROLE ASSIGNMENT</span><h3>人员与角色分配</h3><p>一个人员可承担多个业务角色；组织归属同时决定其数据权限解析起点。</p></div>
          <label class="permission-search"><span>筛选人员</span><input v-model.trim="userSearch" type="search" placeholder="姓名、账号、岗位或身份源" /></label>
        </div>
        <div v-if="filteredUsers.length" class="people-table-wrap">
          <div class="people-table-head"><span>人员</span><span>组织归属</span><span>角色（可多选）</span><span>身份状态</span><span>操作</span></div>
          <div v-for="user in filteredUsers" :key="user.id" class="people-table-row">
            <div class="person-cell"><i>{{ user.name?.slice(0, 1) || '?' }}</i><span><b>{{ user.name }}</b><small>{{ user.account }} · {{ user.title || '未设置岗位' }}</small></span></div>
            <select v-if="userDrafts[user.id]" v-model="userDrafts[user.id].orgUnitId" :disabled="!canManage || saving" aria-label="人员组织归属">
              <option value="" disabled>请选择组织</option><option v-for="organization in organizationRows" :key="organization.id" :value="organization.id">{{ '\u3000'.repeat(organization.depth) }}{{ organization.name }}</option>
            </select>
            <div v-if="userDrafts[user.id]" class="user-role-options">
              <label v-for="item in roles" :key="item.id" :class="{ checked: userDrafts[user.id].roleIds.includes(item.id) }"><input type="checkbox" :checked="userDrafts[user.id].roleIds.includes(item.id)" :disabled="!canManage || saving" @change="toggleUserRole(user.id, item.id)" /><i :style="{ background: item.color || '#35d7ff' }"/>{{ item.name }}</label>
            </div>
            <div class="identity-cell"><b :class="user.status">{{ user.status }}</b><small>{{ (user.sources || []).join(' · ') || '本地账号' }}</small></div>
            <button type="button" class="permission-primary-button" :disabled="!canManage || saving || !isUserDirty(user) || !userDrafts[user.id]?.orgUnitId || !userDrafts[user.id]?.roleIds.length" @click="assignUser(user)">{{ saving ? '保存中…' : '保存分配' }}</button>
          </div>
        </div>
        <div v-else class="permission-empty"><b>没有匹配的人员</b><p>请切换组织节点或调整搜索条件。</p></div>
      </div>
    </section>

    <section v-else-if="activeTab === 'permissions'" class="permission-workspace policy-workspace">
      <aside class="panel role-policy-list">
        <div class="permission-subhead"><div><span>ROLE POLICY</span><h3>选择角色</h3></div></div>
        <button v-for="item in roles" :key="item.id" type="button" :class="{ selected: selectedRoleId === item.id }" @click="selectedRoleId = item.id">
          <i :style="{ background: item.color || '#35d7ff' }"/><span><b>{{ item.name }}</b><small>{{ item.team }} · {{ item.memberCount ?? 0 }} 人</small></span><em v-if="item.system">系统角色</em>
        </button>
      </aside>
      <div v-if="selectedRole" class="panel permission-matrix-panel">
        <div class="permission-subhead matrix-heading"><div><span>MENU & BUTTON MATRIX</span><h3>{{ selectedRole.name }} · 权限矩阵</h3><p>选中按钮时会自动授予所属页面；取消页面将同步移除该页面下的按钮权限。</p></div><div><b>{{ policyDraft.menuIds.length }}</b><span>页面</span><b>{{ policyDraft.buttonPermissionIds.length }}</b><span>按钮</span></div></div>
        <div v-if="permissionCatalog.length" class="permission-matrix">
          <article v-for="menu in permissionCatalog" :key="menu.id || menu.menuId" :class="{ enabled: menuChecked(menu.menuId) }">
            <header><label><input type="checkbox" :checked="menuChecked(menu.menuId)" :disabled="!canManage || saving" @change="toggleMenu(menu, $event.target.checked)" /><span><b>{{ menu.name }}</b><small>{{ menu.menuId }}</small></span></label><button type="button" :disabled="!canManage || saving || !(menu.buttons || []).length" @click="selectAllButtons(menu)">全选按钮</button></header>
            <div v-if="menu.buttons?.length" class="button-permission-grid">
              <label v-for="button in menu.buttons" :key="button.id" :class="[{ checked: buttonChecked(button.id) }, `risk-${button.risk || 'low'}`]"><input type="checkbox" :checked="buttonChecked(button.id)" :disabled="!canManage || saving" @change="toggleButton(menu, button.id, $event.target.checked)" /><span><b>{{ button.name }}</b><small>{{ button.id }}</small></span><em>{{ button.risk || 'low' }}</em></label>
            </div>
            <div v-else class="permission-inline-empty">该页面没有独立按钮权限。</div>
          </article>
        </div>
        <div v-else class="permission-empty"><b>权限目录为空</b><p>请先由平台配置加载页面和按钮权限目录。</p></div>
        <footer class="policy-save-bar"><label><span>变更原因（必填）</span><input v-model.trim="policyReason" :disabled="!canManage || saving" maxlength="200" placeholder="例如：质量经理新增 CAPA 审批职责" /></label><div><small>策略版本 v{{ selectedRole.version ?? workspace.version }}</small><button type="button" class="permission-primary-button" :disabled="!policyCanSave" @click="savePolicy">{{ saving ? '保存中…' : '保存角色策略' }}</button></div></footer>
      </div>
      <div v-else class="panel permission-empty"><b>暂无角色策略</b><p>角色目录为空，暂时无法配置权限。</p></div>
    </section>

    <section v-else-if="activeTab === 'data'" class="permission-workspace policy-workspace">
      <aside class="panel role-policy-list">
        <div class="permission-subhead"><div><span>ROLE DATA BOUNDARY</span><h3>选择角色</h3></div></div>
        <button v-for="item in roles" :key="item.id" type="button" :class="{ selected: selectedRoleId === item.id }" @click="selectedRoleId = item.id"><i :style="{ background: item.color || '#35d7ff' }"/><span><b>{{ item.name }}</b><small>{{ item.team }}</small></span></button>
      </aside>
      <div v-if="selectedRole" class="panel data-scope-panel">
        <div class="permission-subhead"><div><span>ORGANIZATION DATA SCOPE</span><h3>{{ selectedRole.name }} · 数据权限</h3><p>数据范围在请求时由“当前人员组织 + 角色策略”动态解析，后端仍会逐条执行行级校验。</p></div></div>
        <div class="data-scope-modes">
          <label v-for="mode in dataScopeModes" :key="mode.id" :class="{ checked: policyDraft.dataScope.mode === mode.id, danger: mode.id === 'all' }"><input type="radio" name="data-scope-mode" :value="mode.id" :checked="policyDraft.dataScope.mode === mode.id" :disabled="!canManage || saving" @change="changeDataScope(mode.id)" /><span><b>{{ mode.name }}</b><small>{{ mode.description }}</small></span><em>{{ mode.id }}</em></label>
        </div>
        <div v-if="policyDraft.dataScope.mode === 'selected_orgs'" class="scope-organization-picker">
          <div class="scope-picker-head"><div><b>指定可访问组织</b><span>勾选的组织将作为策略边界；是否包含下级组织由后台解析规则决定。</span></div><strong>{{ policyDraft.dataScope.organizationIds.length }} 个</strong></div>
          <div class="scope-tree" role="tree">
            <label v-for="organization in organizationRows" :key="organization.id" :style="{ '--tree-depth': organization.depth }" role="treeitem"><input type="checkbox" :checked="policyDraft.dataScope.organizationIds.includes(organization.id)" :disabled="!canManage || saving" @change="toggleScopeOrganization(organization.id, $event.target.checked)" /><i>{{ organization.depth ? '└' : '◆' }}</i><span><b>{{ organization.name }}</b><small>{{ organization.path || organization.code }}</small></span><em>{{ organization.memberCount ?? 0 }} 人</em></label>
          </div>
        </div>
        <div class="scope-preview">
          <span>EFFECTIVE SCOPE PREVIEW</span><h4>{{ selectedScopeMode?.name || policyDraft.dataScope.mode }}</h4>
          <p v-if="policyDraft.dataScope.mode === 'selected_orgs' && selectedScopeOrganizations.length">当前指定：{{ selectedScopeOrganizations.map((item) => item.name).join('、') }}</p>
          <p v-else-if="policyDraft.dataScope.mode === 'selected_orgs'">尚未选择组织，策略暂不可保存。</p>
          <p v-else>{{ selectedScopeMode?.description || '保存后由服务端结合当前人员组织解析实际数据边界。' }}</p>
          <small v-if="selectedRole.policy?.dataScope?.resolvedOrganizations?.length">当前生效组织：{{ selectedRole.policy.dataScope.resolvedOrganizations.map((item) => item.name || item).join('、') }}</small>
        </div>
        <footer class="policy-save-bar"><label><span>变更原因（必填）</span><input v-model.trim="policyReason" :disabled="!canManage || saving" maxlength="200" placeholder="例如：新增华东事业部区域管理职责" /></label><div><small>数据范围变更将写入审计</small><button type="button" class="permission-primary-button" :disabled="!policyCanSave" @click="savePolicy">{{ saving ? '保存中…' : '保存数据策略' }}</button></div></footer>
      </div>
      <div v-else class="panel permission-empty"><b>暂无角色策略</b><p>角色目录为空，暂时无法配置数据范围。</p></div>
    </section>

    <section v-else-if="activeTab === 'audits' && canViewAudits" class="panel permission-audit-panel">
      <div class="permission-subhead audit-heading"><div><span>IMMUTABLE CHANGE LOG</span><h3>权限变更审计</h3><p>记录人员角色、按钮授权和组织数据范围的最近变更，便于追责与配置回溯。</p></div><b>{{ audits.length }} 条最近记录</b></div>
      <div v-if="audits.length" class="permission-audit-list">
        <article v-for="(audit, index) in audits" :key="audit.id || index">
          <i :class="audit.status || audit.result || 'success'">{{ index + 1 }}</i>
          <div><header><b>{{ audit.actionName || audit.action || audit.operation || '权限策略变更' }}</b><span>{{ audit.actorName || audit.actor || audit.operator || audit.actorRoleId || '系统' }}</span></header><p>{{ audit.description || audit.detail || audit.reason || '未记录变更说明' }}</p><footer><code>{{ audit.targetName || audit.target || audit.resource || audit.targetId || audit.id }}</code><small v-if="audit.beforeVersion || audit.afterVersion || audit.before?.version || audit.after?.version">v{{ audit.beforeVersion ?? audit.before?.version ?? '—' }} → v{{ audit.afterVersion ?? audit.after?.version ?? '—' }}</small><time>{{ auditTime(audit) }}</time></footer></div>
        </article>
      </div>
      <div v-else class="permission-empty"><b>暂无权限变更记录</b><p>首次保存人员分配或角色策略后，审计记录会显示在这里。</p></div>
    </section>
  </div>
  <div v-else class="loading permission-loading">正在读取权限管理工作区…</div>
</template>
