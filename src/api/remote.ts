import { INITIAL_REVISION, seedDevices, seedRules, type Device, type Rule } from '../stores/seed'

/**
 * 远端基线（服务器侧）状态。
 * 用 localStorage 模拟共享的服务器基线，BroadcastChannel 模拟跨窗口通知。
 */
export type RemoteState = {
  revision: number
  devices: Device[]
  rules: Rule[]
  locked: boolean
  /** 已推进的批次 id 列表 —— 同一批次只允许一份推进 */
  appliedBatchIds: string[]
  lastBatchId: string | null
  updatedAt: number
}

const REMOTE_KEY = 'fire-linkage-remote-v1'
const CHANNEL_NAME = 'fire-linkage-sync'

function seedRemote(): RemoteState {
  return {
    revision: INITIAL_REVISION,
    devices: structuredClone(seedDevices),
    rules: structuredClone(seedRules),
    locked: false,
    appliedBatchIds: [],
    lastBatchId: null,
    updatedAt: Date.now(),
  }
}

export function fetchRemote(): RemoteState {
  try {
    const raw = localStorage.getItem(REMOTE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<RemoteState>
      const seeded = seedRemote()
      return {
        ...seeded,
        ...parsed,
        devices: parsed.devices ?? seeded.devices,
        rules: parsed.rules ?? seeded.rules,
        appliedBatchIds: parsed.appliedBatchIds ?? [],
        lastBatchId: parsed.lastBatchId ?? null,
      }
    }
  } catch { /* 草稿损坏时回退到首版基线 */ }
  const seeded = seedRemote()
  localStorage.setItem(REMOTE_KEY, JSON.stringify(seeded))
  return seeded
}

function writeRemote(remote: RemoteState) {
  remote.updatedAt = Date.now()
  localStorage.setItem(REMOTE_KEY, JSON.stringify(remote))
  try {
    syncChannel.postMessage({ type: 'remote-updated', revision: remote.revision, lastBatchId: remote.lastBatchId })
  } catch { /* 广播不可用时忽略 */ }
}

export type ClaimResult =
  | { ok: true; remote: RemoteState }
  | { ok: false; reason: 'already-advanced'; currentVersion: number; conflictObject: string; remote: RemoteState }

/**
 * 批次认领 + 落库。原子操作（localStorage 同步读写），
 * 同一批次 id 只允许一份推进；落败方拿到当前版本和冲突对象。
 */
export function claimAndApply(batchId: string, merged: { devices: Device[]; rules: Rule[]; locked: boolean }): ClaimResult {
  const remote = fetchRemote()
  if (remote.appliedBatchIds.includes(batchId)) {
    return {
      ok: false,
      reason: 'already-advanced',
      currentVersion: remote.revision,
      conflictObject: remote.lastBatchId ?? batchId,
      remote,
    }
  }
  remote.appliedBatchIds.push(batchId)
  remote.lastBatchId = batchId
  remote.devices = merged.devices
  remote.rules = merged.rules
  remote.locked = merged.locked
  remote.revision += 1
  writeRemote(remote)
  return { ok: true, remote }
}

/** 冲突解决后直接写回远端（不再认领批次），并前进版本。 */
export function saveRemote(remote: RemoteState): RemoteState {
  remote.revision += 1
  writeRemote(remote)
  return remote
}

/** 演示用：模拟另一窗口推进了基线（改了 R-002 延时、R-005 优先级）。 */
export function simulateRemoteAdvance(): RemoteState {
  const remote = fetchRemote()
  const target = remote.rules.find((rule) => rule.id === 'R-002')
  if (target) target.delay = Math.min(target.delay + 5, 60)
  const target2 = remote.rules.find((rule) => rule.id === 'R-005')
  if (target2) target2.priority = target2.priority === 1 ? 2 : 1
  remote.revision += 1
  writeRemote(remote)
  return remote
}

export function resetRemote(): RemoteState {
  const seeded = seedRemote()
  writeRemote(seeded)
  return seeded
}

export const syncChannel = new BroadcastChannel(CHANNEL_NAME)
