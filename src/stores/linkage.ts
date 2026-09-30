import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { getBrowserHost } from '../sync/host'
import {
  bootstrapClient,
  FieldServer,
  SyncClient,
  type Batch,
  type ChangeRec,
  type Device,
  type DeviceType,
  type HistoryEvent,
  type Rule,
} from '../sync/core'

export type { Device, DeviceType, Rule }
export type Validation = { id: string; severity: '错误' | '警告'; ruleIds: string[]; title: string; detail: string; suggestion: string }

const TRIGGER_TYPES: DeviceType[] = ['感烟探测器', '感温探测器', '手动报警按钮', '输入模块']
const ACTION_TYPES: DeviceType[] = ['排烟风机', '防火卷帘', '消防广播', '电梯', '输出模块']

let host: ReturnType<typeof getBrowserHost> | null = null
let server: FieldServer | null = null

export const useLinkageStore = defineStore('linkage', () => {
  if (!host) host = getBrowserHost()
  if (!server) server = new FieldServer(host)
  const { client } = bootstrapClient(
    host,
    server,
    () => `夜班调试员-${Math.floor(10 + Math.random() * 89)}`,
    () => '现场窗口',
  )
  client.start()

  // 内核状态用 reactive 包裹；异步动作完成后 bump 触发计算属性刷新
  const sync = reactive(client.state)
  const bump = ref(0)
  function touch() {
    bump.value += 1
  }
  const raw = client

  // ---------- 派生失效：设备、规则或签字状态变化时，依赖图/校验/审阅一起失效重算 ----------
  const derivedStamp = ref(0)
  const derivedAt = ref(Date.now())
  const derivedReason = ref<'初始计算' | '设备变化' | '规则变化' | '签字状态变化'>('初始计算')
  const reviewValid = ref(false)
  const dependencyValid = ref(false)
  const checksum = ref('')

  function invalidate(reason: '设备变化' | '规则变化' | '签字状态变化') {
    reviewValid.value = false
    dependencyValid.value = false
    derivedReason.value = reason
    // 下一帧重算，保留短暂“失效重算中”的可观察窗口
    window.setTimeout(() => recompute(), 60)
  }

  function djb2(text: string) {
    let hash = 5381
    for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
    return hash.toString(16).padStart(8, '0')
  }

  function recompute() {
    checksum.value = djb2(JSON.stringify({ d: sync.working.devices, r: sync.working.rules, s: sync.working.signed }))
    derivedStamp.value += 1
    derivedAt.value = Date.now()
    reviewValid.value = true
    dependencyValid.value = true
    touch()
  }

  // 外部（另一窗口/另一专业）推进：无在途批次时内核会镜像工作区，随后同样失效重算
  function noteExternalChange() {
    touch()
    window.setTimeout(() => {
      if (raw.state.batch === null) {
        const signedChanged = raw.state.working.signed !== server!.snapshot().signed
        invalidate(signedChanged ? '签字状态变化' : '规则变化')
      } else {
        touch()
      }
    }, 240)
  }
  host.onBroadcast((message) => {
    if (message.type === 'server') noteExternalChange()
    else touch()
  })

  // 对工作区的结构化变更统一走这里，保证失效语义不遗漏
  function mutateWorking(reason: '设备变化' | '规则变化' | '签字状态变化') {
    invalidate(reason)
    raw.persist()
    touch()
  }

  // ---------- 基础只读视图 ----------

  const devices = computed<Device[]>(() => {
    void bump.value
    return sync.working.devices
  })
  const rules = computed<Rule[]>(() => {
    void bump.value
    return sync.working.rules
  })
  const revision = computed(() => {
    void bump.value
    return sync.knownRev
  })
  const locked = computed(() => {
    void bump.value
    return sync.working.signed
  })
  const online = computed(() => {
    void bump.value
    return raw.isOnline()
  })
  const globalOnline = computed(() => server!.isGlobalOnline())
  const batch = computed<Batch | null>(() => {
    void bump.value
    return sync.batch
  })
  const activity = computed(() => {
    void bump.value
    return sync.activity
  })
  const selectedRuleIds = ref<string[]>([])

  const serverSnapshot = computed(() => {
    void bump.value
    return server!.snapshot()
  })

  // ---------- 矩阵校验（随派生失效重算） ----------

  const validations = computed<Validation[]>(() => {
    void derivedStamp.value
    void bump.value
    const result: Validation[] = []
    const currentDevices = sync.working.devices
    const currentRules = sync.working.rules
    const triggers = currentDevices.filter((device) => TRIGGER_TYPES.includes(device.type))
    for (const trigger of triggers) {
      const enabled = currentRules.filter((rule) => rule.triggerId === trigger.id && rule.enabled)
      if (enabled.length === 0) {
        result.push({ id: `missing-${trigger.id}`, severity: '错误', ruleIds: [], title: `${trigger.name} 缺少联动动作`, detail: '报警点未配置任何启用的因果规则。', suggestion: '至少配置广播、排烟或疏散相关动作。' })
      }
      const actionCount = new Map<string, number>()
      enabled.forEach((rule) => actionCount.set(rule.actionId, (actionCount.get(rule.actionId) ?? 0) + 1))
      actionCount.forEach((count, actionId) => {
        if (count > 1) result.push({ id: `duplicate-${trigger.id}-${actionId}`, severity: '警告', ruleIds: enabled.filter((rule) => rule.actionId === actionId).map((rule) => rule.id), title: `${trigger.name} 存在重复动作`, detail: `同一个动作 ${actionId} 被重复配置 ${count} 次。`, suggestion: '合并规则或明确主备关系。' })
      })
    }
    currentRules.filter((rule) => rule.enabled).forEach((rule) => {
      const trigger = currentDevices.find((device) => device.id === rule.triggerId)
      const action = currentDevices.find((device) => device.id === rule.actionId)
      if (trigger && action && trigger.zone !== action.zone && rule.suppression === '无') {
        result.push({ id: `cross-${rule.id}`, severity: '警告', ruleIds: [rule.id], title: `${rule.id} 跨区联动未配置抑制`, detail: `${trigger.zone} 报警将直接触发 ${action.zone} 动作。`, suggestion: '确认疏散边界并增加分区确认或抑制条件。' })
      }
      if (rule.interlock && rule.interlock !== '无' && rule.delay > 5 && rule.priority === 1) {
        result.push({ id: `contradiction-${rule.id}`, severity: '错误', ruleIds: [rule.id], title: `${rule.id} 互锁与高优先级延时冲突`, detail: '一级优先规则在互锁未明确反馈前延时超过 5 秒。', suggestion: '缩短延时或改为反馈后触发。' })
      }
      if (!trigger || !action) {
        result.push({ id: `dangling-${rule.id}`, severity: '错误', ruleIds: [rule.id], title: `${rule.id} 引用了不存在的设备`, detail: '设备台账变化后该规则的触发点或动作点缺失。', suggestion: '重新选择点位或随设备变更一并处理该规则。' })
      }
    })
    return result
  })

  // ---------- 编辑入口（全部写本机批次，签字内容受内核保护） ----------

  function updateRule(id: string, patch: Partial<Rule>) {
    if (sync.working.signed) return
    raw.updateRule(id, patch)
    mutateWorking('规则变化')
  }

  function addRule() {
    if (sync.working.signed) return null
    const rule = raw.addRule()
    mutateWorking('规则变化')
    return rule
  }

  function deleteRule(id: string) {
    if (sync.working.signed) return
    raw.deleteRule(id)
    selectedRuleIds.value = selectedRuleIds.value.filter((item) => item !== id)
    mutateWorking('规则变化')
  }

  function addDevice(device: Device) {
    if (sync.working.signed) return
    raw.addDevice(device)
    mutateWorking('设备变化')
  }

  function batchUpdate(patch: Partial<Rule>) {
    if (sync.working.signed || selectedRuleIds.value.length === 0) return
    raw.batchUpdateRules(selectedRuleIds.value, patch)
    mutateWorking('规则变化')
  }

  function toggleSelected(enabled: boolean) {
    batchUpdate({ enabled })
  }

  function lockBaseline() {
    raw.signBaseline()
    mutateWorking('签字状态变化')
  }

  function unlock() {
    raw.unlockBaseline()
    mutateWorking('签字状态变化')
  }

  // ---------- 交接动作 ----------

  async function pushBatch() {
    await raw.push()
    touch()
    window.setTimeout(touch, 0)
  }

  function abortPush() {
    raw.abortPush()
  }

  async function pullNow() {
    await raw.pull(false)
    touch()
  }

  async function viewCurrent() {
    await raw.viewCurrent()
    touch()
  }

  function rebaseBatch() {
    raw.rebaseBatch()
    touch()
  }

  function resolveKeepMine(seq: number) {
    raw.resolveKeepMine(seq)
    mutateWorking('规则变化')
  }

  function resolveKeepTheirs(seq: number) {
    const change = raw.state.batch?.changes.find((c) => c.seq === seq)
    raw.resolveKeepTheirs(seq)
    mutateWorking(change?.kind === 'device' ? '设备变化' : '规则变化')
  }

  function discardBatch() {
    raw.discardBatch()
    invalidate('规则变化')
    touch()
  }

  function setLocalOffline(offline: boolean) {
    raw.setLocalOffline(offline)
    touch()
  }

  function setGlobalOffline(offline: boolean) {
    server!.setGlobalOnline(!offline)
    touch()
    window.setTimeout(() => {
      void raw.pull(true).then(touch).catch(touch)
    }, 0)
  }

  function setAuthor(author: string) {
    raw.setAuthor(author)
    touch()
  }

  function setSite(site: string) {
    raw.setSite(site)
    touch()
  }

  function strategy() {
    return raw.strategy()
  }

  // ---------- 模拟对侧窗口 / 另一专业 ----------

  async function remotePatchRule(ruleId: string, patch: Partial<Rule>, author?: string) {
    await server!.remoteRulePatch(ruleId, patch, author)
    touch()
  }

  async function remotePatchDevice(deviceId: string, patch: Partial<Device>, author?: string) {
    await server!.remoteDevicePatch(deviceId, patch, author)
    touch()
  }

  async function remoteSign(signed: boolean, author?: string) {
    await server!.remoteSign(signed, author)
    touch()
  }

  async function consoleClearClaim() {
    await server!.consoleClearClaim()
    touch()
  }

  function resetDemo() {
    server!.reset()
    host!.removeLocal('fire-linkage-session-v2')
    window.location.reload()
  }

  const history = computed<HistoryEvent[]>(() => serverSnapshot.value.history)

  function changeStatusLabel(change: ChangeRec) {
    return {
      pending: '待推进',
      applying: '重放中',
      applied: '已落库',
      conflict: '留待确认',
      dropped: '已确认丢弃',
    }[change.status]
  }

  function batchStatusLabel(b: Batch) {
    return {
      recording: '本机记录中',
      pushing: b.changes.some((c) => c.status === 'applying') ? '逐条重放中' : '整批推进中',
      interrupted: '合并中断（可续传）',
      conflicts: '冲突留验',
      pushed: '已推进',
      lost: '竞争落败（原批保留）',
      blocked: '签字阻断',
    }[b.status]
  }

  // 初次打开先重算一次
  recompute()
  // 恢复连接/对侧推进广播后，无在途批次的工作区会在内核 pull 中镜像
  window.setTimeout(() => touch(), 250)

  return {
    // 状态
    devices,
    rules,
    revision,
    locked,
    online,
    globalOnline,
    batch,
    activity,
    history,
    selectedRuleIds,
    validations,
    serverSnapshot,
    sync,
    rawClient: raw,
    // 派生失效
    derivedStamp,
    derivedAt,
    derivedReason,
    reviewValid,
    dependencyValid,
    checksum,
    recompute,
    // 编辑
    updateRule,
    addRule,
    deleteRule,
    addDevice,
    batchUpdate,
    toggleSelected,
    lockBaseline,
    unlock,
    // 交接
    pushBatch,
    abortPush,
    pullNow,
    viewCurrent,
    rebaseBatch,
    resolveKeepMine,
    resolveKeepTheirs,
    discardBatch,
    setLocalOffline,
    setGlobalOffline,
    setAuthor,
    setSite,
    strategy,
    // 对侧模拟 / 控制台
    remotePatchRule,
    remotePatchDevice,
    remoteSign,
    consoleClearClaim,
    resetDemo,
    changeStatusLabel,
    batchStatusLabel,
  }
})
