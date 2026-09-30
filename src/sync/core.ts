// 现场批次交接内核：纯 TypeScript，不依赖 Vue / DOM，可在 Node 下直接验证。
//
// 角色：
// - FieldServer：共享基线（设备、规则、签字状态、单调版本号），持有实体级版本、
//   推进占用（claim）和交接历史。所有写操作经互斥锁串行化。
// - SyncClient：一个现场窗口。打开时记录基线版本；改动按序号写入本机批次；
//   恢复连接后先比对基线：未前进则整批快进，前进则按设备/规则逐条重放，
//   双方都改过留待确认，签字内容拒绝覆盖；支持中断续传与旧草稿补版本。

export type DeviceType =
  | '感烟探测器'
  | '感温探测器'
  | '手动报警按钮'
  | '输入模块'
  | '输出模块'
  | '排烟风机'
  | '防火卷帘'
  | '消防广播'
  | '电梯'

export interface Device {
  id: string
  name: string
  type: DeviceType
  floor: string
  zone: string
  address: string
}

export interface Rule {
  id: string
  triggerId: string
  actionId: string
  delay: number
  interlock: string
  priority: 1 | 2 | 3
  suppression: string
  enabled: boolean
}

export const INITIAL_REVISION = 8

export const seedDevices: Device[] = [
  { id: 'D-01-01', name: '一层大厅感烟 01', type: '感烟探测器', floor: '1F', zone: 'A 区', address: '1-A-01-01' },
  { id: 'D-01-02', name: '一层大厅感烟 02', type: '感烟探测器', floor: '1F', zone: 'A 区', address: '1-A-01-02' },
  { id: 'D-01-11', name: '一层东侧手报', type: '手动报警按钮', floor: '1F', zone: 'A 区', address: '1-A-02-01' },
  { id: 'A-01-01', name: '一层排烟风机 PF-1', type: '排烟风机', floor: '1F', zone: 'A 区', address: '1-F-01-01' },
  { id: 'A-01-02', name: '中庭防火卷帘 01', type: '防火卷帘', floor: '1F', zone: '中庭', address: '1-R-01-01' },
  { id: 'A-01-03', name: '一层消防广播', type: '消防广播', floor: '1F', zone: 'A 区', address: '1-B-01-01' },
  { id: 'D-02-01', name: '二层机房感温 01', type: '感温探测器', floor: '2F', zone: 'B 区', address: '2-B-01-01' },
  { id: 'D-02-02', name: '二层机房感烟 01', type: '感烟探测器', floor: '2F', zone: 'B 区', address: '2-B-01-02' },
  { id: 'A-02-01', name: '二层排烟风机 PF-2', type: '排烟风机', floor: '2F', zone: 'B 区', address: '2-F-01-01' },
  { id: 'A-02-02', name: '1 号客梯归位', type: '电梯', floor: '2F', zone: 'B 区', address: '2-L-01-01' },
]

export const seedRules: Rule[] = [
  { id: 'R-001', triggerId: 'D-01-01', actionId: 'A-01-01', delay: 0, interlock: '卷帘全开后启动', priority: 1, suppression: '无', enabled: true },
  { id: 'R-002', triggerId: 'D-01-01', actionId: 'A-01-03', delay: 5, interlock: '无', priority: 2, suppression: '手动广播优先', enabled: true },
  { id: 'R-003', triggerId: 'D-01-02', actionId: 'A-01-02', delay: 0, interlock: '排烟风机运行', priority: 1, suppression: '无', enabled: true },
  { id: 'R-004', triggerId: 'D-01-11', actionId: 'A-01-03', delay: 3, interlock: '无', priority: 1, suppression: '无', enabled: true },
  { id: 'R-005', triggerId: 'D-02-01', actionId: 'A-02-01', delay: 0, interlock: '防火阀开启反馈', priority: 1, suppression: '无', enabled: true },
  { id: 'R-006', triggerId: 'D-02-01', actionId: 'A-02-02', delay: 10, interlock: '轿厢无人确认', priority: 2, suppression: '消防电梯模式', enabled: true },
  { id: 'R-007', triggerId: 'D-02-02', actionId: 'A-01-01', delay: 0, interlock: '无', priority: 3, suppression: '无', enabled: false },
  { id: 'R-008', triggerId: 'D-01-01', actionId: 'A-02-02', delay: 0, interlock: '无', priority: 1, suppression: '无', enabled: true },
]

// ---------- 操作与批次 ----------

export type EntityOp =
  | { kind: 'device-upsert'; entity: Device }
  | { kind: 'rule-upsert'; entity: Rule }
  | { kind: 'rule-delete'; entityId: string }

export type SignOp = { kind: 'sign'; signed: boolean }
export type Op = EntityOp | SignOp
export type ChangeKind = 'device' | 'rule' | 'sign'
export type ChangeStatus = 'pending' | 'applying' | 'applied' | 'conflict' | 'dropped'
export type BatchStatus = 'recording' | 'pushing' | 'interrupted' | 'conflicts' | 'pushed' | 'lost' | 'blocked'

export interface ConflictDetail {
  targetId: string
  label: string
  reason: 'both-edited' | 'deleted-elsewhere' | 'signed'
  mine: Device | Rule | null
  mineSummary: string
  theirs: Device | Rule | null
  theirsSummary: string
  theirsAuthor: string
  theirsAt: number
  entityRev: number
}

/** 按顺序记录的一条改动；entityRev 是落笔瞬间该实体的基线版本，重放时用于判断双方是否都改过。 */
export interface ChangeRec {
  seq: number
  kind: ChangeKind
  targetId: string
  label: string
  op: Op
  entityRev: number
  at: number
  author: string
  status: ChangeStatus
  detail?: string
  conflict?: ConflictDetail
  parentSeq?: number
}

export interface WinnerInfo {
  clientId: string
  author: string
  batchId: string
  at: number
  serverRevision: number
}

export interface Batch {
  id: string
  clientId: string
  author: string
  openedAtRevision: number
  openedAt: number
  site: string
  changes: ChangeRec[]
  status: BatchStatus
  winner?: WinnerInfo
  lastError?: string
  pushedAt?: number
}

export interface ActivityEntry {
  id: string
  at: number
  level: 'info' | 'success' | 'warning' | 'error'
  text: string
}

// ---------- 服务器侧 ----------

export interface EntityMeta {
  rev: number
  author: string
  at: number
  deleted?: boolean
}

export interface HistoryEvent {
  id: string
  at: number
  rev: number
  author: string
  clientId: string
  batchId?: string
  kind: ChangeKind | 'batch'
  summary: string
  targetId?: string
  seq?: number
}

interface Claim {
  token: string
  batchId: string
  clientId: string
  author: string
  baseRevision: number
  mode: 'ff' | 'replay'
  at: number
  heartbeatAt: number
  appliedSeq: number[]
  /** 已写入但尚未并入版本号的历史条目 id */
  pendingEventIds: string[]
}

export interface ServerState {
  rev: number
  initialRev: number
  signed: boolean
  signedRevision: number | null
  signedBy: string | null
  signedAt: number | null
  devices: Device[]
  rules: Rule[]
  meta: Record<string, EntityMeta>
  history: HistoryEvent[]
  claim: Claim | null
}

export interface Snapshot {
  rev: number
  initialRev: number
  signed: boolean
  signedRevision: number | null
  signedBy: string | null
  signedAt: number | null
  devices: Device[]
  rules: Rule[]
  meta: Record<string, EntityMeta>
  history: HistoryEvent[]
}

// ---------- 推进协商结果 ----------

export type BeginResult =
  | { outcome: 'fast-forward'; token: string }
  | { outcome: 'replay'; token: string; resumedSeq: number[] }
  | { outcome: 'blocked-signed'; signedRevision: number }
  | { outcome: 'lost'; serverRevision: number; winner: WinnerInfo }

export type CommitResult =
  | { kind: 'applied'; seq: number }
  | { kind: 'conflict'; seq: number; detail: ConflictDetail }

// ---------- 宿主环境 ----------

export type BroadcastMessage = { type: 'server'; revision: number; clientId: string | null } | { type: 'network' }

export interface Host {
  now(): number
  uid(): string
  sleep(ms: number): Promise<void>
  getShared(key: string): string | null
  setShared(key: string, value: string): void
  removeShared(key: string): void
  getLocal(key: string): string | null
  setLocal(key: string, value: string): void
  removeLocal(key: string): void
  withLock<T>(fn: () => Promise<T> | T): Promise<T>
  broadcast(message: BroadcastMessage): void
  onBroadcast(handler: (message: BroadcastMessage) => void): () => void
}

const SERVER_KEY = 'fire-linkage-server-v2'
const NETWORK_KEY = 'fire-linkage-network'
const LEGACY_DRAFT_KEY = 'fire-linkage-draft-v1'
const CLAIM_STALE_MS = 20_000

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function summaryOf(op: Op): string {
  switch (op.kind) {
    case 'device-upsert':
      return `设备 ${op.entity.name}（${op.entity.id}）登记/改写`
    case 'rule-upsert':
      return `规则 ${op.entity.id}：延时 ${op.entity.delay}s / 优先级 ${op.entity.priority} / ${op.entity.enabled ? '启用' : '停用'}`
    case 'rule-delete':
      return `规则 ${op.entityId} 删除`
    case 'sign':
      return op.signed ? '基线签字锁定' : '基线解锁修订'
  }
}

function labelOf(op: Op): string {
  if (op.kind === 'rule-delete') return op.entityId
  if (op.kind === 'sign') return '签字状态'
  return op.entity.id
}

function kindOf(op: Op): ChangeKind {
  if (op.kind === 'sign') return 'sign'
  return op.kind.startsWith('device') ? 'device' : 'rule'
}

export function createInitialServerState(): ServerState {
  const meta: Record<string, EntityMeta> = {}
  for (const device of seedDevices) meta[device.id] = { rev: 1, author: '竣工基线', at: 0 }
  for (const rule of seedRules) meta[rule.id] = { rev: 1, author: '竣工基线', at: 0 }
  return {
    rev: INITIAL_REVISION,
    initialRev: INITIAL_REVISION,
    signed: false,
    signedRevision: null,
    signedBy: null,
    signedAt: null,
    devices: clone(seedDevices),
    rules: clone(seedRules),
    meta,
    history: [
      {
        id: 'H-INIT',
        at: 0,
        rev: INITIAL_REVISION,
        author: '系统',
        clientId: 'server',
        kind: 'batch',
        summary: `竣工首版基线 R${INITIAL_REVISION} 入库`,
      },
    ],
    claim: null,
  }
}

export interface BeginPushInput {
  batchId: string
  clientId: string
  author: string
  baseRevision: number
}

export class FieldServer {
  constructor(private host: Host) {}

  private load(): ServerState {
    const raw = this.host.getShared(SERVER_KEY)
    if (!raw) {
      const initial = createInitialServerState()
      this.host.setShared(SERVER_KEY, JSON.stringify(initial))
      return initial
    }
    return JSON.parse(raw) as ServerState
  }

  private save(state: ServerState) {
    this.host.setShared(SERVER_KEY, JSON.stringify(state))
  }

  reset() {
    this.host.removeShared(SERVER_KEY)
    this.host.removeShared(LEGACY_DRAFT_KEY)
    const state = this.load()
    this.host.broadcast({ type: 'server', revision: state.rev, clientId: null })
  }
  snapshot(): Snapshot {
    const s = this.load()
    return {
      rev: s.rev,
      initialRev: s.initialRev,
      signed: s.signed,
      signedRevision: s.signedRevision,
      signedBy: s.signedBy,
      signedAt: s.signedAt,
      devices: clone(s.devices),
      rules: clone(s.rules),
      meta: clone(s.meta),
      history: clone(s.history.slice(-60)),
    }
  }

  isGlobalOnline(): boolean {
    return this.host.getShared(NETWORK_KEY) !== 'offline'
  }

  setGlobalOnline(online: boolean) {
    if (online) this.host.removeShared(NETWORK_KEY)
    else this.host.setShared(NETWORK_KEY, 'offline')
    this.host.broadcast({ type: 'network' })
  }

  /** 回收超过租期的中断占用；若已有条目落库，先并入版本号。 */
  private expireClaim(state: ServerState) {
    const claim = state.claim
    if (!claim) return
    if (this.host.now() - claim.heartbeatAt <= CLAIM_STALE_MS) return
    this.stampPending(state, claim)
    state.history.push({
      id: this.host.uid(),
      at: this.host.now(),
      rev: state.rev,
      author: claim.author,
      clientId: claim.clientId,
      batchId: claim.batchId,
      kind: 'batch',
      summary: `批次 ${claim.batchId} 的中断占用超时回收，已完成序号 ${claim.appliedSeq.length ? Math.max(...claim.appliedSeq) : 0}`,
    })
    state.claim = null
  }

  private stampPending(state: ServerState, claim: Claim) {
    if (claim.pendingEventIds.length === 0) return
    state.rev += 1
    for (const event of state.history) {
      if (claim.pendingEventIds.includes(event.id) && event.rev === 0) event.rev = state.rev
    }
    // 本批内发生签字，回填其锁定的基线版本号
    if (state.signed && state.signedRevision === -1) state.signedRevision = state.rev
    claim.pendingEventIds = []
  }

  async beginPush(input: BeginPushInput): Promise<BeginResult> {
    return this.host.withLock(() => {
      const state = this.load()
      this.expireClaim(state)

      if (state.claim) {
        const claim = state.claim
        // 同一批次续传：接着上次的占用走
        if (claim.batchId === input.batchId && claim.clientId === input.clientId) {
          claim.heartbeatAt = this.host.now()
          this.save(state)
          return { outcome: 'replay', token: claim.token, resumedSeq: [...claim.appliedSeq] }
        }
        this.save(state)
        return {
          outcome: 'lost',
          serverRevision: state.rev,
          winner: {
            clientId: claim.clientId,
            author: claim.author,
            batchId: claim.batchId,
            at: claim.at,
            serverRevision: state.rev,
          },
        }
      }

      if (state.signed) {
        this.save(state)
        return { outcome: 'blocked-signed', signedRevision: state.signedRevision && state.signedRevision > 0 ? state.signedRevision : state.rev }
      }

      const mode = state.rev === input.baseRevision ? 'ff' : 'replay'
      const token = this.host.uid()
      state.claim = {
        token,
        batchId: input.batchId,
        clientId: input.clientId,
        author: input.author,
        baseRevision: input.baseRevision,
        mode,
        at: this.host.now(),
        heartbeatAt: this.host.now(),
        appliedSeq: [],
        pendingEventIds: [],
      }
      this.save(state)
      return mode === 'ff' ? { outcome: 'fast-forward', token } : { outcome: 'replay', token, resumedSeq: [] }
    })
  }

  private pushHistory(state: ServerState, event: Omit<HistoryEvent, 'id' | 'rev' | 'at'> & { at?: number }, claim: Claim) {
    const full: HistoryEvent = {
      id: this.host.uid(),
      at: event.at ?? this.host.now(),
      rev: 0,
      author: event.author,
      clientId: event.clientId,
      batchId: event.batchId,
      kind: event.kind,
      summary: event.summary,
      targetId: event.targetId,
      seq: event.seq,
    }
    state.history.push(full)
    claim.pendingEventIds.push(full.id)
    return full
  }

  /** 快进：基线未变，整批一次推进，占用内不再逐条比对。 */
  async commitFastForward(token: string, changes: ChangeRec[]): Promise<{ revision: number }> {
    return this.host.withLock(() => {
      const state = this.load()
      const claim = state.claim
      if (!claim || claim.token !== token) throw new Error('推进占用已失效，请重新提交批次')
      for (const change of changes) {
        this.mutate(state, change, claim, true)
      }
      this.stampPending(state, claim)
      const revision = state.rev
      state.history.push({
        id: this.host.uid(),
        at: this.host.now(),
        rev: revision,
        author: claim.author,
        clientId: claim.clientId,
        batchId: claim.batchId,
        kind: 'batch',
        summary: `批次 ${claim.batchId} 整批快进：${changes.length} 条改动推进至 R${revision}`,
      })
      state.claim = null
      this.save(state)
      this.host.broadcast({ type: 'server', revision, clientId: claim.clientId })
      return { revision }
    })
  }

  /** 逐条重放：返回本条是否落库或冲突；中断时已完成条目随持久化保留，不重复执行。 */
  async commitOne(token: string, change: ChangeRec): Promise<CommitResult> {
    return this.host.withLock(() => {
      const state = this.load()
      const claim = state.claim
      if (!claim || claim.token !== token) throw new Error('推进占用已失效，请从中断序号继续')
      if (claim.appliedSeq.includes(change.seq)) return { kind: 'applied', seq: change.seq }
      claim.heartbeatAt = this.host.now()

      const result = this.mutate(state, change, claim, false)
      this.save(state)
      if (result.kind === 'applied') {
        claim.appliedSeq.push(change.seq)
        this.save(state)
      }
      return result
    })
  }

  /** 中断：已落库条目立即并入一个新版本并持久化，占用保留供同批次续传。 */
  async pausePush(token: string): Promise<{ revision: number; appliedSeq: number[] }> {
    return this.host.withLock(() => {
      const state = this.load()
      const claim = state.claim
      if (!claim || claim.token !== token) throw new Error('推进占用已失效')
      this.stampPending(state, claim)
      claim.heartbeatAt = this.host.now()
      this.save(state)
      this.host.broadcast({ type: 'server', revision: state.rev, clientId: claim.clientId })
      return { revision: state.rev, appliedSeq: [...claim.appliedSeq] }
    })
  }

  /** 重放完成：收口版本号、释放占用。 */
  async finishPush(token: string): Promise<{ revision: number; applied: number; conflicts: number }> {
    return this.host.withLock(() => {
      const state = this.load()
      const claim = state.claim
      if (!claim || claim.token !== token) throw new Error('推进占用已失效')
      this.stampPending(state, claim)
      const revision = state.rev
      state.history.push({
        id: this.host.uid(),
        at: this.host.now(),
        rev: revision,
        author: claim.author,
        clientId: claim.clientId,
        batchId: claim.batchId,
        kind: 'batch',
        summary: `批次 ${claim.batchId} 重放收口：${claim.appliedSeq.length} 条落库，剩余条目留待确认`,
      })
      state.claim = null
      this.save(state)
      this.host.broadcast({ type: 'server', revision, clientId: claim.clientId })
      return { revision, applied: claim.appliedSeq.length, conflicts: 0 }
    })
  }

  /** 放弃占用（未实际落库或演练清理）。 */
  async cancelPush(token: string) {
    return this.host.withLock(() => {
      const state = this.load()
      if (state.claim?.token === token) {
        if (state.claim.pendingEventIds.length > 0) this.stampPending(state, state.claim)
        state.claim = null
        this.save(state)
        this.host.broadcast({ type: 'server', revision: state.rev, clientId: null })
      }
    })
  }

  async consoleClearClaim() {
    return this.host.withLock(() => {
      const state = this.load()
      if (state.claim) {
        this.expireClaim(state)
        state.claim = null
        this.save(state)
        this.host.broadcast({ type: 'server', revision: state.rev, clientId: null })
      }
    })
  }

  private mutate(state: ServerState, change: ChangeRec, claim: Claim, fastForward: boolean): CommitResult {
    const op = change.op
    const eventBase = {
      author: change.author,
      clientId: claim.clientId,
      batchId: claim.batchId,
      seq: change.seq,
      targetId: change.targetId,
    }

    if (op.kind === 'sign') {
      state.signed = op.signed
      if (op.signed) {
        // 收口版本号在 stampPending 时回填（-1 表示已签字但本批尚未收口）
        state.signedRevision = -1
        state.signedBy = change.author
        state.signedAt = this.host.now()
      } else {
        state.signedRevision = null
        state.signedBy = null
        state.signedAt = null
      }
      this.pushHistory(state, { ...eventBase, kind: 'sign', summary: summaryOf(op) }, claim)
      return { kind: 'applied', seq: change.seq }
    }

    const isDevice = op.kind === 'device-upsert'
    const list: Array<Device | Rule> = isDevice ? state.devices : state.rules
    const meta = state.meta[change.targetId]

    const conflict = (theirs: Device | Rule | null, reason: ConflictDetail['reason']): CommitResult => {
      const detail: ConflictDetail = {
        targetId: change.targetId,
        label: change.label,
        reason,
        mine: op.kind === 'rule-delete' ? null : op.entity,
        mineSummary: summaryOf(op),
        theirs,
        theirsSummary: theirs ? `${theirs.id} 现场版本（${meta?.author ?? '未知'} 已改）` : '该条目已在另一窗口被删除',
        theirsAuthor: meta?.author ?? '未知',
        theirsAt: meta?.at ?? 0,
        entityRev: meta?.rev ?? 0,
      }
      return { kind: 'conflict', seq: change.seq, detail }
    }

    if (op.kind === 'rule-delete') {
      const index = list.findIndex((item) => item.id === op.entityId)
      if (index === -1) {
        if (fastForward || change.entityRev === 0 || meta?.deleted) {
          if (meta) meta.deleted = true
          this.pushHistory(state, { ...eventBase, kind: 'rule', summary: summaryOf(op) }, claim)
          return { kind: 'applied', seq: change.seq }
        }
        return conflict(null, 'deleted-elsewhere')
      }
      if (!fastForward && meta && meta.rev !== change.entityRev) {
        return conflict(list[index] as Rule, 'both-edited')
      }
      list.splice(index, 1)
      const m = state.meta[op.entityId] ?? { rev: 0, author: change.author, at: this.host.now() }
      m.rev += 1
      m.author = change.author
      m.at = this.host.now()
      m.deleted = true
      state.meta[op.entityId] = m
      this.pushHistory(state, { ...eventBase, kind: 'rule', summary: summaryOf(op) }, claim)
      return { kind: 'applied', seq: change.seq }
    }

    const entity = op.entity
    const index = list.findIndex((item) => item.id === entity.id)
    if (index === -1) {
      // 本机新增
      if (meta?.deleted) {
        if (fastForward) {
          // 快进基线一致，删除也来自本基线上的共识，按新增覆盖墓碑
        } else {
          return conflict(null, 'deleted-elsewhere')
        }
      } else if (meta && !fastForward && change.entityRev !== 0) {
        return conflict(null, 'deleted-elsewhere')
      }
      list.push(clone(entity))
      state.meta[entity.id] = { rev: 1, author: change.author, at: this.host.now() }
      this.pushHistory(state, { ...eventBase, kind: kindOf(op), summary: summaryOf(op) }, claim)
      return { kind: 'applied', seq: change.seq }
    }

    if (!fastForward && meta && meta.rev !== change.entityRev) {
      return conflict(clone(list[index]) as Device | Rule, 'both-edited')
    }
    list[index] = clone(entity)
    const m = state.meta[entity.id] ?? { rev: 0, author: change.author, at: this.host.now() }
    m.rev += 1
    m.author = change.author
    m.at = this.host.now()
    state.meta[entity.id] = m
    this.pushHistory(state, { ...eventBase, kind: kindOf(op), summary: summaryOf(op) }, claim)
    return { kind: 'applied', seq: change.seq }
  }

  // ---------- 模拟“另一窗口/另一专业”直接对服务器推进 ----------

  private async remoteApply(changes: Array<{ op: Op; author: string }>): Promise<{ revision: number }> {
    return this.host.withLock(() => {
      const state = this.load()
      this.expireClaim(state)
      if (state.claim) throw new Error('有批次正在推进，无法插入对侧修改')
      if (state.signed) throw new Error('基线已签字锁定')
      const tempClaim: Claim = {
        token: this.host.uid(),
        batchId: `remote-${this.host.uid()}`,
        clientId: 'remote',
        author: changes[0]?.author ?? '对侧窗口',
        baseRevision: state.rev,
        mode: 'ff',
        at: this.host.now(),
        heartbeatAt: this.host.now(),
        appliedSeq: [],
        pendingEventIds: [],
      }
      for (const { op, author } of changes) {
        const rec: ChangeRec = {
          seq: tempClaim.appliedSeq.length + 1,
          kind: kindOf(op),
          targetId: labelOf(op),
          label: labelOf(op),
          op,
          entityRev: state.meta[labelOf(op)]?.rev ?? 0,
          at: this.host.now(),
          author,
          status: 'applied',
        }
        const result = this.mutate(state, rec, tempClaim, false)
        if (result.kind === 'conflict') throw new Error(`对侧修改被占用基线拒绝：${result.detail.label}`)
        tempClaim.appliedSeq.push(rec.seq)
      }
      this.stampPending(state, tempClaim)
      state.history.push({
        id: this.host.uid(),
        at: this.host.now(),
        rev: state.rev,
        author: tempClaim.author,
        clientId: 'remote',
        kind: 'batch',
        summary: `对侧窗口推进至 R${state.rev}：${changes.map((c) => summaryOf(c.op)).join('；')}`,
      })
      this.save(state)
      this.host.broadcast({ type: 'server', revision: state.rev, clientId: 'remote' })
      return { revision: state.rev }
    })
  }

  async remoteRulePatch(ruleId: string, patch: Partial<Rule>, author = '对侧窗口（暖通专业）') {
    const current = this.load().rules.find((rule) => rule.id === ruleId)
    if (!current) throw new Error(`服务器上不存在规则 ${ruleId}`)
    return this.remoteApply([{ op: { kind: 'rule-upsert', entity: { ...current, ...patch } }, author }])
  }

  async remoteDevicePatch(deviceId: string, patch: Partial<Device>, author = '对侧窗口（消防电专业）') {
    const current = this.load().devices.find((device) => device.id === deviceId)
    if (!current) throw new Error(`服务器上不存在设备 ${deviceId}`)
    return this.remoteApply([{ op: { kind: 'device-upsert', entity: { ...current, ...patch } }, author }])
  }

  async remoteSign(signed: boolean, author = '对侧窗口（审阅人）') {
    return this.host.withLock(() => {
      const state = this.load()
      this.expireClaim(state)
      if (state.claim) throw new Error('有批次正在推进，无法切换签字状态')
      state.signed = signed
      if (signed) {
        state.signedRevision = state.rev + 1
        state.signedBy = author
        state.signedAt = this.host.now()
      } else {
        state.signedRevision = null
        state.signedBy = null
        state.signedAt = null
      }
      state.rev += 1
      state.history.push({
        id: this.host.uid(),
        at: this.host.now(),
        rev: state.rev,
        author,
        clientId: 'remote',
        kind: 'sign',
        summary: signed ? `基线 R${state.rev} 签字锁定（${author}）` : '基线解锁修订（对侧窗口）',
      })
      this.save(state)
      this.host.broadcast({ type: 'server', revision: state.rev, clientId: 'remote' })
      return { revision: state.rev }
    })
  }
}

// ---------- 客户端 ----------

const SESSION_KEY = 'fire-linkage-session-v2'
const LOCAL_OFFLINE_KEY = 'fire-linkage-local-offline'

export interface WorkingState {
  devices: Device[]
  rules: Rule[]
  signed: boolean
}

export interface SessionState {
  clientId: string
  author: string
  site: string
  working: WorkingState
  knownRev: number
  knownSigned: boolean
  knownSignedRevision: number | null
  knownMeta: Record<string, EntityMeta>
  batch: Batch | null
  closed: Batch[]
  activity: ActivityEntry[]
  pushing: { mode: 'ff' | 'replay'; total: number; done: number } | null
}

export interface LegacyDraft {
  devices?: Device[]
  rules?: Rule[]
  revision?: number
  locked?: boolean
}

export function createSessionState(clientId: string, snapshot: Snapshot, author: string, site: string): SessionState {
  return {
    clientId,
    author,
    site,
    working: { devices: clone(snapshot.devices), rules: clone(snapshot.rules), signed: snapshot.signed },
    knownRev: snapshot.rev,
    knownSigned: snapshot.signed,
    knownSignedRevision: snapshot.signedRevision,
    knownMeta: clone(snapshot.meta),
    batch: null,
    closed: [],
    activity: [],
    pushing: null,
  }
}

export class OfflineError extends Error {}

export class SyncClient {
  private abortRequested = false
  private offBroadcast: (() => void) | null = null

  constructor(
    private host: Host,
    public server: FieldServer,
    public state: SessionState,
  ) {}

  start() {
    this.offBroadcast = this.host.onBroadcast((message) => {
      if (message.type === 'network') return
      if (!this.isOnline()) return
      if (message.clientId === this.state.clientId) return
      void this.pull(true)
    })
  }

  dispose() {
    this.offBroadcast?.()
  }

  persist() {
    this.host.setLocal(SESSION_KEY, JSON.stringify(this.state))
  }

  log(level: ActivityEntry['level'], text: string) {
    this.state.activity.unshift({ id: this.host.uid(), at: this.host.now(), level, text })
    if (this.state.activity.length > 80) this.state.activity.length = 80
    this.persist()
  }

  isOnline(): boolean {
    return this.server.isGlobalOnline() && this.host.getLocal(LOCAL_OFFLINE_KEY) !== '1'
  }

  setLocalOffline(offline: boolean) {
    if (offline) this.host.setLocal(LOCAL_OFFLINE_KEY, '1')
    else this.host.removeLocal(LOCAL_OFFLINE_KEY)
    this.host.broadcast({ type: 'network' })
    if (!offline) {
      this.log('success', '连接恢复，开始核对基线版本')
      void this.pull(true)
    } else {
      this.log('warning', '本机已断网，改动按序号写入本机批次，恢复后再交接')
    }
  }

  setAuthor(author: string) {
    this.state.author = author
    if (this.state.batch) this.state.batch.author = author
    this.persist()
  }

  setSite(site: string) {
    this.state.site = site
    this.persist()
  }

  /** 拉取基线；只有本机完全没有在途批次时才整体镜像，避免覆盖现场工作区。 */
  async pull(silent = false): Promise<Snapshot> {
    if (!this.isOnline()) throw new OfflineError('当前处于断网状态')
    const snap = this.server.snapshot()
    const canMirror = this.state.batch === null
    this.state.knownRev = snap.rev
    this.state.knownSigned = snap.signed
    this.state.knownSignedRevision = snap.signedRevision
    this.state.knownMeta = clone(snap.meta)
    if (canMirror) {
      this.state.working.devices = clone(snap.devices)
      this.state.working.rules = clone(snap.rules)
      this.state.working.signed = snap.signed
    }
    this.persist()
    if (!silent) this.log('info', `已读取当前基线 R${snap.rev}（${snap.history.length} 条交接记录）`)
    return snap
  }

  hasPendingChanges(): boolean {
    const b = this.state.batch
    return !!b && b.changes.some((change) => change.status === 'pending' || change.status === 'conflict')
  }

  // ---------- 批次与改动记录 ----------

  private ensureBatch(): Batch {
    if (this.state.batch) return this.state.batch
    const batch: Batch = {
      id: `B-${this.state.clientId.slice(0, 4)}-${this.host.uid().slice(0, 6)}`.toUpperCase(),
      clientId: this.state.clientId,
      author: this.state.author,
      openedAtRevision: this.state.knownRev,
      openedAt: this.host.now(),
      site: this.state.site,
      changes: [],
      status: 'recording',
    }
    this.state.batch = batch
    this.log('info', `现场批次 ${batch.id} 开批，打开时版本 R${batch.openedAtRevision}`)
    return batch
  }

  private record(op: Op) {
    // 签字/解锁动作本身必须允许记录；其余改动在签字工作区一律拒绝
    if (op.kind !== 'sign' && this.state.working.signed) {
      this.log('error', '当前工作区对应基线已签字，不能再记录改动；如需修订请先解锁')
      return
    }
    const batch = this.state.batch
    if (batch && (batch.status === 'lost' || batch.status === 'blocked')) {
      this.log('warning', `批次 ${batch.id} 处于${batch.status === 'lost' ? '落败待重放' : '签字阻断'}状态，请先重放或丢弃后再改`)
      return
    }
    const b = this.ensureBatch()
    const kind = kindOf(op)
    const targetId = labelOf(op)
    const entityRev = op.kind === 'sign' ? 0 : (this.state.knownMeta[targetId]?.rev ?? 0)
    const seq = b.changes.reduce((max, change) => Math.max(max, change.seq), 0) + 1

    // 同对象的连续改动并入最早序号，顺序位置不变，实体版本保持落笔时基线版本
    const existing = b.changes.find((change) => change.targetId === targetId && (change.status === 'pending'))
    if (existing && op.kind !== 'sign' && existing.op.kind !== 'sign') {
      existing.op = op
      existing.label = targetId
      existing.detail = `连续编辑已并入序号 ${existing.seq}，落笔版本仍为 v${existing.entityRev}`
      this.persist()
      return
    }

    b.changes.push({
      seq,
      kind,
      targetId,
      label: targetId,
      op,
      entityRev,
      at: this.host.now(),
      author: this.state.author,
      status: 'pending',
    })
    b.status = b.changes.some((change) => change.status === 'conflict') ? 'conflicts' : 'recording'
    this.log('info', `序号 ${seq} 已记录：${summaryOf(op)}（依据版本 R${b.openedAtRevision} / 实体 v${entityRev}）`)
    this.persist()
  }

  // ---------- 业务变更入口 ----------

  updateRule(id: string, patch: Partial<Rule>) {
    const rule = this.state.working.rules.find((item) => item.id === id)
    if (!rule) return
    Object.assign(rule, patch)
    this.record({ kind: 'rule-upsert', entity: clone(rule) })
  }

  addRule(): Rule {
    const used = new Set(this.state.working.rules.map((rule) => rule.id))
    let n = this.state.working.rules.length + 1
    let id = ''
    do {
      id = `R-${String(n).padStart(3, '0')}-${this.state.clientId.slice(2, 6)}`
      n += 1
    } while (used.has(id))
    const triggerCandidates = this.state.working.devices.filter((d) =>
      ['感烟探测器', '感温探测器', '手动报警按钮', '输入模块'].includes(d.type),
    )
    const actionCandidates = this.state.working.devices.filter((d) =>
      ['排烟风机', '防火卷帘', '消防广播', '电梯', '输出模块'].includes(d.type),
    )
    const rule: Rule = {
      id,
      triggerId: triggerCandidates[0]?.id ?? '',
      actionId: actionCandidates[0]?.id ?? '',
      delay: 0,
      interlock: '无',
      priority: 2,
      suppression: '无',
      enabled: true,
    }
    this.state.working.rules.push(rule)
    this.record({ kind: 'rule-upsert', entity: clone(rule) })
    return rule
  }

  deleteRule(id: string) {
    const index = this.state.working.rules.findIndex((rule) => rule.id === id)
    if (index === -1) return
    this.state.working.rules.splice(index, 1)
    this.record({ kind: 'rule-delete', entityId: id })
  }

  addDevice(device: Device) {
    if (this.state.working.devices.some((item) => item.id === device.id)) {
      this.log('warning', `设备编号 ${device.id} 已存在`)
      return
    }
    this.state.working.devices.push(clone(device))
    this.record({ kind: 'device-upsert', entity: clone(device) })
  }

  batchUpdateRules(ids: string[], patch: Partial<Rule>) {
    for (const id of ids) this.updateRule(id, patch)
  }

  signBaseline() {
    this.state.working.signed = true
    this.record({ kind: 'sign', signed: true })
  }

  unlockBaseline() {
    this.state.working.signed = false
    this.record({ kind: 'sign', signed: false })
  }

  // ---------- 推进策略 ----------

  strategy(): { kind: 'offline' | 'empty' | 'fast-forward' | 'replay' | 'blocked' | 'lost' | 'interrupted' | 'conflicts'; text: string } {
    const b = this.state.batch
    if (!this.isOnline()) return { kind: 'offline', text: '断网中：改动暂存本机，恢复后先核对基线' }
    if (!b || !b.changes.some((c) => c.status === 'pending')) {
      if (b?.changes.some((c) => c.status === 'conflict')) return { kind: 'conflicts', text: '存在双方都改过的条目，留待逐条确认' }
      return { kind: 'empty', text: '本机批次没有待推进改动' }
    }
    if (b.status === 'lost') return { kind: 'lost', text: `同批竞争落败，对侧 ${b.winner?.author ?? '窗口'} 已推进` }
    if (b.status === 'blocked') return { kind: 'blocked', text: `基线已签字（R${this.state.knownSignedRevision ?? '?'}），不能覆盖签字内容` }
    if (b.status === 'interrupted') return { kind: 'interrupted', text: '合并中断：从最后完整序号继续，已完成条目不重复' }
    if (this.state.knownSigned) return { kind: 'blocked', text: `基线已签字（R${this.state.knownSignedRevision ?? '?'}），不能覆盖签字内容` }
    if (this.state.knownRev === b.openedAtRevision) return { kind: 'fast-forward', text: `基线未前进（R${b.openedAtRevision}），整批快进推进` }
    return { kind: 'replay', text: `基线已前进 R${b.openedAtRevision} → R${this.state.knownRev}，按设备与规则逐条重放` }
  }

  // ---------- 推进 ----------

  async push(): Promise<void> {
    const b = this.state.batch
    if (!b) return
    if (!this.isOnline()) {
      this.log('warning', '仍处于断网状态，无法交接；连接恢复后会先核对基线')
      return
    }
    const pending = b.changes.filter((change) => change.status === 'pending')
    if (pending.length === 0) {
      this.log('info', '没有待推进条目（冲突条目请先逐条确认）')
      return
    }
    if (this.state.knownSigned || this.server.snapshot().signed) {
      b.status = 'blocked'
      b.lastError = '基线已签字锁定'
      this.log('error', '基线已签字，整批不得覆盖签字内容，批次原样保留')
      this.persist()
      return
    }

    this.abortRequested = false
    const begin = await this.server.beginPush({
      batchId: b.id,
      clientId: this.state.clientId,
      author: this.state.author,
      baseRevision: b.openedAtRevision,
    })

    if (begin.outcome === 'blocked-signed') {
      b.status = 'blocked'
      b.lastError = `基线 R${begin.signedRevision} 已签字`
      this.log('error', `服务器基线 R${begin.signedRevision} 已签字，批次保留待解锁后重放`)
      this.persist()
      return
    }

    if (begin.outcome === 'lost') {
      b.status = 'lost'
      b.winner = { ...begin.winner }
      b.lastError = '两个窗口同时提交，只允许一份推进'
      this.log('error', `竞争落败：${begin.winner.author} 的批次 ${begin.winner.batchId} 正在推进，当前基线 R${begin.serverRevision}；本批原样保留`)
      this.persist()
      return
    }

    b.status = 'pushing'
    this.state.pushing = { mode: begin.outcome === 'fast-forward' ? 'ff' : 'replay', total: pending.length, done: 0 }
    this.persist()

    if (begin.outcome === 'fast-forward') {
      try {
        const { revision } = await this.server.commitFastForward(begin.token, pending)
        for (const change of pending) change.status = 'applied'
        b.status = 'pushed'
        b.pushedAt = this.host.now()
        this.state.pushing = null
        this.log('success', `整批快进完成：${pending.length} 条改动一次推进至 R${revision}`)
        await this.pull(true).catch(() => undefined)
        this.closeBatch()
      } catch (error) {
        this.state.pushing = null
        b.status = 'recording'
        this.log('error', `快进中断：${(error as Error).message}；条目均未重复落库，可再次推进`)
      }
      this.persist()
      return
    }

    // replay（含中断续传）
    const resumed = new Set(begin.resumedSeq)
    for (const change of pending) {
      if (resumed.has(change.seq)) {
        change.status = 'applied'
        this.state.pushing && (this.state.pushing.done += 1)
        continue
      }
      if (this.abortRequested) {
        await this.interruptReplay(begin.token, b)
        return
      }
      change.status = 'applying'
      this.persist()
      await this.host.sleep(360 + Math.round(Math.random() * 260))
      let result: CommitResult
      try {
        result = await this.server.commitOne(begin.token, change)
      } catch (error) {
        // 网络中断 / 占用失效：已完成条目持久在案，按中断处理
        this.log('warning', `序号 ${change.seq} 提交时连接中断：${(error as Error).message}`)
        await this.interruptReplay(begin.token, b, true)
        return
      }
      if (result.kind === 'applied') {
        change.status = 'applied'
        change.detail = '已按重放落库'
        this.state.pushing && (this.state.pushing.done += 1)
        this.log('success', `序号 ${change.seq} 重放落库：${summaryOf(change.op)}`)
      } else {
        change.status = 'conflict'
        change.conflict = result.detail
        change.detail = '双方都改过，留待确认'
        this.state.pushing && (this.state.pushing.total += 0)
        this.log('warning', `序号 ${change.seq} 冲突留验：现场与 ${result.detail.theirsAuthor} 都修改了 ${result.detail.label}`)
      }
      this.persist()
    }

    if (this.abortRequested) {
      await this.interruptReplay(begin.token, b)
      return
    }

    const remainingConflicts = b.changes.filter((change) => change.status === 'conflict')
    if (remainingConflicts.length === 0) {
      const finish = await this.server.finishPush(begin.token)
      b.status = 'pushed'
      b.pushedAt = this.host.now()
      this.state.pushing = null
      this.log('success', `逐条重放完成：${finish.applied} 条落库至 R${finish.revision}`)
      await this.pull(true).catch(() => undefined)
      this.closeBatch()
    } else {
      const finish = await this.server.finishPush(begin.token)
      b.status = 'conflicts'
      this.state.pushing = null
      this.log('warning', `重放暂停在 R${finish.revision}：${remainingConflicts.length} 条双方都改过，确认后继续推进`)
      await this.pull(true).catch(() => undefined)
    }
    this.persist()
  }

  private async interruptReplay(token: string, b: Batch, remoteGone = false) {
    this.state.pushing = null
    b.status = 'interrupted'
    if (!remoteGone) {
      try {
        const paused = await this.server.pausePush(token)
        const lastSeq = paused.appliedSeq.length ? Math.max(...paused.appliedSeq) : 0
        this.log('warning', `合并已中断：已完成 ${paused.appliedSeq.length} 条（最后完整序号 ${lastSeq}），R${paused.revision} 已固化，续传不重复`)
      } catch {
        this.log('warning', '中断信号未送达，已完成条目仍以服务器记录为准；续传时自动跳过')
      }
    } else {
      this.log('warning', '合并中断：恢复后从最后完整序号继续，已完成条目不重复')
    }
    for (const change of b.changes) if (change.status === 'applying') change.status = 'pending'
    this.persist()
  }

  abortPush() {
    this.abortRequested = true
  }

  // ---------- 冲突确认 ----------

  /** 采用现场版：以当前服务器实体版本为新依据追加一条改动，下批续推时落库。 */
  resolveKeepMine(seq: number) {
    const b = this.state.batch
    if (!b) return
    const change = b.changes.find((item) => item.seq === seq)
    if (!change || change.status !== 'conflict' || !change.conflict) return
    const op = change.op
    if (op.kind === 'sign') return
    const nextSeq = b.changes.reduce((max, item) => Math.max(max, item.seq), 0) + 1
    b.changes.push({
      seq: nextSeq,
      kind: change.kind,
      targetId: change.targetId,
      label: change.label,
      op: clone(op),
      entityRev: this.state.knownMeta[change.targetId]?.rev ?? change.conflict.entityRev,
      at: this.host.now(),
      author: this.state.author,
      status: 'pending',
      parentSeq: seq,
      detail: `冲突确认：保留现场版（对方 ${change.conflict.theirsAuthor} 的版本不覆盖）`,
    })
    change.status = 'dropped'
    change.detail = '已确认采用现场版，转序号 ' + nextSeq
    b.status = 'recording'
    this.log('info', `序号 ${seq} 确认采用现场版，登记为新序号 ${nextSeq}`)
    this.persist()
  }

  /** 采用服务器版：丢弃本机条目，把基线值取回工作区。 */
  resolveKeepTheirs(seq: number) {
    const b = this.state.batch
    if (!b) return
    const change = b.changes.find((item) => item.seq === seq)
    if (!change || change.status !== 'conflict' || !change.conflict) return
    change.status = 'dropped'
    change.detail = `已确认采用 ${change.conflict.theirsAuthor} 的服务器版`
    const theirs = change.conflict.theirs
    if (change.kind === 'device') {
      const index = this.state.working.devices.findIndex((item) => item.id === change.targetId)
      if (theirs) {
        if (index >= 0) this.state.working.devices[index] = clone(theirs as Device)
        else this.state.working.devices.push(clone(theirs as Device))
      } else if (index >= 0) this.state.working.devices.splice(index, 1)
    } else if (change.kind === 'rule' && change.op.kind !== 'rule-delete') {
      const index = this.state.working.rules.findIndex((item) => item.id === change.targetId)
      if (theirs) {
        if (index >= 0) this.state.working.rules[index] = clone(theirs as Rule)
        else this.state.working.rules.push(clone(theirs as Rule))
      } else if (index >= 0) this.state.working.rules.splice(index, 1)
    } else if (change.kind === 'rule') {
      // 本机删除、服务器保留：把服务器版取回
      if (theirs) {
        const index = this.state.working.rules.findIndex((item) => item.id === change.targetId)
        if (index === -1) this.state.working.rules.push(clone(theirs as Rule))
      }
    }
    const stillConflict = b.changes.some((item) => item.status === 'conflict')
    b.status = stillConflict ? 'conflicts' : 'recording'
    this.log('info', `序号 ${seq} 确认采用服务器版（${change.conflict.theirsAuthor}），现场条目丢弃`)
    this.persist()
  }

  // ---------- 落败处理 ----------

  async viewCurrent(): Promise<Snapshot> {
    return this.pull(false)
  }

  /** 落败方以当前版本为新基线重放本批：未冲突条目保持待推，已被对方改过的直接标记留验。 */
  rebaseBatch() {
    const b = this.state.batch
    if (!b || b.status !== 'lost') return
    if (!this.isOnline()) {
      this.log('warning', '仍处于断网状态，无法读取当前版本进行重放')
      return
    }
    const snap = this.server.snapshot()
    this.state.knownRev = snap.rev
    this.state.knownSigned = snap.signed
    this.state.knownSignedRevision = snap.signedRevision
    this.state.knownMeta = clone(snap.meta)
    b.openedAtRevision = snap.rev
    b.winner = undefined
    b.lastError = undefined
    let conflictCount = 0
    for (const change of b.changes) {
      if (change.status !== 'pending' || change.op.kind === 'sign') continue
      const meta = snap.meta[change.targetId]
      const theirs =
        change.kind === 'device'
          ? (snap.devices.find((item) => item.id === change.targetId) ?? null)
          : (snap.rules.find((item) => item.id === change.targetId) ?? null)
      if ((meta && meta.rev !== change.entityRev) || (!meta && change.entityRev !== 0) || (meta?.deleted && change.op.kind !== 'rule-delete')) {
        change.status = 'conflict'
        change.conflict = {
          targetId: change.targetId,
          label: change.label,
          reason: meta?.deleted ? 'deleted-elsewhere' : 'both-edited',
          mine: change.op.kind === 'rule-delete' ? null : change.op.entity,
          mineSummary: summaryOf(change.op),
          theirs,
          theirsSummary: theirs ? `当前 R${snap.rev} 版本（${meta?.author ?? '未知'}）` : '已在当前版本删除',
          theirsAuthor: meta?.author ?? '未知',
          theirsAt: meta?.at ?? 0,
          entityRev: meta?.rev ?? 0,
        }
        conflictCount += 1
      }
    }
    b.status = conflictCount > 0 ? 'conflicts' : 'recording'
    this.log(
      conflictCount > 0 ? 'warning' : 'success',
      `已按当前 R${snap.rev} 重放本批：${b.changes.filter((c) => c.status === 'pending').length} 条可直接推进，${conflictCount} 条留待确认`,
    )
    this.persist()
  }

  discardBatch() {
    const b = this.state.batch
    if (!b) return
    this.state.closed.unshift({ ...b, status: b.status === 'pushing' ? 'interrupted' : b.status })
    if (this.state.closed.length > 6) this.state.closed.length = 6
    this.state.batch = null
    this.state.working = {
      devices: clone(this.state.knownRev ? this.server.snapshot().devices : seedDevices),
      rules: clone(this.state.knownRev ? this.server.snapshot().rules : seedRules),
      signed: this.server.snapshot().signed,
    }
    this.log('info', `批次 ${b.id} 已丢弃，工作区恢复为当前基线 R${this.state.knownRev}`)
    this.persist()
  }

  private closeBatch() {
    const b = this.state.batch
    if (!b) return
    this.state.closed.unshift(clone(b))
    if (this.state.closed.length > 6) this.state.closed.length = 6
    this.state.batch = null
    const snap = this.server.snapshot()
    this.state.working = { devices: clone(snap.devices), rules: clone(snap.rules), signed: snap.signed }
    this.state.knownRev = snap.rev
    this.state.knownSigned = snap.signed
    this.state.knownSignedRevision = snap.signedRevision
    this.state.knownMeta = clone(snap.meta)
    this.persist()
  }

  /** 旧草稿缺版本：补登为首版后照常开批，差异按序号转成本机批次条目。 */
  migrateLegacyDraft(draft: LegacyDraft): boolean {
    if (this.state.batch) return false
    const base = this.server.snapshot()
    const batch = this.ensureBatch()
    batch.openedAtRevision = base.initialRev
    let count = 0

    const draftDevices = draft.devices ?? []
    for (const device of draftDevices) {
      const current = base.devices.find((item) => item.id === device.id)
      if (!current || JSON.stringify(current) !== JSON.stringify(device)) {
        const seq = batch.changes.length + 1
        batch.changes.push({
          seq,
          kind: 'device',
          targetId: device.id,
          label: device.id,
          op: { kind: 'device-upsert', entity: clone(device) },
          entityRev: base.meta[device.id]?.rev ?? 0,
          at: this.host.now(),
          author: this.state.author,
          status: 'pending',
          detail: '旧草稿迁移：缺打开版本，已补登首版',
        })
        count += 1
      }
    }
    const draftRules = draft.rules ?? []
    for (const rule of draftRules) {
      const current = base.rules.find((item) => item.id === rule.id)
      if (!current || JSON.stringify(current) !== JSON.stringify(rule)) {
        const seq = batch.changes.length + 1
        batch.changes.push({
          seq,
          kind: 'rule',
          targetId: rule.id,
          label: rule.id,
          op: { kind: 'rule-upsert', entity: clone(rule) },
          entityRev: base.meta[rule.id]?.rev ?? 0,
          at: this.host.now(),
          author: this.state.author,
          status: 'pending',
          detail: '旧草稿迁移：缺打开版本，已补登首版',
        })
        count += 1
      }
    }
    if (draft.locked) {
      const seq = batch.changes.length + 1
      batch.changes.push({
        seq,
        kind: 'sign',
        targetId: '签字状态',
        label: '签字状态',
        op: { kind: 'sign', signed: true },
        entityRev: 0,
        at: this.host.now(),
        author: this.state.author,
        status: 'pending',
        detail: '旧草稿迁移：原草稿为锁定状态',
      })
      count += 1
    }

    this.state.working = {
      devices: clone(draftDevices.length ? draftDevices : base.devices),
      rules: clone(draftRules.length ? draftRules : base.rules),
      signed: !!draft.locked,
    }
    this.log('info', `旧草稿缺少打开版本，已补登为首版 R${base.initialRev}，转出 ${count} 条有序改动，照常打开`)
    this.persist()
    return count > 0
  }
}

// ---------- 会话引导 ----------

export interface BootstrapResult {
  client: SyncClient
  migrated: boolean
}

export function bootstrapClient(host: Host, server: FieldServer, generateAuthor: () => string, generateSite: () => string): BootstrapResult {
  const existingRaw = host.getLocal(SESSION_KEY)
  if (existingRaw) {
    const state = JSON.parse(existingRaw) as SessionState
    const client = new SyncClient(host, server, state)
    client.log('info', `会话恢复：批次记录 ${state.batch?.changes.length ?? 0} 条，最后已知基线 R${state.knownRev}`)
    client.persist()
    return { client, migrated: false }
  }

  const clientId = host.uid()
  const snapshot = server.snapshot()
  const state = createSessionState(clientId, snapshot, generateAuthor(), generateSite())
  const client = new SyncClient(host, server, state)

  const legacyRaw = host.getShared(LEGACY_DRAFT_KEY)
  let migrated = false
  if (legacyRaw) {
    try {
      const draft = JSON.parse(legacyRaw) as LegacyDraft
      migrated = client.migrateLegacyDraft(draft)
    } catch {
      // 草稿损坏则按干净基线启动
    }
    host.removeShared(LEGACY_DRAFT_KEY)
  }
  client.persist()
  return { client, migrated }
}
