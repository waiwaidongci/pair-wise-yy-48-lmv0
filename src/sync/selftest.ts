/* eslint-disable no-console */
// 现场批次交接内核自测：node 下经 esbuild 转译后直接运行。
declare const process: { exit(code: number): never }
import {
  bootstrapClient,
  FieldServer,
  seedRules,
  SyncClient,
  type LegacyDraft,
  type Rule,
} from './core'
import { MemoryHost as MemoryHostRef } from './memory-host'

let passed = 0
let failed = 0

function assert(condition: unknown, message: string) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${message}`)
  } else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

function makePair(shared: Map<string, string>, label: string, author: string, site: string) {
  const host = new MemoryHostRef(shared, label)
  const server = new FieldServer(host)
  const { client } = bootstrapClient(host, server, () => author, () => site)
  client.start()
  return { host, server, client }
}

function findRule(client: SyncClient, id: string): Rule {
  const rule = client.state.working.rules.find((item) => item.id === id)
  if (!rule) throw new Error(`missing ${id}`)
  return rule
}

async function scenario1_fastForward() {
  console.log('\n[1] 断网记录改动，恢复后基线未变 → 整批快进')
  const shared = new Map<string, string>()
  const a = makePair(shared, 'A', '夜班-张工', '1F 现场')
  a.client.setLocalOffline(true)
  a.client.updateRule('R-001', { delay: 12 })
  a.client.updateRule('R-002', { enabled: false })
  a.client.addRule()
  const batch = a.client.state.batch!
  assert(batch.openedAtRevision === 8, `打开时版本记为 R8（实际 R${batch.openedAtRevision}）`)
  assert(batch.changes.length === 3, `按序号记录 3 条改动（实际 ${batch.changes.length}）`)
  assert(batch.changes[0].seq === 1 && batch.changes[2].seq === 3, '序号连续 1..3')
  assert(a.client.server.snapshot().rev === 8, '断网期间服务器基线保持 R8')

  a.client.setLocalOffline(false)
  const strategy = a.client.strategy()
  assert(strategy.kind === 'fast-forward', `策略为整批快进（实际 ${strategy.kind}）`)
  await a.client.push()
  const snap = a.client.server.snapshot()
  assert(snap.rev === 9, `整批推进后基线前进到 R9（实际 R${snap.rev}）`)
  assert(a.client.state.batch === null, '推进成功后批次归档，工作区回到当前基线')
  assert(snap.rules.find((r) => r.id === 'R-001')!.delay === 12, 'R-001 延时 12 已落库')
  assert(snap.rules.find((r) => r.id === 'R-002')!.enabled === false, 'R-002 停用已落库')
  assert(snap.meta['R-001'].rev === 2 && snap.meta['R-001'].author === '夜班-张工', '实体版本号随改动前进并记录作者')
}

async function scenario2_replayNoConflict() {
  console.log('\n[2] 基线已被对侧推进 → 逐条重放，未同改条目落库')
  const shared = new Map<string, string>()
  const a = makePair(shared, 'A', '夜班-李工', '2F 现场')
  a.client.setLocalOffline(true)
  a.client.updateRule('R-001', { delay: 20 })

  // 对侧窗口在服务器上推进了另一条规则
  a.server.remoteRulePatch('R-002', { interlock: '排烟风机运行确认' })
  a.client.setLocalOffline(false)
  await a.client.pull()
  assert(a.client.state.knownRev === 9, `看到基线已前进到 R9（实际 R${a.client.state.knownRev}）`)
  assert(a.client.strategy().kind === 'replay', '策略切换为逐条重放')

  await a.client.push()
  const snap = a.client.server.snapshot()
  assert(snap.rev === 10, `重放落库后收口到 R10（实际 R${snap.rev}）`)
  assert(snap.rules.find((r) => r.id === 'R-001')!.delay === 20, '本机 R-001 改动重放成功')
  assert(snap.rules.find((r) => r.id === 'R-002')!.interlock === '排烟风机运行确认', '对侧 R-002 改动保留')
  assert(a.client.state.batch === null, '批次归档')
}

async function scenario3_bothEditedConflict() {
  console.log('\n[3] 双方都改同一条 → 留待确认，不互相覆盖')
  const shared = new Map<string, string>()
  const a = makePair(shared, 'A', '夜班-李工', '2F 现场')
  a.client.setLocalOffline(true)
  a.client.updateRule('R-001', { delay: 30 })
  a.client.updateRule('R-003', { enabled: false })
  a.server.remoteRulePatch('R-001', { priority: 3 }, '暖通专业-王工')
  a.client.setLocalOffline(false)
  await a.client.pull()

  await a.client.push()
  const batch = a.client.state.batch!
  const conflict = batch.changes.find((c) => c.targetId === 'R-001')
  const applied = batch.changes.find((c) => c.targetId === 'R-003')
  assert(batch.status === 'conflicts', `批次状态为冲突留验（实际 ${batch.status}）`)
  assert(conflict?.status === 'conflict', '同改的 R-001 留待确认')
  assert(conflict?.conflict?.theirsSummary.includes('暖通专业-王工') || conflict?.conflict?.theirsAuthor === '暖通专业-王工', '冲突对象标明对侧作者')
  assert(conflict?.conflict?.theirs && 'priority' in conflict.conflict.theirs && conflict.conflict.theirs.priority === 3, '保留对侧版本供比对')
  assert(applied?.status === 'applied', '未同改的 R-003 正常落库')
  const snapMid = a.client.server.snapshot()
  assert(snapMid.rules.find((r) => r.id === 'R-001')!.delay !== 30, '冲突条目未覆盖对侧值')
  assert(snapMid.rules.find((r) => r.id === 'R-001')!.priority === 3, '服务器仍为对侧版本')

  // 确认采用现场版：以新版本号为依据登记新序号，再次推进
  a.client.resolveKeepMine(conflict!.seq)
  const follow = batch.changes.at(-1)!
  assert(follow.status === 'pending' && follow.parentSeq === conflict!.seq, `现场版登记为新序号 ${follow.seq} 并挂接冲突序号`)
  assert(follow.entityRev === snapMid.meta['R-001'].rev, '新序号按当前实体版本落笔')
  await a.client.push()
  const snapEnd = a.client.server.snapshot()
  assert(snapEnd.rules.find((r) => r.id === 'R-001')!.delay === 30, '确认后现场版落库')
  assert(snapEnd.rules.find((r) => r.id === 'R-001')!.priority === 1, '现场版为整实体替换，按现场实体落库（差异已在冲突面板逐项呈现给确认人）')
  assert(a.client.state.batch === null, '全部收口后批次归档')
}

async function scenario4_signedProtection() {
  console.log('\n[4] 签字基线保护：不得覆盖签字内容')
  const shared = new Map<string, string>()
  const a = makePair(shared, 'A', '夜班-赵工', '1F 现场')
  a.client.setLocalOffline(true)
  a.client.updateRule('R-001', { delay: 40 })

  // 对侧在服务器签字
  a.server.remoteSign(true, '审阅人-周工')
  a.client.setLocalOffline(false)
  await a.client.pull()
  assert(a.client.state.knownSigned === true, '看到基线已签字')
  await a.client.push()
  const batch = a.client.state.batch!
  assert(batch.status === 'blocked', `推进被签字阻断（实际 ${batch.status}）`)
  assert(a.client.server.snapshot().rules.find((r) => r.id === 'R-001')!.delay !== 40, '签字内容未被覆盖')

  // 解锁后原样批次可以继续
  a.server.remoteSign(false)
  await a.client.pull()
  await a.client.push()
  assert(a.client.server.snapshot().rules.find((r) => r.id === 'R-001')!.delay === 40, '解锁后原批次成功落库')

  // 本机签字工作区：签字批次先推进归档，之后拒绝再记录改动
  const b = makePair(shared, 'B', '夜班-赵工', '1F 现场')
  b.client.signBaseline()
  await b.client.push()
  assert(b.client.state.working.signed, '本机签字动作已推进并归档')
  assert(b.client.state.closed[0]?.changes.some((c) => c.op.kind === 'sign'), '签字动作保留在归档批次记录中')
  b.client.updateRule('R-002', { delay: 5 })
  assert(b.client.state.batch === null, '签字工作区不接受新改动')
}

async function scenario5_concurrentSameBatch() {
  console.log('\n[5] 两个窗口同时提交同一批 → 只一份推进，落败方保留原批并看到当前版本/冲突对象')
  const shared = new Map<string, string>()
  const a = makePair(shared, 'A', '窗口甲-孙工', '1F')
  const b = makePair(shared, 'B', '窗口乙-钱工', '2F')

  a.client.updateRule('R-002', { delay: 11 })
  b.client.updateRule('R-003', { delay: 22 })
  b.client.updateRule('R-002', { priority: 3 }) // 与甲同改一条

  // 甲先占住推进；乙在甲占用期间提交，必须落败。甲随后落库，模拟“同时只允许一份推进”
  const beginA = await a.server.beginPush({ batchId: a.client.state.batch!.id, clientId: a.client.state.clientId, author: '窗口甲-孙工', baseRevision: 8 })
  const beginB = await a.server.beginPush({ batchId: b.client.state.batch!.id, clientId: b.client.state.clientId, author: '窗口乙-钱工', baseRevision: 8 })
  assert(beginA.outcome === 'fast-forward', '甲方获得推进权')
  assert(beginB.outcome === 'lost' && beginB.winner.author === '窗口甲-孙工', '乙方落败且能看到获胜对象')

  // 乙方通过正常入口再推一次，落败结果写入自己保留的原批次
  await b.client.push()
  assert(b.client.state.batch?.status === 'lost', `乙方批次保留为落败状态（实际 ${b.client.state.batch?.status}）`)
  assert(b.client.state.batch?.winner?.author === '窗口甲-孙工', '落败批次记录获胜方与批次号')
  const current = await b.client.viewCurrent()
  assert(current.rev === 8, '占用尚未提交时当前版本仍为 R8，落败方只看到在途的获胜对象')

  await a.server.commitFastForward((beginA as { token: string }).token, a.client.state.batch!.changes.filter((c) => c.status === 'pending'))
  for (const c of a.client.state.batch!.changes) c.status = 'applied'
  a.client.state.batch!.status = 'pushed'
  a.client.state.batch = null
  await a.client.pull(true)
  const current2 = await b.client.viewCurrent()
  assert(current2.rev === 9 && current2.rules.find((r) => r.id === 'R-002')!.delay === 11, '获胜方落库后，落败方可查看当前版本内容')

  // 乙方以当前版本重放：同改条目留验，独立条目可继续
  b.client.rebaseBatch()
  const conflict = b.client.state.batch!.changes.find((c) => c.targetId === 'R-002')
  const clean = b.client.state.batch!.changes.find((c) => c.targetId === 'R-003')
  assert(conflict?.status === 'conflict', '与获胜方同改的 R-002 留待确认')
  assert(clean?.status === 'pending', '未同改的 R-003 继续待推')
  assert(conflict?.conflict?.theirsAuthor === '窗口甲-孙工', '冲突对象即获胜方')
  b.client.resolveKeepTheirs(conflict!.seq)
  await b.client.push()
  const snap = b.client.server.snapshot()
  assert(snap.rules.find((r) => r.id === 'R-003')!.delay === 22, '乙方独立改动随后推进成功')
  assert(snap.rules.find((r) => r.id === 'R-002')!.delay === 11, '采用甲方版本，乙方未覆盖')
}

async function scenario6_interruptedResume() {
  console.log('\n[6] 合并中断 → 从最后完整序号继续，已完成条目不重复')
  const shared = new Map<string, string>()
  const a = makePair(shared, 'A', '夜班-李工', '2F 现场')
  a.client.setLocalOffline(true)
  for (const id of ['R-001', 'R-002', 'R-003', 'R-004', 'R-005']) {
    a.client.updateRule(id, { delay: 7 })
  }
  // 对侧改过 R-006（不冲突，只为让基线前进进入重放）
  a.server.remoteRulePatch('R-006', { interlock: '电梯反馈到位' })
  a.client.setLocalOffline(false)
  await a.client.pull()

  let commits = 0
  a.host.onSleep = () => {
    commits += 1
    if (commits === 3) a.client.abortPush()
  }
  await a.client.push()
  const batch = a.client.state.batch!
  assert(batch.status === 'interrupted', `在第 3 条后中断（实际状态 ${batch.status}）`)
  const applied = batch.changes.filter((c) => c.status === 'applied').map((c) => c.seq)
  assert(JSON.stringify(applied) === JSON.stringify([1, 2, 3]), `已完成序号为 1,2,3（实际 ${applied.join(',')}）`)
  assert(batch.changes[3].status === 'pending' && batch.changes[4].status === 'pending', '第 4、5 条回到待推')
  const snapMid = a.client.server.snapshot()
  assert(snapMid.rules.find((r) => r.id === 'R-001')!.delay === 7 && snapMid.rules.find((r) => r.id === 'R-005')!.delay !== 7, '中断点固化：前 3 条落库，后 2 条未落')

  // 续传
  a.host.onSleep = undefined
  await a.client.push()
  const snapEnd = a.client.server.snapshot()
  assert(['R-004', 'R-005'].every((id) => snapEnd.rules.find((r) => r.id === id)!.delay === 7), '剩余条目续传落库')
  const r1Events = snapEnd.history.filter((h) => h.targetId === 'R-001' && h.summary.includes('R-001')).length
  assert(r1Events === 1, `R-001 只落库一次（实际历史 ${r1Events} 条）`)
  assert(a.client.state.batch === null, '续传完成后批次归档')
}

async function scenario7_legacyDraftMigration() {
  console.log('\n[7] 旧草稿缺版本 → 补齐首版后照常打开')
  const shared = new Map<string, string>()
  const legacy: LegacyDraft = {
    rules: seedRules.map((rule) => (rule.id === 'R-001' ? { ...rule, delay: 99 } : rule)),
    locked: false,
    // 故意不给 revision 字段
  }
  shared.set('fire-linkage-draft-v1', JSON.stringify(legacy))

  const host = new MemoryHostRef(shared, 'A')
  const server = new FieldServer(host)
  const { client, migrated } = bootstrapClient(host, server, () => '夜班-新窗口', () => '1F')
  assert(migrated === true, '识别到旧草稿并迁移')
  const batch = client.state.batch!
  assert(batch.openedAtRevision === server.snapshot().initialRev, `缺版本旧草稿补登首版 R${server.snapshot().initialRev}（实际 R${batch.openedAtRevision}）`)
  assert(batch.changes.length === 1 && batch.changes[0].targetId === 'R-001', '差异转出 1 条有序改动')
  assert(batch.changes[0].detail?.includes('补登首版'), '条目标注迁移来源')
  assert(client.state.working.rules.find((r) => r.id === 'R-001')!.delay === 99, '草稿内容照常打开')
  assert(host.getShared('fire-linkage-draft-v1') === null, '旧草稿键已回收')
  await client.push()
  assert(client.server.snapshot().rules.find((r) => r.id === 'R-001')!.delay === 99, '迁移批次正常推进')
}

async function scenario8_coalesceAndDeviceConflict() {
  console.log('\n[8] 连续编辑合并序号；设备改动同样参与重放冲突')
  const shared = new Map<string, string>()
  const a = makePair(shared, 'A', '夜班-冯工', '1F')
  a.client.setLocalOffline(true)
  a.client.updateRule('R-001', { delay: 1 })
  a.client.updateRule('R-001', { delay: 2 })
  a.client.updateRule('R-001', { priority: 3 })
  assert(a.client.state.batch!.changes.length === 1, '同一对象连续编辑合并为 1 个序号')
  assert(findRule(a.client, 'R-001').delay === 2 && findRule(a.client, 'R-001').priority === 3, '工作区保留最终值')

  a.client.addDevice({ id: 'D-03-01', name: '三层感烟 01', type: '感烟探测器', floor: '3F', zone: 'C 区', address: '3-C-01-01' })
  a.server.remoteDevicePatch('D-01-01', { address: '1-A-01-99' }, '消防电专业')
  a.client.setLocalOffline(false)
  await a.client.pull()
  // 本机没有改 D-01-01，所以无冲突；设备新增可落库
  await a.client.push()
  const snap = a.client.server.snapshot()
  assert(snap.devices.find((d) => d.id === 'D-03-01') !== undefined, '新设备随批落库')
  assert(snap.devices.find((d) => d.id === 'D-01-01')!.address === '1-A-01-99', '对侧设备改动保留')
  assert(snap.rules.find((r) => r.id === 'R-001')!.priority === 3, '合并后的最终规则值落库')
}

async function main() {
  console.log('== 现场批次交接内核自测 ==')
  await scenario1_fastForward()
  await scenario2_replayNoConflict()
  await scenario3_bothEditedConflict()
  await scenario4_signedProtection()
  await scenario5_concurrentSameBatch()
  await scenario6_interruptedResume()
  await scenario7_legacyDraftMigration()
  await scenario8_coalesceAndDeviceConflict()
  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

// 仅为类型导入占位，实际从下方 re-export 模块取值
export {}
