<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLinkageStore } from '../stores/linkage'

const store = useLinkageStore()
const query = ref('')
const showOnlyEnabled = ref(false)
const batchDelay = ref(0)
const batchPriority = ref<1 | 2 | 3>(2)
const batchInterlock = ref('无')
const selectedIds = computed({
  get: () => store.selectedRuleIds,
  set: (value) => (store.selectedRuleIds = value),
})
const rows = computed(() => store.rules.filter((rule) => {
  const trigger = store.devices.find((device) => device.id === rule.triggerId)
  const action = store.devices.find((device) => device.id === rule.actionId)
  return (!showOnlyEnabled.value || rule.enabled) && (!query.value || `${rule.id}${trigger?.name}${action?.name}${rule.interlock}`.includes(query.value))
}))
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">CAUSE & EFFECT / 因果矩阵</p><h1>触发条件到动作结果</h1><p class="muted">配置延时、互锁、优先级和抑制条件；矩阵校验实时阻断矛盾规则。</p></div>
      <div class="actions">
        <v-btn variant="outlined" prepend-icon="mdi-clipboard-arrow-left-outline" :to="'/handoff'">{{ store.batch ? `本机批次 ${store.batch.changes.length} 条` : '现场批次交接' }}</v-btn>
        <v-btn variant="outlined" prepend-icon="mdi-check-all" @click="store.validations.length && $router.push('/review')">校验 {{ store.validations.length }} 项</v-btn>
        <v-btn color="primary" prepend-icon="mdi-plus" @click="store.addRule">新增规则</v-btn>
      </div>
    </div>

    <v-alert v-if="store.locked" type="warning" variant="tonal" density="compact" class="mb-3">当前基线已签字锁定，规则只读；如需修订请到版本审阅解锁。</v-alert>
    <v-alert v-else-if="!store.online" type="info" variant="tonal" density="compact" class="mb-3">本机断网中：所有改动按序号记入本机批次（打开版本 R{{ store.batch?.openedAtRevision ?? store.serverSnapshot.initialRev }}），恢复连接后到「现场批次交接」推进。</v-alert>
    <v-alert v-else-if="store.batch" type="success" variant="tonal" density="compact" class="mb-3">本机有 {{ store.batch.changes.length }} 条有序改动待交接，基线未变将整批推进、基线前进将逐条重放。</v-alert>
    <v-alert v-if="store.validations.length" type="warning" variant="tonal" density="compact" class="mb-3">
      发现 {{ store.validations.filter((item) => item.severity === '错误').length }} 个错误和 {{ store.validations.filter((item) => item.severity === '警告').length }} 个警告。跨区冲突、重复动作与互锁矛盾需要审阅确认。
    </v-alert>

    <div class="toolbar panel">
      <v-text-field v-model="query" density="compact" hide-details prepend-inner-icon="mdi-magnify" label="搜索规则或设备" style="max-width:320px" />
      <v-switch v-model="showOnlyEnabled" label="只看启用" color="primary" hide-details density="compact" />
      <v-divider vertical class="mx-3" />
      <span class="batch-label">批量编辑 {{ selectedIds.length }} 条</span>
      <v-text-field v-model.number="batchDelay" type="number" label="延时(s)" density="compact" hide-details style="max-width:92px" />
      <v-select v-model="batchPriority" :items="[1,2,3]" label="优先级" density="compact" hide-details style="max-width:100px" />
      <v-text-field v-model="batchInterlock" label="互锁" density="compact" hide-details style="max-width:160px" />
      <v-btn size="small" variant="tonal" @click="store.batchUpdate({ delay: batchDelay, priority: batchPriority, interlock: batchInterlock })">应用</v-btn>
      <v-btn size="small" variant="tonal" color="success" @click="store.toggleSelected(true)">启用</v-btn>
      <v-btn size="small" variant="tonal" color="warning" @click="store.toggleSelected(false)">停用</v-btn>
    </div>

    <div class="panel table-wrap">
      <v-data-table v-model="selectedIds" :items="rows" item-value="id" show-select density="compact" :items-per-page="12">
        <thead>
          <tr><th></th><th>规则</th><th>触发点位</th><th>动作点位</th><th>延时</th><th>互锁条件</th><th>优先级</th><th>抑制条件</th><th>启用</th><th>冲突</th></tr>
        </thead>
        <tbody>
          <tr v-for="rule in rows" :key="rule.id" :class="{ 'row-error': store.validations.some((item) => item.severity === '错误' && item.ruleIds.includes(rule.id)) }">
            <td><v-checkbox-btn :model-value="selectedIds.includes(rule.id)" @update:model-value="(value) => selectedIds = value ? [...selectedIds, rule.id] : selectedIds.filter((id) => id !== rule.id)" /></td>
            <td><strong>{{ rule.id }}</strong></td>
            <td>{{ store.devices.find((device) => device.id === rule.triggerId)?.name }}</td>
            <td>{{ store.devices.find((device) => device.id === rule.actionId)?.name }}</td>
            <td><v-text-field :model-value="rule.delay" type="number" density="compact" hide-details style="width:80px" @update:model-value="store.updateRule(rule.id, { delay: Number($event) })" /></td>
            <td><v-text-field :model-value="rule.interlock" density="compact" hide-details style="min-width:160px" @update:model-value="store.updateRule(rule.id, { interlock: String($event) })" /></td>
            <td><v-select :model-value="rule.priority" :items="[1,2,3]" density="compact" hide-details style="width:82px" @update:model-value="store.updateRule(rule.id, { priority: Number($event) as 1|2|3 })" /></td>
            <td>{{ rule.suppression }}</td>
            <td><v-switch :model-value="rule.enabled" color="primary" hide-details density="compact" @update:model-value="store.updateRule(rule.id, { enabled: Boolean($event) })" /></td>
            <td>
              <v-chip v-if="store.validations.some((item) => item.ruleIds.includes(rule.id))" size="x-small" color="error" variant="tonal">需处理</v-chip>
              <v-btn v-else icon="mdi-delete-outline" size="x-small" variant="text" @click="store.deleteRule(rule.id)" />
            </td>
          </tr>
        </tbody>
      </v-data-table>
    </div>
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; }
.toolbar { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-bottom: 12px; padding: 12px; }
.batch-label { color: #68767d; font-size: 12px; }
.table-wrap { overflow-x: auto; }
.table-wrap :deep(table) { min-width: 1280px; }
.row-error { background: #fff5f0; }
.muted { color: #849096; }
</style>
