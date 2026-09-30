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
const changes = [
  { id: 'CH-01', title: 'PF-2 增加防火阀开启反馈互锁', source: '暖通专业', oldValue: '互锁：无', newValue: '互锁：防火阀开启反馈', risk: '低' },
  { id: 'CH-02', title: '电梯归位延时由 0 秒调整至 10 秒', source: '电梯专业', oldValue: '延时：0s', newValue: '延时：10s', risk: '中' },
  { id: 'CH-03', title: '机房感烟联动 1F 排烟风机', source: '智能化专业', oldValue: '无关系', newValue: 'R-007 / 当前停用', risk: '高' },
]
const canLock = computed(() => store.validations.filter((item) => item.severity === '错误').length === 0 && checklist.value.every((item) => item.done))

function accept(id: string) {
  if (!store.acceptedChanges.includes(id)) store.acceptedChanges.push(id)
}

function exportPackage() {
  const payload = JSON.stringify({ revision: store.revision, devices: store.devices, rules: store.rules, validations: store.validations, acceptedChanges: store.acceptedChanges }, null, 2)
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `消防联动交付包-R${store.revision}.json`
  link.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div><p class="eyebrow">REVIEW & SIGN-OFF / 审阅签字</p><h1>版本差异、联调清单与锁定</h1><p class="muted">多个专业提交后只接受经过审阅的变更，锁定后配置成为只读基线。</p></div>
      <div class="actions"><v-btn variant="outlined" prepend-icon="mdi-download" @click="exportPackage">导出交付包</v-btn><v-btn v-if="!store.locked" color="primary" prepend-icon="mdi-lock-outline" :disabled="!canLock" @click="store.lockBaseline">签字锁定</v-btn><v-btn v-else color="warning" variant="outlined" @click="store.unlock">解锁修订</v-btn></div>
    </div>

    <v-alert v-if="!canLock && !store.locked" type="warning" variant="tonal" class="mb-3">签字前需清除所有错误规则并完成联调清单。</v-alert>
    <v-alert v-if="store.locked" type="success" variant="tonal" class="mb-3">当前版本 R{{ store.revision }} 已签字锁定，任何修改都会生成新的修订草稿。</v-alert>

    <div class="review-grid">
      <section class="panel">
        <div class="panel-head"><h3>矩阵校验结果</h3><v-chip size="small" color="error" variant="tonal">{{ store.validations.length }} 项</v-chip></div>
        <div class="validation-list">
          <article v-for="item in store.validations" :key="item.id" :class="item.severity">
            <v-icon :icon="item.severity === '错误' ? 'mdi-close-octagon-outline' : 'mdi-alert-outline'" />
            <div><strong>{{ item.title }}</strong><p>{{ item.detail }}</p><small>建议：{{ item.suggestion }}</small></div>
            <v-btn size="small" variant="text" @click="$router.push('/matrix')">定位</v-btn>
          </article>
          <div v-if="store.validations.length === 0" class="empty-validation"><v-icon icon="mdi-check-decagram" size="38" color="success" /><strong>矩阵校验通过</strong><span>未发现遗漏、重复、矛盾或跨区冲突。</span></div>
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
      <div class="panel-head"><h3>专业提交版本差异</h3><span class="muted">可逐项接受</span></div>
      <v-table>
        <thead><tr><th>变更</th><th>来源</th><th>原始值</th><th>提交值</th><th>风险</th><th>决定</th></tr></thead>
        <tbody>
          <tr v-for="change in changes" :key="change.id">
            <td><strong>{{ change.id }}</strong><br />{{ change.title }}</td>
            <td>{{ change.source }}</td>
            <td class="old">{{ change.oldValue }}</td>
            <td class="new">{{ change.newValue }}</td>
            <td><v-chip size="small" :color="change.risk === '高' ? 'error' : change.risk === '中' ? 'warning' : 'success'" variant="tonal">{{ change.risk }}</v-chip></td>
            <td><v-btn v-if="!store.acceptedChanges.includes(change.id)" size="small" color="primary" variant="tonal" @click="accept(change.id)">接受变更</v-btn><v-chip v-else color="success" variant="tonal" prepend-icon="mdi-check">已接受</v-chip></td>
          </tr>
        </tbody>
      </v-table>
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
.change-panel :deep(table) { min-width: 850px; }
.old { color: #a54b35; }
.new { color: #2e755e; font-weight: 700; }
@media (max-width: 1000px) { .review-grid { grid-template-columns: 1fr; } }
</style>
