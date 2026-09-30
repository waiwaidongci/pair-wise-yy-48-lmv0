<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLinkageStore } from '../stores/linkage'
import type { ChangeRec, Device, Rule } from '../sync/core'

const store = useLinkageStore()
const strategy = computed(() => store.strategy())
const showCurrent = ref(false)
const showHistory = ref(false)

const statusColor = {
  pending: 'default',
  applying: 'info',
  applied: 'success',
  conflict: 'error',
  dropped: 'warning',
} as const

const strategyColor = computed(() => {
  switch (strategy.value.kind) {
    case 'fast-forward':
      return 'success'
    case 'replay':
    case 'interrupted':
      return 'warning'
    case 'blocked':
    case 'lost':
      return 'error'
    case 'conflicts':
      return 'warning'
    default:
      return 'info'
  }
})

const strategyIcon = computed(() => {
  switch (strategy.value.kind) {
    case 'fast-forward':
      return 'mdi-fast-forward-outline'
    case 'replay':
      return 'mdi-replay'
    case 'interrupted':
      return 'mdi-play-pause'
    case 'blocked':
      return 'mdi-lock-alert'
    case 'lost':
      return 'mdi-flag-remove'
    case 'conflicts':
      return 'mdi-call-merge'
    case 'offline':
      return 'mdi-access-point-network-off'
    default:
      return 'mdi-information-outline'
  }
})

const pushLabel = computed(() => {
  const b = store.batch
  if (b?.status === 'pushing') return '推进中…'
  if (b?.status === 'interrupted') return '从最后完整序号续传'
  if (strategy.value.kind === 'replay') return '逐条重放推进'
  if (strategy.value.kind === 'fast-forward') return '整批快进推进'
  return '推进本机批次'
})

const conflictChanges = computed(() => store.batch?.changes.filter((c) => c.status === 'conflict') ?? [])
const pendingCount = computed(() => store.batch?.changes.filter((c) => c.status === 'pending').length ?? 0)
const appliedCount = computed(() => store.batch?.changes.filter((c) => c.status === 'applied').length ?? 0)
const pushProgress = computed(() => store.sync.pushing)
const checksumLabel = computed(() => store.checksum.slice(0, 10))

function opText(change: ChangeRec) {
  const op = change.op
  if (op.kind === 'rule-delete') return `删除规则 ${op.entityId}`
  if (op.kind === 'sign') return op.signed ? '签字锁定基线' : '解锁基线修订'
  const e = op.entity as Device | Rule
  if (op.kind === 'device-upsert') {
    const d = e as Device
    return `${d.id}：${d.name} · ${d.floor}/${d.zone} · ${d.type} · 地址 ${d.address}`
  }
  const r = e as Rule
  return `${r.id}：延时 ${r.delay}s · 优先级 ${r.priority} · ${r.enabled ? '启用' : '停用'}${r.interlock && r.interlock !== '无' ? ` · 互锁「${r.interlock}」` : ''}`
}

function theirsText(change: ChangeRec) {
  const t = change.conflict?.theirs
  if (!t) return '对侧已删除该条目'
  if ('delay' in t) {
    const r = t as Rule
    return `${r.id}：延时 ${r.delay}s · 优先级 ${r.priority} · ${r.enabled ? '启用' : '停用'} · 互锁「${r.interlock}」`
  }
  const d = t as Device
  return `${d.id}：${d.name} · ${d.floor}/${d.zone} · 地址 ${d.address}`
}

function formatTime(ts: number) {
  if (!ts) return '—'
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

const demoRuleId = ref('R-001')
const demoRulePatch = ref('{ "delay": 15, "interlock": "对侧现场确认" }')
const demoError = ref('')

async function simulateRemote() {
  demoError.value = ''
  try {
    const patch = JSON.parse(demoRulePatch.value) as Record<string, unknown>
    await store.remotePatchRule(demoRuleId.value, patch)
  } catch (error) {
    demoError.value = (error as Error).message
  }
}

async function simulateRemoteSign(signed: boolean) {
  await store.remoteSign(signed)
}

function refreshTick() {
  store.recompute()
}
</script>

<template>
  <section class="page handoff">
    <div class="page-head">
      <div>
        <p class="eyebrow">SHIFT HANDOFF / 现场批次交接</p>
        <h1>断网改动顺序记录与恢复后重放</h1>
        <p class="muted">本机按序号记下改动和打开时版本；恢复后先看基线是否前进：没变整批推进，变了按设备与规则逐条重放，双方都改过留待确认，不覆盖签字内容。</p>
      </div>
      <div class="actions">
        <v-btn variant="outlined" prepend-icon="mdi-history" @click="showHistory = true">服务器交接记录</v-btn>
        <v-btn variant="outlined" prepend-icon="mdi-restore-alert" @click="store.resetDemo()">重置演练环境</v-btn>
      </div>
    </div>

    <!-- 顶部状态条 -->
    <div class="status-grid">
      <div class="panel status-card" :class="{ offline: !store.online }">
        <v-icon :icon="store.online ? 'mdi-lan-connect' : 'mdi-lan-disconnect'" />
        <div>
          <strong>{{ store.online ? '连接正常' : '本机断网' }}</strong>
          <small>全局网络：{{ store.globalOnline ? '在线' : '全网断开' }}</small>
        </div>
        <v-switch :model-value="!store.online" color="warning" hide-details density="compact" @update:model-value="(v) => store.setLocalOffline(Boolean(v))" />
      </div>
      <div class="panel status-card">
        <v-icon icon="mdi-source-branch-sync" color="secondary" />
        <div>
          <strong>当前基线 R{{ store.serverSnapshot.rev }}</strong>
          <small>本机打开时版本 R{{ store.batch?.openedAtRevision ?? store.serverSnapshot.initialRev }}</small>
        </div>
        <v-btn size="small" variant="tonal" prepend-icon="mdi-refresh" @click="store.pullNow()">核对基线</v-btn>
      </div>
      <div class="panel status-card" :class="{ signed: store.serverSnapshot.signed }">
        <v-icon :icon="store.serverSnapshot.signed ? 'mdi-lock-check' : 'mdi-lock-open-variant'" :color="store.serverSnapshot.signed ? 'warning' : 'success'" />
        <div>
          <strong>{{ store.serverSnapshot.signed ? `基线已签字 R${store.serverSnapshot.signedRevision}` : '基线未签字' }}</strong>
          <small>{{ store.serverSnapshot.signedBy ? `${store.serverSnapshot.signedBy} · ${formatTime(store.serverSnapshot.signedAt ?? 0)}` : '推进批次不会覆盖签字内容' }}</small>
        </div>
      </div>
      <div class="panel status-card">
        <v-icon icon="mdi-account-hard-hat" color="primary" />
        <div>
          <v-text-field :model-value="store.sync.author" density="compact" hide-details variant="plain" style="max-width:150px;font-weight:700" @update:model-value="store.setAuthor(String($event))" />
          <small>{{ store.sync.clientId.slice(0, 8) }} · {{ store.sync.site }}</small>
        </div>
      </div>
    </div>

    <!-- 策略提示 -->
    <v-alert :type="strategyColor" variant="tonal" class="strategy-alert" :icon="strategyIcon">
      <div class="strategy-line">
        <strong>{{ strategy.text }}</strong>
        <span class="muted" v-if="store.batch">批次 {{ store.batch.id }} · 待推 {{ pendingCount }} · 已落库 {{ appliedCount }}{{ conflictChanges.length ? ` · 留验 ${conflictChanges.length}` : '' }}</span>
      </div>
    </v-alert>

    <div v-if="pushProgress" class="panel push-panel">
      <div class="push-head">
        <v-progress-circular indeterminate size="22" width="3" color="primary" />
        <strong>{{ pushProgress.mode === 'ff' ? '整批快进提交中' : `逐条重放中（${pushProgress.done}/${pushProgress.total}）` }}</strong>
        <v-spacer />
        <v-btn v-if="pushProgress.mode === 'replay'" size="small" color="warning" variant="tonal" prepend-icon="mdi-stop-circle-outline" @click="store.abortPush()">模拟中断（已落库条目不重复）</v-btn>
      </div>
      <v-progress-linear :model-value="pushProgress.total ? (pushProgress.done / pushProgress.total) * 100 : 100" color="primary" height="8" rounded />
    </div>

    <div class="handoff-grid">
      <!-- 左：本机批次 -->
      <section class="panel batch-panel">
        <div class="panel-head">
          <h3>本机现场批次</h3>
          <v-chip v-if="store.batch" size="small" variant="tonal" :color="store.batch.status === 'pushed' ? 'success' : store.batch.status === 'lost' || store.batch.status === 'blocked' ? 'error' : store.batch.status === 'interrupted' ? 'warning' : 'secondary'">{{ store.batchStatusLabel(store.batch) }}</v-chip>
        </div>

        <div v-if="!store.batch" class="batch-empty">
          <v-icon icon="mdi-clipboard-edit-outline" size="40" color="success" />
          <strong>暂无在途批次</strong>
          <span>到「设备与分区」「因果矩阵」改动即自动按序号记入本机批次；建议先断网再改，演练夜班场景。</span>
        </div>

        <template v-else>
          <div class="batch-meta">
            <span>批次号 <strong>{{ store.batch.id }}</strong></span>
            <span>开批 {{ formatTime(store.batch.openedAt) }}</span>
            <span>位置 {{ store.batch.site }}</span>
            <span>打开版本 <strong>R{{ store.batch.openedAtRevision }}</strong></span>
          </div>

          <!-- 落败提示 -->
          <v-alert v-if="store.batch.status === 'lost'" type="error" variant="tonal" density="compact" class="batch-alert">
            <div class="lost-line">
              <span>两个窗口同时提交，只允许一份推进。获胜方：<strong>{{ store.batch.winner?.author }}</strong> 的批次 {{ store.batch.winner?.batchId }}（R{{ store.batch.winner?.serverRevision }}）。本批原样保留，未覆盖任何内容。</span>
              <div class="lost-actions">
                <v-btn size="small" variant="tonal" prepend-icon="mdi-eye-outline" @click="showCurrent = true">查看当前版本</v-btn>
                <v-btn size="small" color="warning" variant="tonal" prepend-icon="mdi-merge" @click="store.rebaseBatch()">按当前版本重放本批</v-btn>
                <v-btn size="small" variant="text" @click="store.discardBatch()">丢弃本批</v-btn>
              </div>
            </div>
          </v-alert>

          <!-- 签字阻断 -->
          <v-alert v-if="store.batch.status === 'blocked'" type="error" variant="tonal" density="compact" class="batch-alert">
            <div class="lost-line">
              <span>基线已签字（{{ store.batch.lastError }}），整批不得覆盖签字内容；待对侧解锁后可原样继续推进。</span>
              <v-btn size="small" variant="tonal" @click="store.discardBatch()">丢弃本批</v-btn>
            </div>
          </v-alert>

          <v-alert v-if="store.batch.status === 'interrupted'" type="warning" variant="tonal" density="compact" class="batch-alert">
            合并已中断：已完成条目固化在服务器，续传时自动跳过，从最后完整序号之后继续。
          </v-alert>

          <div class="change-list">
            <article v-for="change in store.batch.changes" :key="change.seq" class="change-row" :class="change.status">
              <div class="seq">#{{ change.seq }}</div>
              <div class="change-body">
                <div class="change-title">
                  <strong>{{ opText(change) }}</strong>
                  <v-chip size="x-small" variant="tonal" :color="statusColor[change.status]">{{ store.changeStatusLabel(change) }}</v-chip>
                </div>
                <small class="muted">{{ formatTime(change.at) }} · 依据实体 v{{ change.entityRev }}<template v-if="change.detail"> · {{ change.detail }}</template><template v-if="change.parentSeq"> · 承接序号 #{{ change.parentSeq }}</template></small>

                <!-- 冲突双方对比 -->
                <div v-if="change.status === 'conflict' && change.conflict" class="conflict-box">
                  <div class="conflict-col mine">
                    <span>本机版本</span>
                    <strong>{{ change.conflict.mineSummary }}</strong>
                  </div>
                  <v-icon icon="mdi-swap-horizontal" color="error" />
                  <div class="conflict-col theirs">
                    <span>当前版本 · {{ change.conflict.theirsAuthor }} · {{ formatTime(change.conflict.theirsAt) }}</span>
                    <strong>{{ theirsText(change) }}</strong>
                  </div>
                  <div class="conflict-actions">
                    <v-btn size="small" color="primary" variant="tonal" @click="store.resolveKeepMine(change.seq)">保留本机版</v-btn>
                    <v-btn size="small" variant="outlined" @click="store.resolveKeepTheirs(change.seq)">采用当前版</v-btn>
                  </div>
                </div>
              </div>
            </article>
          </div>

          <div class="batch-actions">
            <v-spacer />
            <v-btn variant="text" :disabled="store.batch.status === 'pushing'" @click="store.discardBatch()">丢弃批次</v-btn>
            <v-btn color="primary" prepend-icon="mdi-send-check-outline" :loading="store.batch.status === 'pushing'" :disabled="!store.online || pendingCount === 0 || store.batch.status === 'lost' || store.batch.status === 'blocked'" @click="store.pushBatch()">{{ pushLabel }}</v-btn>
          </div>
        </template>
      </section>

      <!-- 右：演练台 + 活动日志 + 派生状态 -->
      <aside class="side-col">
        <section class="panel sim-panel">
          <div class="panel-head"><h3>对侧窗口 / 断网演练台</h3><span class="muted">模拟另一窗口或专业在服务器推进</span></div>
          <div class="sim-body">
            <v-switch :model-value="!store.globalOnline" label="模拟全网中断（所有窗口断网）" color="error" hide-details density="compact" @update:model-value="(v) => store.setGlobalOffline(Boolean(v))" />
            <v-divider class="my-2" />
            <div class="sim-row">
              <v-select v-model="demoRuleId" :items="store.serverSnapshot.rules.map((r) => r.id)" label="对侧修改规则" density="compact" hide-details style="max-width:140px" />
              <v-text-field v-model="demoRulePatch" label="对侧提交内容(JSON)" density="compact" hide-details />
              <v-btn size="small" color="secondary" variant="tonal" prepend-icon="mdi-account-arrow-right" :disabled="!store.globalOnline || store.serverSnapshot.signed" @click="simulateRemote">对侧推进</v-btn>
            </div>
            <v-alert v-if="demoError" type="error" density="compact" variant="text" class="mt-1">{{ demoError }}</v-alert>
            <div class="sim-row mt-2">
              <v-btn size="small" color="warning" variant="tonal" :disabled="!store.globalOnline || store.serverSnapshot.signed" @click="simulateRemoteSign(true)">对侧签字锁定</v-btn>
              <v-btn size="small" variant="outlined" :disabled="!store.globalOnline || !store.serverSnapshot.signed" @click="simulateRemoteSign(false)">对侧解锁</v-btn>
              <v-btn size="small" variant="text" icon="mdi-broom" @click="store.consoleClearClaim()"></v-btn>
              <span class="muted sim-hint">扫帚：清理超时未释放的推进占用</span>
            </div>
            <p class="sim-tip muted">推荐演练：断网 → 改 R-001 → 对侧推进同一条 → 恢复网络 → 看逐条重放与留验；或两个标签页同时提交看竞争落败。</p>
          </div>
        </section>

        <section class="panel derived-panel">
          <div class="panel-head">
            <h3>依赖图 / 校验 / 审阅状态</h3>
            <v-chip size="x-small" variant="tonal" :color="store.reviewValid && store.dependencyValid ? 'success' : 'warning'">{{ store.reviewValid && store.dependencyValid ? '已重算' : '失效重算中' }}</v-chip>
          </div>
          <div class="derived-body">
            <div><span>校验摘要</span><strong>{{ checksumLabel }}</strong></div>
            <div><span>上次重算</span><strong>{{ formatTime(store.derivedAt) }} · {{ store.derivedReason }}</strong></div>
            <div><span>校验问题</span><strong :class="{ 'text-error': store.validations.some((v) => v.severity === '错误') }">{{ store.validations.filter((v) => v.severity === '错误').length }} 错 / {{ store.validations.filter((v) => v.severity === '警告').length }} 警</strong></div>
            <v-btn size="small" variant="tonal" prepend-icon="mdi-cached" @click="refreshTick">手动重算依赖图与审阅</v-btn>
          </div>
        </section>

        <section class="panel log-panel">
          <div class="panel-head"><h3>交接活动日志</h3><span class="muted">{{ store.activity.length }} 条</span></div>
          <div class="log-list">
            <div v-for="entry in store.activity.slice(0, 14)" :key="entry.id" class="log-line" :class="entry.level">
              <v-icon :icon="{ info: 'mdi-information-outline', success: 'mdi-check-circle-outline', warning: 'mdi-alert-outline', error: 'mdi-close-octagon-outline' }[entry.level]" size="15" />
              <span>{{ entry.text }}</span>
              <small>{{ formatTime(entry.at) }}</small>
            </div>
            <div v-if="store.activity.length === 0" class="muted log-empty">暂无日志，改动或推进后在此留痕。</div>
          </div>
        </section>
      </aside>
    </div>

    <!-- 当前版本对话框（落败方查看） -->
    <v-dialog v-model="showCurrent" max-width="760">
      <v-card>
        <v-card-title>服务器当前基线 R{{ store.serverSnapshot.rev }}<v-spacer /><v-btn icon="mdi-close" variant="text" @click="showCurrent = false" /></v-card-title>
        <v-card-text>
          <v-table density="compact">
            <thead><tr><th>规则</th><th>触发</th><th>动作</th><th>延时</th><th>优先级</th><th>状态</th><th>最后修改</th></tr></thead>
            <tbody>
              <tr v-for="rule in store.serverSnapshot.rules" :key="rule.id">
                <td class="mono">{{ rule.id }}</td>
                <td>{{ rule.triggerId }}</td>
                <td>{{ rule.actionId }}</td>
                <td>{{ rule.delay }}s</td>
                <td>{{ rule.priority }}</td>
                <td>{{ rule.enabled ? '启用' : '停用' }}</td>
                <td class="muted">{{ store.serverSnapshot.meta[rule.id]?.author ?? '—' }} · v{{ store.serverSnapshot.meta[rule.id]?.rev ?? 0 }}</td>
              </tr>
            </tbody>
          </v-table>
        </v-card-text>
      </v-card>
    </v-dialog>

    <!-- 交接历史对话框 -->
    <v-dialog v-model="showHistory" max-width="720">
      <v-card>
        <v-card-title>服务器交接历史<v-spacer /><v-btn icon="mdi-close" variant="text" @click="showHistory = false" /></v-card-title>
        <v-card-text class="history-body">
          <v-timeline density="compact" align="start">
            <v-timeline-item v-for="event in [...store.history].reverse().slice(0, 24)" :key="event.id" :dot-color="event.kind === 'sign' ? 'warning' : 'primary'" size="small">
              <strong>{{ event.summary }}</strong>
              <div class="muted">{{ event.author }} · R{{ event.rev }} · {{ formatTime(event.at) }}<template v-if="event.seq"> · 序号 #{{ event.seq }}</template></div>
            </v-timeline-item>
          </v-timeline>
        </v-card-text>
      </v-card>
    </v-dialog>
  </section>
</template>

<style scoped>
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.status-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
.status-card { display: flex; align-items: center; gap: 12px; padding: 14px; }
.status-card .v-icon { font-size: 30px; color: #267078; }
.status-card.offline { border-color: #d89a3c; background: #fff9ef; }
.status-card.signed { border-color: #d89a3c; background: #fff9ef; }
.status-card strong { display: block; font-size: 13px; }
.status-card small { display: block; color: #7b878c; font-size: 10px; margin-top: 3px; }
.strategy-alert .strategy-line { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.handoff-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(320px, 1fr); gap: 14px; margin-top: 14px; align-items: start; }
.side-col { display: grid; gap: 14px; }
.batch-meta { display: flex; flex-wrap: wrap; gap: 14px; padding: 12px 16px; border-bottom: 1px solid #edf0f0; color: #5f6d73; font-size: 12px; }
.batch-meta strong { color: #26464e; }
.batch-empty { display: grid; justify-items: center; gap: 8px; padding: 48px 24px; text-align: center; color: #3d7b63; }
.batch-empty span { color: #748086; font-size: 12px; max-width: 380px; line-height: 1.7; }
.batch-alert { margin: 12px 16px 0; }
.lost-line { display: grid; gap: 8px; }
.lost-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.change-list { padding: 8px 12px; max-height: 52vh; overflow-y: auto; }
.change-row { display: grid; grid-template-columns: 46px 1fr; gap: 8px; padding: 11px 8px; border-bottom: 1px solid #f0f3f3; border-left: 3px solid transparent; }
.change-row.conflict { border-left-color: #c53b2a; background: #fff7f5; border-radius: 6px; }
.change-row.applied { opacity: .72; }
.change-row.dropped { opacity: .55; }
.seq { font-family: ui-monospace, monospace; font-weight: 800; color: #267078; padding-top: 2px; }
.change-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.change-title strong { font-size: 13px; }
.change-body small { display: block; margin-top: 4px; font-size: 10px; }
.conflict-box { display: grid; grid-template-columns: 1fr auto 1fr; gap: 10px; align-items: center; margin-top: 9px; padding: 10px; border: 1px dashed #ddb0a6; border-radius: 8px; background: white; }
.conflict-col { display: grid; gap: 4px; padding: 8px; border-radius: 6px; }
.conflict-col span { font-size: 10px; color: #8a969b; }
.conflict-col.mine { background: #eef6f4; border: 1px solid #cfe2dd; }
.conflict-col.theirs { background: #fbf2ee; border: 1px solid #e8cfc6; }
.conflict-col strong { font-size: 11px; line-height: 1.5; }
.conflict-actions { grid-column: 1 / -1; display: flex; gap: 8px; justify-content: flex-end; }
.batch-actions { display: flex; gap: 8px; align-items: center; padding: 12px 16px; border-top: 1px solid #edf0f0; }
.push-panel { margin-bottom: 14px; padding: 12px 16px; }
.push-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.sim-body, .derived-body, .log-body { padding: 12px 16px 16px; }
.sim-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sim-hint { font-size: 10px; }
.sim-tip { margin: 10px 0 0; font-size: 11px; line-height: 1.6; }
.derived-body { display: grid; gap: 10px; font-size: 12px; }
.derived-body > div { display: flex; justify-content: space-between; gap: 10px; }
.derived-body span { color: #7b878c; }
.text-error { color: #b23e2a; }
.log-list { display: grid; padding: 6px 14px 14px; max-height: 300px; overflow-y: auto; }
.log-line { display: grid; grid-template-columns: 18px 1fr auto; gap: 6px; align-items: start; padding: 6px 0; border-bottom: 1px solid #f4f6f6; font-size: 11px; line-height: 1.5; }
.log-line small { color: #9aa6ab; font-size: 9px; white-space: nowrap; }
.log-line.success { color: #2e755e; }
.log-line.warning { color: #b87b22; }
.log-line.error { color: #b13d2c; }
.log-empty { padding: 16px 0; font-size: 11px; }
.history-body { padding-top: 8px; max-height: 60vh; overflow-y: auto; }
.mono { font-family: ui-monospace, monospace; color: #267078; }
@media (max-width: 1100px) { .status-grid { grid-template-columns: 1fr 1fr; } .handoff-grid { grid-template-columns: 1fr; } }
</style>
