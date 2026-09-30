import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { INITIAL_REVISION, seedDevices, seedRules, type Device, type DeviceType, type Rule, type Validation } from './seed'
import { claimAndApply, fetchRemote, resetRemote, saveRemote, simulateRemoteAdvance, syncChannel, type RemoteState } from '../api/remote'

export type { Device, DeviceType, Rule, Validation }

/** 批次条目状态：pending 待重放 / applied 已推进 / conflict 双方改过待确认 / blocked 签字保护阻断 */
export type BatchItemStatus = 'pending' | 'applied' | 'conflict' | 'blocked'
export type BatchItem = {
  seq: number
  kind: 'device' | 'rule' | 'signature'
  targetId: string
  op: 'upsert' | 'delete'
  patch: Record<string, unknown>
  baseRevision: number
  status: BatchItemStatus
  /** 双方都改过的字段（留待确认） */
  conflictFields?: string[]
  /** 冲突对象（远端实体 / 签字基线） */
  conflictWith?: string
}

export type BatchStatus = 'recording' | 'submitting' | 'merged' | 'conflict' | 'aborted'
export type OfflineBatch = {
  id: string
  /** 打开草稿时的基线版本 */
  baseRevision: number
  /** 打开时的基线快照，用于判断远端是否也改了同一处 */
  baseSnapshot: { devices: Device[]; rules: Rule[] }
  items: BatchItem[]
  lastSeq: number
  /** 最后完整序号：合并中断后从此继续，已完成条目不重复 */
  lastCompletedSeq: number
  status: BatchStatus
  createdAt: number
  mergedAt?: number
  lastError?: { reason: string; currentVersion: number; conflictObject: string }
}

// ---- 纯函数工具 ----
function clone<T>(value: T): T {
  // 用 JSON 克隆：devices/rules 是响应式代理，structuredClone 无法处理
  return JSON.parse(JSON.stringify(value)) as T
}

function changedFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const out: string[] = []
  keys.forEach((key) => {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) out.push(key)
  })
  return out
}

/** 数据校验和：设备、规则或签字状态任一变化都会失效重算。 */
function checksumOf(data: { devices: Device[]; rules: Rule[]; locked: boolean }): string {
  const str = JSON.stringify({ devices: data.devices, rules: data.rules, locked: data.locked })
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `FNV-${(hash >>> 0).toString(16).padStart(8, '0').toUpperCase()}`
}

function createBatch(remote: RemoteState): OfflineBatch {
  return {
    id: `B-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    baseRevision: remote.revision,
    baseSnapshot: { devices: clone(remote.devices), rules: clone(remote.rules) },
    items: [],
    lastSeq: 0,
    lastCompletedSeq: 0,
    status: 'recording',
    createdAt: Date.now(),
  }
}

function restoreBatch(restored: any, initialRevision: number): OfflineBatch | null {
  if (!restored || !restored.batch) return null
  const batch = restored.batch as OfflineBatch
  if (typeof batch.baseRevision !== 'number' || !Number.isFinite(batch.baseRevision)) batch.baseRevision = initialRevision
  if (typeof batch.lastCompletedSeq !== 'number') batch.lastCompletedSeq = 0
  if (typeof batch.lastSeq !== 'number') batch.lastSeq = Array.isArray(batch.items) ? batch.items.length : 0
  if (!Array.isArray(batch.items)) batch.items = []
  if (!batch.baseSnapshot) batch.baseSnapshot = { devices: clone(seedDevices), rules: clone(seedRules) }
  return batch
}

/**
 * 合并计算：基线没变整批推进；基线前进则按设备与规则逐条重放。
 * 双方都改过的字段留待确认（不覆盖），签字基线一律阻断。
 * 会就地标记 batch.items 的状态（applied / conflict / blocked）。
 */
function computeMerged(
  local: { devices: Device[]; rules: Rule[]; locked: boolean },
  remote: RemoteState,
  batch: OfflineBatch,
): { devices: Device[]; rules: Rule[]; locked: boolean; anyConflict: boolean; anyBlocked: boolean; fastPath: boolean } {
  const fastPath = remote.revision === batch.baseRevision
  if (fastPath) {
    batch.items.forEach((item) => { item.status = 'applied' })
    batch.lastCompletedSeq = batch.items.length ? Math.max(...batch.items.map((item) => item.seq)) : 0
    return { devices: clone(local.devices), rules: clone(local.rules), locked: local.locked, anyConflict: false, anyBlocked: false, fastPath: true }
  }

  const mergedDevices = clone(remote.devices)
  const mergedRules = clone(remote.rules)
  let mergedLocked = remote.locked
  let anyConflict = false
  let anyBlocked = false

  const baseDevices = batch.baseSnapshot.devices
  const baseRules = batch.baseSnapshot.rules
  const baseRuleById = new Map(baseRules.map((rule) => [rule.id, rule]))
  const baseDeviceById = new Map(baseDevices.map((device) => [device.id, device]))

  for (const item of batch.items) {
    if (item.status === 'applied') continue
    if (item.seq <= batch.lastCompletedSeq) continue

    if (item.kind === 'signature') {
      if (item.patch.locked === false && remote.locked) {
        // 已签字基线不允许本地解锁
        item.status = 'blocked'
        item.conflictWith = 'signed-baseline'
        anyBlocked = true
      } else {
        mergedLocked = Boolean(item.patch.locked)
        item.status = 'applied'
      }
      batch.lastCompletedSeq = item.seq
      continue
    }

    // 签字保护：基线已锁定时，实体改动一律阻断，不能覆盖签字内容
    if (remote.locked) {
      item.status = 'blocked'
      item.conflictWith = 'signed-baseline'
      anyBlocked = true
      batch.lastCompletedSeq = item.seq
      continue
    }

    if (item.kind === 'rule') {
      const baseRule = baseRuleById.get(item.targetId)
      const index = mergedRules.findIndex((rule) => rule.id === item.targetId)
      const remoteRule = index >= 0 ? mergedRules[index] : undefined

      if (item.op === 'delete') {
        if (!baseRule || !remoteRule) { item.status = 'applied'; batch.lastCompletedSeq = item.seq; continue }
        const remoteFields = changedFields(remoteRule as Record<string, unknown>, baseRule as Record<string, unknown>)
        if (remoteFields.length) {
          item.status = 'conflict'
          item.conflictFields = remoteFields
          item.conflictWith = `remote:${item.targetId}`
          anyConflict = true
        } else {
          mergedRules.splice(index, 1)
          item.status = 'applied'
        }
        batch.lastCompletedSeq = item.seq
        continue
      }

      if (!baseRule) {
        if (remoteRule) {
          item.status = 'conflict'
          item.conflictWith = `remote-created:${item.targetId}`
          anyConflict = true
        } else {
          mergedRules.push(clone(item.patch) as Rule)
          item.status = 'applied'
        }
        batch.lastCompletedSeq = item.seq
        continue
      }
      if (!remoteRule) {
        item.status = 'conflict'
        item.conflictWith = `remote-deleted:${item.targetId}`
        anyConflict = true
        batch.lastCompletedSeq = item.seq
        continue
      }

      const remoteFields = changedFields(remoteRule as Record<string, unknown>, baseRule as Record<string, unknown>)
      const localFields = Object.keys(item.patch)
      const both = localFields.filter((field) => remoteFields.includes(field))
      if (both.length) {
        item.status = 'conflict'
        item.conflictFields = both
        item.conflictWith = `remote:${item.targetId}`
        anyConflict = true
        // 仅推进双方未改动的字段，冲突字段留待确认
        const safe = { ...item.patch }
        both.forEach((field) => delete (safe as Record<string, unknown>)[field])
        Object.assign(remoteRule, safe)
      } else {
        Object.assign(remoteRule, item.patch)
        item.status = 'applied'
      }
      batch.lastCompletedSeq = item.seq
      continue
    }

    if (item.kind === 'device') {
      const baseDevice = baseDeviceById.get(item.targetId)
      const index = mergedDevices.findIndex((device) => device.id === item.targetId)
      const remoteDevice = index >= 0 ? mergedDevices[index] : undefined

      if (item.op === 'delete') {
        if (!baseDevice || !remoteDevice) { item.status = 'applied'; batch.lastCompletedSeq = item.seq; continue }
        const remoteFields = changedFields(remoteDevice as Record<string, unknown>, baseDevice as Record<string, unknown>)
        if (remoteFields.length) {
          item.status = 'conflict'
          item.conflictFields = remoteFields
          item.conflictWith = `remote:${item.targetId}`
          anyConflict = true
        } else {
          mergedDevices.splice(index, 1)
          item.status = 'applied'
        }
        batch.lastCompletedSeq = item.seq
        continue
      }

      if (!baseDevice) {
        if (remoteDevice) {
          item.status = 'conflict'
          item.conflictWith = `remote-created:${item.targetId}`
          anyConflict = true
        } else {
          mergedDevices.push(clone(item.patch) as Device)
          item.status = 'applied'
        }
        batch.lastCompletedSeq = item.seq
        continue
      }
      if (!remoteDevice) {
        item.status = 'conflict'
        item.conflictWith = `remote-deleted:${item.targetId}`
        anyConflict = true
        batch.lastCompletedSeq = item.seq
        continue
      }

      const remoteFields = changedFields(remoteDevice as Record<string, unknown>, baseDevice as Record<string, unknown>)
      const localFields = Object.keys(item.patch)
      const both = localFields.filter((field) => remoteFields.includes(field))
      if (both.length) {
        item.status = 'conflict'
        item.conflictFields = both
        item.conflictWith = `remote:${item.targetId}`
        anyConflict = true
        const safe = { ...item.patch }
        both.forEach((field) => delete (safe as Record<string, unknown>)[field])
        Object.assign(remoteDevice, safe)
      } else {
        Object.assign(remoteDevice, item.patch)
        item.status = 'applied'
      }
      batch.lastCompletedSeq = item.seq
      continue
    }
  }

  return { devices: mergedDevices, rules: mergedRules, locked: mergedLocked, anyConflict, anyBlocked, fastPath: false }
}

/** 合并成功后协调本地：冲突字段保留本地值留待确认，阻断字段回退远端值。 */
function reconcileLocal(
  localSnapshot: { devices: Device[]; rules: Rule[]; locked: boolean },
  merged: { devices: Device[]; rules: Rule[]; locked: boolean },
  remote: RemoteState,
  batch: OfflineBatch,
  setLocal: (devices: Device[], rules: Rule[], locked: boolean) => void,
) {
  const nextDevices = clone(merged.devices)
  const nextRules = clone(merged.rules)
  let nextLocked = merged.locked

  for (const item of batch.items) {
    if (item.kind === 'signature') {
      if (item.status === 'blocked') nextLocked = remote.locked
      continue
    }
    if (item.status === 'conflict' && item.conflictFields?.length) {
      if (item.kind === 'rule') {
        const snap = localSnapshot.rules.find((rule) => rule.id === item.targetId)
        const target = nextRules.find((rule) => rule.id === item.targetId)
        if (snap && target) item.conflictFields.forEach((field) => { (target as Record<string, unknown>)[field] = (snap as Record<string, unknown>)[field] })
      } else if (item.kind === 'device') {
        const snap = localSnapshot.devices.find((device) => device.id === item.targetId)
        const target = nextDevices.find((device) => device.id === item.targetId)
        if (snap && target) item.conflictFields.forEach((field) => { (target as Record<string, unknown>)[field] = (snap as Record<string, unknown>)[field] })
      }
    } else if (item.status === 'blocked') {
      if (item.kind === 'rule') {
        const remoteTarget = remote.rules.find((rule) => rule.id === item.targetId)
        const target = nextRules.find((rule) => rule.id === item.targetId)
        if (remoteTarget && target) Object.keys(item.patch).forEach((field) => { (target as Record<string, unknown>)[field] = (remoteTarget as Record<string, unknown>)[field] })
      } else if (item.kind === 'device') {
        const remoteTarget = remote.devices.find((device) => device.id === item.targetId)
        const target = nextDevices.find((device) => device.id === item.targetId)
        if (remoteTarget && target) Object.keys(item.patch).forEach((field) => { (target as Record<string, unknown>)[field] = (remoteTarget as Record<string, unknown>)[field] })
      }
    }
  }

  setLocal(nextDevices, nextRules, nextLocked)
}

export const useLinkageStore = defineStore('linkage', () => {
  const saved = localStorage.getItem('fire-linkage-draft-v1')
  const restored = saved ? JSON.parse(saved) : null
  // 旧草稿缺版本：补齐首版后照常打开
  const initialRevision = typeof restored?.revision === 'number' && Number.isFinite(restored.revision) ? restored.revision : INITIAL_REVISION

  const devices = ref<Device[]>(restored?.devices ?? clone(seedDevices))
  const rules = ref<Rule[]>(restored?.rules ?? clone(seedRules))
  const revision = ref(initialRevision)
  const locked = ref(restored?.locked ?? false)
  const acceptedChanges = ref<string[]>(restored?.acceptedChanges ?? ['CH-01'])
  const selectedRuleIds = ref<string[]>([])

  const online = ref(typeof navigator !== 'undefined' ? navigator.onLine : true)
  const remoteRevision = ref(fetchRemote().revision)
  const recomputeToken = ref(0)
  const batch = ref<OfflineBatch | null>(restoreBatch(restored, initialRevision) ?? createBatch(fetchRemote()))

  function persist() {
    localStorage.setItem('fire-linkage-draft-v1', JSON.stringify({
      devices: devices.value,
      rules: rules.value,
      revision: revision.value,
      locked: locked.value,
      acceptedChanges: acceptedChanges.value,
      batch: batch.value,
    }))
  }

  // 设备、规则或签字状态变化时，依赖图、校验和审阅状态一起失效重算
  watch([devices, rules, revision, locked, acceptedChanges], () => {
    recomputeToken.value += 1
    persist()
  }, { deep: true })

  watch(batch, () => persist(), { deep: true })

  /** 按顺序记下改动和打开时版本。 */
  function record(kind: 'device' | 'rule' | 'signature', targetId: string, patch: Record<string, unknown>, op: 'upsert' | 'delete' = 'upsert') {
    const current = batch.value
    if (!current || current.status !== 'recording') return
    const seq = current.lastSeq + 1
    current.lastSeq = seq
    current.items.push({ seq, kind, targetId, op, patch, baseRevision: current.baseRevision, status: 'pending' })
  }

  // ---- 校验 / 校验和 / 审阅状态（同一失效令牌，一起重算）----
  const validations = computed<Validation[]>(() => {
    void recomputeToken.value
    const result: Validation[] = []
    const triggers = devices.value.filter((device) => ['感烟探测器', '感温探测器', '手动报警按钮', '输入模块'].includes(device.type))
    for (const trigger of triggers) {
      const enabled = rules.value.filter((rule) => rule.triggerId === trigger.id && rule.enabled)
      if (enabled.length === 0) {
        result.push({ id: `missing-${trigger.id}`, severity: '错误', ruleIds: [], title: `${trigger.name} 缺少联动动作`, detail: '报警点未配置任何启用的因果规则。', suggestion: '至少配置广播、排烟或疏散相关动作。' })
      }
      const actionCount = new Map<string, number>()
      enabled.forEach((rule) => actionCount.set(rule.actionId, (actionCount.get(rule.actionId) ?? 0) + 1))
      actionCount.forEach((count, actionId) => {
        if (count > 1) result.push({ id: `duplicate-${trigger.id}-${actionId}`, severity: '警告', ruleIds: enabled.filter((rule) => rule.actionId === actionId).map((rule) => rule.id), title: `${trigger.name} 存在重复动作`, detail: `同一个动作 ${actionId} 被重复配置 ${count} 次。`, suggestion: '合并规则或明确主备关系。' })
      })
    }
    rules.value.filter((rule) => rule.enabled).forEach((rule) => {
      const trigger = devices.value.find((device) => device.id === rule.triggerId)
      const action = devices.value.find((device) => device.id === rule.actionId)
      if (trigger && action && trigger.zone !== action.zone && rule.suppression === '无') {
        result.push({ id: `cross-${rule.id}`, severity: '警告', ruleIds: [rule.id], title: `${rule.id} 跨区联动未配置抑制`, detail: `${trigger.zone} 报警将直接触发 ${action.zone} 动作。`, suggestion: '确认疏散边界并增加分区确认或抑制条件。' })
      }
      if (rule.interlock && rule.delay > 5 && rule.priority === 1) {
        result.push({ id: `contradiction-${rule.id}`, severity: '错误', ruleIds: [rule.id], title: `${rule.id} 互锁与高优先级延时冲突`, detail: '一级优先规则在互锁未明确反馈前延时超过 5 秒。', suggestion: '缩短延时或改为反馈后触发。' })
      }
    })
    return result
  })

  const checksum = computed(() => {
    void recomputeToken.value
    return checksumOf({ devices: devices.value, rules: rules.value, locked: locked.value })
  })

  const reviewStatus = computed<'draft' | 'pending' | 'ready' | 'signed'>(() => {
    void recomputeToken.value
    if (locked.value) return 'signed'
    const errors = validations.value.filter((item) => item.severity === '错误').length
    return errors === 0 ? 'ready' : 'pending'
  })

  const pendingConflicts = computed(() => {
    const current = batch.value
    if (!current) return []
    return current.items.filter((item) => item.status === 'conflict' || item.status === 'blocked')
  })

  const batchProgress = computed(() => {
    const current = batch.value
    if (!current || current.items.length === 0) return { applied: 0, total: 0 }
    const applied = current.items.filter((item) => item.status === 'applied').length
    return { applied, total: current.items.length }
  })

  // ---- 变更动作（同步记入批次）----
  function updateRule(id: string, patch: Partial<Rule>) {
    if (locked.value) return
    const rule = rules.value.find((item) => item.id === id)
    if (rule) {
      Object.assign(rule, patch)
      record('rule', id, { ...patch })
    }
  }

  function addRule() {
    if (locked.value) return
    const rule: Rule = {
      id: `R-${String(rules.value.length + 1).padStart(3, '0')}`,
      triggerId: devices.value[0]?.id ?? '',
      actionId: devices.value.at(-1)?.id ?? '',
      delay: 0,
      interlock: '无',
      priority: 2,
      suppression: '无',
      enabled: true,
    }
    rules.value.push(rule)
    record('rule', rule.id, { ...rule })
    revision.value += 1
  }

  function batchUpdate(patch: Partial<Rule>) {
    if (locked.value) return
    rules.value = rules.value.map((rule) => (selectedRuleIds.value.includes(rule.id) ? { ...rule, ...patch } : rule))
    selectedRuleIds.value.forEach((id) => record('rule', id, { ...patch }))
  }

  function toggleSelected(enabled: boolean) {
    batchUpdate({ enabled })
  }

  function addDevice(device: Device) {
    if (locked.value) return
    devices.value.push({ ...device })
    record('device', device.id, { ...device })
  }

  function removeDevice(id: string) {
    if (locked.value) return
    devices.value = devices.value.filter((device) => device.id !== id)
    record('device', id, { id }, 'delete')
  }

  function lockBaseline() {
    locked.value = true
    record('signature', 'baseline', { locked: true })
    revision.value += 1
  }

  function unlock() {
    locked.value = false
    record('signature', 'baseline', { locked: false })
  }

  // ---- 批次提交 / 合并 ----
  function submitBatch(): { ok: boolean; reason?: string; currentVersion?: number; conflictObject?: string } {
    const current = batch.value
    if (!current) return { ok: false }
    current.status = 'submitting'
    persist()

    const remote = fetchRemote()
    remoteRevision.value = remote.revision
    const localSnapshot = { devices: clone(devices.value), rules: clone(rules.value), locked: locked.value }

    // 上次已推进但中断在 claim 之后：直接从远端同步，不重复认领
    if (remote.appliedBatchIds.includes(current.id)) {
      const merged = computeMerged(localSnapshot, remote, current)
      reconcileLocal(localSnapshot, merged, remote, current, (d, r, l) => { devices.value = d; rules.value = r; locked.value = l })
      remoteRevision.value = remote.revision
      revision.value = remote.revision
      current.status = merged.anyConflict || merged.anyBlocked ? 'conflict' : 'merged'
      persist()
      if (!merged.anyConflict && !merged.anyBlocked) {
        batch.value = createBatch(remote)
        persist()
      }
      return { ok: true }
    }

    const merged = computeMerged(localSnapshot, remote, current)
    const claim = claimAndApply(current.id, { devices: merged.devices, rules: merged.rules, locked: merged.locked })
    if (!claim.ok) {
      // 落败方：保留原批次，看到当前版本和冲突对象
      current.status = 'aborted'
      current.lastError = { reason: claim.reason, currentVersion: claim.currentVersion, conflictObject: claim.conflictObject }
      remoteRevision.value = claim.currentVersion
      persist()
      return { ok: false, reason: claim.reason, currentVersion: claim.currentVersion, conflictObject: claim.conflictObject }
    }

    reconcileLocal(localSnapshot, merged, claim.remote, current, (d, r, l) => { devices.value = d; rules.value = r; locked.value = l })
    remoteRevision.value = claim.remote.revision
    revision.value = claim.remote.revision
    current.status = merged.anyConflict || merged.anyBlocked ? 'conflict' : 'merged'
    current.mergedAt = Date.now()
    persist()

    if (!merged.anyConflict && !merged.anyBlocked) {
      // 整批推进完成，开启新批次（基线已前进到当前版本）
      batch.value = createBatch(claim.remote)
      persist()
    }
    return { ok: true }
  }

  /** 合并中断后从最后完整序号继续，已完成条目不重复。 */
  function resumeMerge() {
    const current = batch.value
    if (!current) return
    if (current.status === 'submitting') {
      void submitBatch()
      return
    }
    if (current.status === 'recording' && current.items.some((item) => item.status === 'pending')) {
      void submitBatch()
    }
  }

  function reconnect() {
    online.value = true
    const current = batch.value
    if (current && current.status === 'recording' && current.items.length > 0) {
      void submitBatch()
    }
  }

  function goOffline() {
    online.value = false
    if (!batch.value || batch.value.status !== 'recording') {
      batch.value = createBatch(fetchRemote())
      persist()
    }
  }

  function toggleOnline() {
    if (online.value) goOffline()
    else reconnect()
  }

  function discardBatch() {
    const remote = fetchRemote()
    batch.value = createBatch(remote)
    remoteRevision.value = remote.revision
    persist()
  }

  /** 冲突解决：keep-local 强制采用本地值；keep-remote 回退远端值。 */
  function resolveConflict(seq: number, choice: 'keep-local' | 'keep-remote') {
    const current = batch.value
    if (!current) return
    const item = current.items.find((entry) => entry.seq === seq)
    if (!item || item.status !== 'conflict') return
    const remote = fetchRemote()
    const fields = item.conflictFields?.length ? item.conflictFields : Object.keys(item.patch)

    if (choice === 'keep-local') {
      if (item.kind === 'rule') {
        const target = remote.rules.find((rule) => rule.id === item.targetId)
        if (target) fields.forEach((field) => { (target as Record<string, unknown>)[field] = (item.patch as Record<string, unknown>)[field] })
      } else if (item.kind === 'device') {
        const target = remote.devices.find((device) => device.id === item.targetId)
        if (target) fields.forEach((field) => { (target as Record<string, unknown>)[field] = (item.patch as Record<string, unknown>)[field] })
      }
    } else {
      if (item.kind === 'rule') {
        const remoteTarget = remote.rules.find((rule) => rule.id === item.targetId)
        const localTarget = rules.value.find((rule) => rule.id === item.targetId)
        if (remoteTarget && localTarget) fields.forEach((field) => { (localTarget as Record<string, unknown>)[field] = (remoteTarget as Record<string, unknown>)[field] })
      } else if (item.kind === 'device') {
        const remoteTarget = remote.devices.find((device) => device.id === item.targetId)
        const localTarget = devices.value.find((device) => device.id === item.targetId)
        if (remoteTarget && localTarget) fields.forEach((field) => { (localTarget as Record<string, unknown>)[field] = (remoteTarget as Record<string, unknown>)[field] })
      }
    }

    item.status = 'applied'
    const stillPending = current.items.some((entry) => entry.status === 'conflict' || entry.status === 'blocked')
    saveRemote(remote)
    remoteRevision.value = remote.revision
    revision.value = remote.revision

    if (!stillPending) {
      current.status = 'merged'
      batch.value = createBatch(remote)
    }
    persist()
  }

  /** 演示：模拟另一窗口推进了基线。 */
  function demoAdvanceRemote() {
    const remote = simulateRemoteAdvance()
    remoteRevision.value = remote.revision
  }

  /** 演示：两个窗口同时提交同一批 —— 只允许一份推进，落败方保留原批次并看到当前版本和冲突对象。 */
  async function demoConcurrentSubmit() {
    const current = batch.value
    if (!current) return
    current.status = 'submitting'
    persist()
    const remote = fetchRemote()
    const localSnapshot = { devices: clone(devices.value), rules: clone(rules.value), locked: locked.value }
    // 用副本做合并计算，避免落败方的原批次条目状态被提前改写
    const batchForMerge = clone(current)
    const merged = computeMerged(localSnapshot, remote, batchForMerge)
    const [first, second] = await Promise.all([
      new Promise<ReturnType<typeof claimAndApply>>((resolve) => setTimeout(() => resolve(claimAndApply(current.id, { devices: merged.devices, rules: merged.rules, locked: merged.locked })), 12)),
      new Promise<ReturnType<typeof claimAndApply>>((resolve) => setTimeout(() => resolve(claimAndApply(current.id, { devices: merged.devices, rules: merged.rules, locked: merged.locked })), 12)),
    ])
    const winner = first.ok ? first : second
    const loser = first.ok ? second : first
    if (winner.ok) {
      current.items = batchForMerge.items
      current.lastCompletedSeq = batchForMerge.lastCompletedSeq
      reconcileLocal(localSnapshot, merged, winner.remote, current, (d, r, l) => { devices.value = d; rules.value = r; locked.value = l })
      remoteRevision.value = winner.remote.revision
      revision.value = winner.remote.revision
      current.status = merged.anyConflict || merged.anyBlocked ? 'conflict' : 'merged'
      if (!merged.anyConflict && !merged.anyBlocked) batch.value = createBatch(winner.remote)
    }
    if (!loser.ok) {
      current.status = 'aborted'
      current.lastError = { reason: loser.reason, currentVersion: loser.currentVersion, conflictObject: loser.conflictObject }
      remoteRevision.value = loser.currentVersion
    }
    persist()
  }

  function demoResetAll() {
    localStorage.removeItem('fire-linkage-draft-v1')
    const remote = resetRemote()
    devices.value = clone(seedDevices)
    rules.value = clone(seedRules)
    revision.value = INITIAL_REVISION
    locked.value = false
    acceptedChanges.value = ['CH-01']
    selectedRuleIds.value = []
    batch.value = createBatch(remote)
    remoteRevision.value = remote.revision
    online.value = true
    persist()
  }

  // ---- 连接状态监听 ----
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => reconnect())
    window.addEventListener('offline', () => goOffline())
    syncChannel.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; revision?: number }
      if (data?.type === 'remote-updated' && typeof data.revision === 'number') {
        remoteRevision.value = data.revision
      }
    }
  }

  // 启动时：若上次合并中断，从最后完整序号继续；恢复连接后自动提交
  const initialBatch = batch.value
  if (initialBatch) {
    if (initialBatch.status === 'submitting') {
      resumeMerge()
    } else if (initialBatch.status === 'recording' && online.value && initialBatch.items.length > 0) {
      void submitBatch()
    }
  }

  return {
    devices, rules, revision, locked, acceptedChanges, selectedRuleIds,
    online, remoteRevision, batch, recomputeToken,
    validations, checksum, reviewStatus, pendingConflicts, batchProgress,
    updateRule, addRule, batchUpdate, toggleSelected, addDevice, removeDevice,
    lockBaseline, unlock,
    submitBatch, resumeMerge, reconnect, goOffline, toggleOnline, discardBatch,
    resolveConflict, demoAdvanceRemote, demoConcurrentSubmit, demoResetAll,
  }
})
