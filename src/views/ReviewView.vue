<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLinkageStore } from '../stores/linkage'

const store = useLinkageStore()
const checklist = ref([
  { done: true, title: '设备地址与竣工图一致', owner: '消防电专业' },
  { done: true, title: '所有报警点完成单点调试', owner: '调试组' },
  { done: false, title: '跨区联动完成现场确认', owner: '消防审阅人' },
  { done: false, title: '互锁反馈时长完成测试', owner: '暖通专业' },
  { done: false, title: '签字交付包完成哈希校验', owner: '项目负责人' },
])
const changes = computed(() => {
  const list: Array<{ id: string; title: string; source: string; oldValue: string; newValue: string; risk: string }> = []
  const batch = store.batch
  for (const change of batch?.changes ?? []) {
    if (change.status === 'dropped') continue
    const op = change.op
    if (op.kind === 'sign') continue
    const entity = op.kind === 'rule-delete' ? null : op.entity
    list.push({
      id: `序号 ${change.seq}`,
      title: op.kind === 'rule-delete' ? `删除规则 ${op.entityId}` : `${entity!.id} 现场改动`,
      source: `${change.author} · ${batch!.id}`,
      oldValue: `依据实体 v${change.entityRev}`,
      newValue:
        op.kind === 'rule-delete'
          ? '规则删除'
          : `延时 ${'delay' in entity! ? entity.delay : '—'}s · 优先级 ${'priority' in entity! ? entity.priority : '—'} · ${'enabled' in entity! ? (entity.enabled ? '启用' : '停用') : '台账改写'}`,
      risk: change.status === 'conflict' ? '高（双方都改过，留待确认）' : change.status === 'applied' ? '低（已落库）' : '中',
    })
  }
  return list.slice(0, 20)
})
const canLock = computed(() => store.validations.filter((item) => item.severity === '错误').length === 0 && checklist.value.every((item) => item.done))

function exportPackage() {
  const payload = JSON.stringify({ revision: store.serverSnapshot.rev, signed: store.serverSnapshot.signed, devices: store.devices, rules: store.rules, validations: store.validations, checksum: store.checksum }, null, 2)
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `消防联动交付包-R${store.serverSnapshot.rev}.json`
  link.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">REVIEW & SIGN-OFF / 审阅签字</p><h1>版本差异、联调清单与锁定</h1><p class="muted">签字与解锁同样按序号进入现场批次：未推进前只存在于本机，推进时基线若已被他人签字则整批阻断，绝不覆盖签字内容。</p></div>
      <div class="actions">
        <v-btn variant="outlined" prepend-icon="mdi-clipboard-arrow-left-outline" to="/handoff">现场批次交接</v-btn>
        <v-btn variant="outlined" prepend-icon="mdi-download" @click="exportPackage">导出交付包</v-btn>
        <v-btn v-if="!store.locked" color="primary" prepend-icon="mdi-lock-outline" :disabled="!canLock" @click="store.lockBaseline()">记录签字（待批次推进）</v-btn>
        <v-btn v-else color="warning" variant="outlined" @click="store.unlock()">记录解锁修订</v-btn>
      </div>
    </div>

    <v-alert v-if="store.serverSnapshot.signed" type="success" variant="tonal" class="mb-3">服务器基线 R{{ store.serverSnapshot.signedRevision }} 已由 {{ store.serverSnapshot.signedBy }} 签字锁定，任何推进都会被服务器拒绝。</v-alert>
    <v-alert v-else-if="store.locked" type="warning" variant="tonal" class="mb-3">本机已记录签字动作但批次尚未推进；到「现场批次交接」整批推进后基线才正式锁定。</v-alert>
    <v-alert v-if="!store.reviewValid" type="info" variant="tonal" density="compact" class="mb-3">设备、规则或签字状态刚发生变化，依赖图、校验与审阅状态已失效，正在重算…</v-alert>
    <v-alert v-if="!canLock && !store.locked" type="warning" variant="tonal" class="mb-3">签字前需清除所有错误规则并完成联调清单。</v-alert>

    <div class="review-grid">
      <section class="panel">
        <div class="panel-head"><h3>矩阵校验结果</h3><v-chip size="small" :color="store.validations.length ? 'error' : 'success'" variant="tonal">{{ store.validations.length }} 项</v-chip></div>
        <div class="validation-list">
          <article v-for="item in store.validations" :key="item.id" :class="item.severity">
            <v-icon :icon="item.severity === '错误' ? 'mdi-close-octagon-outline' : 'mdi-alert-outline'" />
            <div><strong>{{ item.title }}</strong><p>{{ item.detail }}</p><small>建议：{{ item.suggestion }}</small></div>
            <v-btn size="small" variant="text" @click="$router.push('/matrix')">定位</v-btn>
          </article>
          <div v-if="store.validations.length === 0" class="empty-validation"><v-icon icon="mdi-check-decagram" size="38" color="success" /><strong>矩阵校验通过</strong><span>未发现遗漏、重复、矛盾、悬空引用或跨区冲突。</span></div>
        </div>
      </section>

      <aside>
        <section class="panel">
          <div class="panel-head"><h3>联调清单</h3><span class="muted">{{ checklist.filter((item) => item.done).length }}/{{ checklist.length }}</span></div>
          <div class="checklist">
            <v-checkbox v-for="item in checklist" :key="item.title" v-model="item.done" :label="item.title" :hint="item.owner" persistent-hint density="compact" />
          </div>
        </section>
      </aside>
    </div>

    <section class="panel change-panel">
      <div class="panel-head"><h3>现场批次版本差异（按序号）</h3><span class="muted">摘要 {{ store.checksum.slice(0, 10) }} · {{ store.derivedReason }}</span></div>
      <v-table v-if="changes.length">
        <thead><tr><th>序号</th><th>变更</th><th>来源批次</th><th>依据版本</th><th>现场值</th><th>风险/状态</th></tr></thead>
        <tbody>
          <tr v-for="change in changes" :key="change.id">
            <td><strong>{{ change.id }}</strong></td>
            <td>{{ change.title }}</td>
            <td>{{ change.source }}</td>
            <td class="old">{{ change.oldValue }}</td>
            <td class="new">{{ change.newValue }}</td>
            <td><v-chip size="small" :color="change.risk.startsWith('高') ? 'error' : change.risk.startsWith('中') ? 'warning' : 'success'" variant="tonal">{{ change.risk }}</v-chip></td>
          </tr>
        </tbody>
      </v-table>
      <div v-else class="empty-validation"><v-icon icon="mdi-clipboard-text-outline" size="34" color="success" /><strong>当前没有在途批次差异</strong><span>在设备台账或因果矩阵中的改动会自动按序号进入现场批次。</span></div>
    </section>
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.review-grid { display: grid; grid-template-columns: minmax(0,1fr) 350px; gap: 14px; margin-bottom: 14px; }
.validation-list { padding: 8px 16px 16px; }
.validation-list article { display: grid; grid-template-columns: 28px 1fr auto; gap: 10px; padding: 13px 0; border-bottom: 1px solid #edf0f0; }
.validation-list article.error { color: #b13d2c; }
.validation-list article.warning { color: #b87b22; }
.validation-list strong { font-size: 13px; }
.validation-list p { margin: 5px 0; color: #59676d; font-size: 12px; line-height: 1.5; }
.validation-list small { color: #7f8b90; }
.empty-validation { display: grid; justify-items: center; gap: 7px; padding: 42px; color: #3d7b63; }
.empty-validation span { color: #748086; font-size: 12px; }
.checklist { padding: 10px 14px 16px; }
.change-panel { overflow-x: auto; }
.change-panel :deep(table) { min-width: 760px; }
.old { color: #a54b35; }
.new { color: #2e755e; font-weight: 700; }
@media (max-width: 1000px) { .review-grid { grid-template-columns: 1fr; } }
</style>
