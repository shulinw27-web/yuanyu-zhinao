<script setup>
defineProps({ accountCenter: Object, permissionCenter: Object, role: String });
</script>

<template>
  <section class="account-permission-center panel">
    <div class="section-header"><div><span class="eyebrow">IDENTITY & ACCESS GOVERNANCE</span><h2>账号中心与权限中心</h2><p>账号中心负责“谁在使用平台”，权限中心负责“用户、智脑分别能访问和发起什么”。OA 只是可选身份源。</p></div><b>{{ role === 'executive' ? '管理员视图' : '我的授权视图' }}</b></div>

    <div class="identity-source-grid"><article v-for="source in accountCenter?.identitySources || []" :key="source.id"><span>{{ source.type }}</span><h3>{{ source.name }}</h3><p>{{ source.description }}</p><b :class="source.status">{{ source.status }}</b></article></div>

    <div v-if="accountCenter?.users?.length" class="account-list"><div class="config-subhead"><span>PLATFORM ACCOUNTS</span><b>平台账号与身份绑定</b></div><div class="account-table"><div class="account-row head"><span>账号</span><span>组织 / 部门</span><span>业务角色</span><span>身份源</span><span>状态</span></div><div v-for="user in accountCenter.users" :key="user.id" class="account-row"><b>{{ user.account }}<small>{{ user.name }}</small></b><span>{{ user.department }}</span><span>{{ user.role }}</span><span>{{ user.sources.join(' · ') }}</span><em>{{ user.status }}</em></div></div></div>

    <div class="permission-flow"><span v-for="(step, index) in permissionCenter?.evaluationOrder || []" :key="step"><b>{{ index + 1 }}</b>{{ step }}</span></div>
    <p class="permission-audit">{{ permissionCenter?.auditRule }}</p>

    <div class="permission-role-grid"><article v-for="policy in permissionCenter?.rolePolicies || []" :key="policy.role.id"><div><span>{{ policy.role.team }}</span><h3>{{ policy.role.name }}</h3></div><p><b>页面：</b>{{ policy.menus.join('、') }}</p><p><b>数据：</b>{{ policy.data.fields }}</p><p><b>限制：</b>{{ policy.data.restrict }}</p><p><b>业务能力：</b>{{ policy.business.grants.map((grant) => grant.name).join('、') || '无' }}</p><p><b>智脑数据域：</b>{{ policy.zhiNao.allowedDomains.map((domain) => domain.name).join('、') || '无' }}</p></article></div>
  </section>
</template>
