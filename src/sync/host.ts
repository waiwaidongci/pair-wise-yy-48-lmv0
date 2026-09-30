// 浏览器宿主：共享基线放 localStorage（跨窗口/标签页），本机批次放 sessionStorage
// （单窗口隔离，正好模拟两个夜班窗口各自持有原批次）。
import { type BroadcastMessage, type Host } from './core'

const LOCK_KEY = 'fire-linkage-lock'
const LOCK_TTL_MS = 2_500
const CHANNEL_NAME = 'fire-linkage-sync-channel'

function uid(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined
  if (cryptoObj && 'randomUUID' in cryptoObj) return cryptoObj.randomUUID()
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

class BrowserHost implements Host {
  private channel: BroadcastChannel | null = null
  private handlers = new Set<(message: BroadcastMessage) => void>()

  constructor() {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL_NAME)
      this.channel.onmessage = (event: MessageEvent<BroadcastMessage>) => {
        this.handlers.forEach((handler) => handler(event.data))
      }
    }
    // 兼容没有 BroadcastChannel 的环境：靠 storage 事件兜底
    window.addEventListener('storage', (event) => {
      if (event.key === 'fire-linkage-server-v2') {
        let revision = 0
        try {
          revision = (JSON.parse(event.newValue ?? '{}') as { rev?: number }).rev ?? 0
        } catch {
          revision = 0
        }
        this.handlers.forEach((handler) => handler({ type: 'server', revision, clientId: null }))
      } else if (event.key === 'fire-linkage-network') {
        this.handlers.forEach((handler) => handler({ type: 'network' }))
      }
    })
  }

  now() {
    return Date.now()
  }

  uid() {
    return uid()
  }

  sleep(ms: number) {
    return new Promise<void>((resolve) => window.setTimeout(resolve, ms))
  }

  getShared(key: string) {
    return localStorage.getItem(key)
  }

  setShared(key: string, value: string) {
    localStorage.setItem(key, value)
  }

  removeShared(key: string) {
    localStorage.removeItem(key)
  }

  getLocal(key: string) {
    return sessionStorage.getItem(key)
  }

  setLocal(key: string, value: string) {
    sessionStorage.setItem(key, value)
  }

  removeLocal(key: string) {
    sessionStorage.removeItem(key)
  }

  /** 跨窗口自旋互斥：localStorage 原子写 + 租约过期防死锁。 */
  async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const token = uid()
    let waited = 0
    for (;;) {
      const raw = localStorage.getItem(LOCK_KEY)
      let held = false
      if (raw) {
        try {
          const lock = JSON.parse(raw) as { token: string; at: number }
          held = Date.now() - lock.at < LOCK_TTL_MS
        } catch {
          held = false
        }
      }
      if (!held) {
        localStorage.setItem(LOCK_KEY, JSON.stringify({ token, at: Date.now() }))
        // 复查，避免两个窗口同时穿过空锁
        const checkRaw = localStorage.getItem(LOCK_KEY)
        try {
          const check = JSON.parse(checkRaw ?? '{}') as { token: string; at: number }
          if (check.token === token) break
        } catch {
          // 落到重试
        }
      }
      if (waited > 4_000) throw new Error('等待跨窗口互斥锁超时')
      await this.sleep(12)
      waited += 12
    }

    try {
      return await fn()
    } finally {
      try {
        const raw = localStorage.getItem(LOCK_KEY)
        if (raw) {
          const lock = JSON.parse(raw) as { token: string }
          if (lock.token === token) localStorage.removeItem(LOCK_KEY)
        }
      } catch {
        // 释放失败交给租约过期
      }
    }
  }

  broadcast(message: BroadcastMessage) {
    this.channel?.postMessage(message)
  }

  onBroadcast(handler: (message: BroadcastMessage) => void) {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }
}

let instance: BrowserHost | null = null

export function getBrowserHost(): BrowserHost {
  if (!instance) instance = new BrowserHost()
  return instance
}
