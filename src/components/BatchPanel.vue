<script setup lang="ts">
import { computed } from 'vue'
import { useLinkageStore, type BatchItem, type BatchStatus, type BatchItemStatus } from '../stores/linkage'

const store = useLinkageStore()

const statusMeta: Record<BatchStatus, { label: string; color: string }> = {
  recording: { label: '记录中', color: 'info' },
  submitting: { label: '合并中', color: 'warning' },
  merged: { label: '已合并', color: 'success' },
  conflict: { label: '待确认', color: 'error' },
  aborted: { label: '已落败', color: 'error' },
}

const itemMeta: Record<BatchItemStatus, { label: string; color: string; icon: string }> = {
  pending: { label: '待重放', color: 'grey', icon: 'mdi-clock-outline' },
  applied: { label: '已推进', color: 'success', icon: 'mdi-check-circle-outline' },
  conflict: { label: '冲突待确认', color: 'error', icon: 'mdi-alert-circle-outline' },
  blocked: { label: '签字阻断', color: 'warning', icon: 'mdi-lock-outline' },
}

const kindLabel: Record<BatchItem['kind'], string> = { device: '设备', rule: '规则', signature: '签字' }

const statusInfo = computed(() => statusMeta[store.batch?.status ?? 'recording'])
const progress = computed(() => store.batchProgress)
const baseRevision = computed(() => store.batch?.baseRevision ?? store.remoteRevision)
const baselineMoved = computed(() => store.remoteRevision > baseRevision.value)

function patchSummary(item: BatchItem): string {
  const entries = Object.entries(item.patch)
    .filter(([key]) => key !== 'id')
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
  return entries.join(' · ')
}
</script>

<template>
  <section class="panel batch-panel">
    <div class="panel-head">
      <h3>现场批次交接</h3>
      <v-chip size="small" :color="statusInfo.color" variant="tonal" prepend-icon="mdi-database-sync-outline">{{ statusInfo.label }}</v-chip>
    </div>

    <div class="batch-body">
      <div class="batch-top">
        <div class="conn">
          <v-chip size="small" :color="store.online ? 'success' : 'warning'" variant="tonal" :prepend-icon="store.online ? 'mdi-cloud-check-outline' : 'mdi-cloud-off-outline'">
            {{ store.online ? '在线' : '断网' }}
          </v-chip>
          <v-btn size="small" variant="outlined" @click="store.toggleOnline">{{ store.online ? '模拟断网' : '恢复连接' }}</v-btn>
        </div>
        <div class="versions">
          <span>打开时版本 <strong>R{{ baseRevision }}</strong></span>
          <v-icon icon="mdi-arrow-right" size="small" class="mx-1" />
          <span>当前基线 <strong :class="{ moved: baselineMoved }">R{{ store.remoteRevision }}</strong></span>
          <v-chip v-if="baselineMoved" size="x-small" color="warning" variant="tonal" class="ml-1">基线已前进</v-chip>
        </div>
      </div>

      <div class="batch-stats">
        <div><span>校验和</span><code>{{ store.checksum }}</code></div>
        <div><span>审阅状态</span><v-chip size="x-small" :color="store.reviewStatus === 'signed' ? 'success' : store.reviewStatus === 'ready' ? 'info' : 'warning'" variant="tonal">{{ store.reviewStatus }}</v-chip></div>
        <div><span>合并进度</span><strong>{{ progress.applied }}/{{ progress.total }}</strong></div>
      </div>

      <v-alert v-if="store.batch?.status === 'aborted' && store.batch.lastError" type="error" variant="tonal" density="compact" class="mt-3">
        另一窗口已先推进同一批次，本份落败并保留原批次。当前版本 <strong>R{{ store.batch.lastError.currentVersion }}</strong>，冲突对象 <code>{{ store.batch.lastError.conflictObject }}</code>。
      </v-alert>

      <v-alert v-if="store.batch?.status === 'conflict'" type="warning" variant="tonal" density="compact" class="mt-3">
        基线已前进，已按设备与规则逐条重放；双方都改过的内容留待确认，未覆盖签字内容。共 {{ store.pendingConflicts.length }} 项待确认。
      </v-alert>

      <div v-if="store.batch?.items.length" class="item-list">
        <div v-for="item in store.batch.items" :key="item.seq" class="batch-item" :class="item.status">
          <div class="item-head">
            <v-chip size="x-small" variant="tonal" :color="itemMeta[item.status].color" :prepend-icon="itemMeta[item.status].icon">{{ itemMeta[item.status].label }}</v-chip>
            <span class="seq">#{{ item.seq }}</span>
            <v-chip size="x-small" variant="outlined">{{ kindLabel[item.kind] }}</v-chip>
            <strong class="target">{{ item.targetId }}</strong>
            <span class="op">{{ item.op === 'delete' ? '删除' : '修改' }}</span>
          </div>
          <div class="item-patch">{{ patchSummary(item) }}</div>
          <div v-if="item.conflictFields?.length" class="item-conflict">
            双方都改过：<code v-for="field in item.conflictFields" :key="field" class="field-chip">{{ field }}</code>
            <span class="conflict-with">冲突对象 {{ item.conflictWith }}</span>
          </div>
          <div v-if="item.status === 'conflict' || item.status === 'blocked'" class="item-actions">
            <template v-if="item.status === 'conflict'">
              <v-btn size="x-small" variant="tonal" color="primary" @click="store.resolveConflict(item.seq, 'keep-local')">采用本地值</v-btn>
              <v-btn size="x-small" variant="outlined" @click="store.resolveConflict(item.seq, 'keep-remote')">采用远端值</v-btn>
            </template>
            <span v-else class="blocked-hint">签字基线已锁定，不可覆盖</span>
          </div>
        </div>
      </div>

      <div class="batch-actions">
        <v-btn size="small" color="primary" variant="tonal" prepend-icon="mdi-cloud-sync-outline" :disabled="store.batch?.status === 'submitting' || store.batch?.status === 'merged'" @click="store.submitBatch()">提交批次</v-btn>
        <v-btn size="small" variant="outlined" prepend-icon="mdi-connection" @click="store.demoAdvanceRemote()">模拟另一窗口推进基线</v-btn>
        <v-btn size="small" variant="outlined" prepend-icon="mdi-window-restore" @click="store.demoConcurrentSubmit()">模拟两窗口同时提交</v-btn>
        <v-btn size="small" variant="text" prepend-icon="mdi-delete-outline" @click="store.discardBatch()">丢弃批次</v-btn>
        <v-btn size="small" variant="text" color="error" prepend-icon="mdi-restore" @click="store.demoResetAll()">重置演示</v-btn>
      </div>
    </div>
  </section>
</template>

<style scoped>
.batch-panel { margin-bottom: 14px; }
.batch-body { padding: 14px 16px 16px; }
.batch-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.conn { display: flex; align-items: center; gap: 8px; }
.versions { display: flex; align-items: center; font-size: 12px; color: #6b787d; }
.versions strong { color: #293e45; }
.versions strong.moved { color: #bd7928; }
.batch-stats { display: flex; gap: 22px; margin-top: 12px; flex-wrap: wrap; }
.batch-stats > div { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #6b787d; }
.batch-stats code { padding: 2px 8px; border-radius: 4px; background: #eef2f2; font-size: 11px; color: #267078; }
.item-list { display: grid; gap: 8px; margin-top: 14px; }
.batch-item { padding: 10px 12px; border: 1px solid #e4e9e9; border-radius: 8px; background: #fafbfb; }
.batch-item.conflict { border-color: #f0c6bd; background: #fdf3f1; }
.batch-item.blocked { border-color: #ecd9b0; background: #fdf8ee; }
.batch-item.applied { border-color: #cfe6d8; background: #f3faf6; }
.item-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.seq { font-size: 11px; color: #9aa6aa; font-family: ui-monospace, monospace; }
.target { font-size: 13px; color: #293e45; }
.op { font-size: 11px; color: #9aa6aa; }
.item-patch { margin-top: 5px; font-size: 11px; color: #5f6c71; font-family: ui-monospace, monospace; word-break: break-all; }
.item-conflict { display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap; font-size: 11px; color: #b23e2a; }
.field-chip { padding: 1px 6px; border-radius: 4px; background: #fbe4df; color: #b23e2a; }
.conflict-with { color: #9aa6aa; }
.item-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.blocked-hint { font-size: 11px; color: #b07a1f; }
.batch-actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
</style>
