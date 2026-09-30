// Node 自测用内存宿主：共享存储模拟 localStorage，本地存储模拟 sessionStorage，
// withLock 串行执行，sleep 用虚拟时间。
import { type BroadcastMessage, type Host } from './core'

export interface MemoryClient {
  host: MemoryHost
}

export class MemoryHost implements Host {
  private static nextId = 1
  shared: Map<string, string>
  local: Map<string, string>
  handlers: Array<(message: BroadcastMessage) => void> = []
  label: string
  onSleep?: () => void

  constructor(shared?: Map<string, string>, label = 'host') {
    this.shared = shared ?? new Map()
    this.local = new Map()
    this.label = label
  }

  now() {
    return Date.now()
  }

  uid() {
    return `uid-${MemoryHost.nextId++}-${Math.random().toString(36).slice(2, 8)}`
  }

  async sleep(ms: number) {
    // 测试中重放节流不真实等待；允许用 onSleep 在每个条目后注入中断
    this.onSleep?.()
    if (ms > 500) await Promise.resolve()
  }

  getShared(key: string) {
    return this.shared.has(key) ? this.shared.get(key)! : null
  }

  setShared(key: string, value: string) {
    this.shared.set(key, value)
  }

  removeShared(key: string) {
    this.shared.delete(key)
  }

  getLocal(key: string) {
    return this.local.has(key) ? this.local.get(key)! : null
  }

  setLocal(key: string, value: string) {
    this.local.set(key, value)
  }

  removeLocal(key: string) {
    this.local.delete(key)
  }

  async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    return fn()
  }

  broadcast(message: BroadcastMessage) {
    for (const handler of this.handlers) handler(message)
  }

  onBroadcast(handler: (message: BroadcastMessage) => void) {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter((item) => item !== handler)
    }
  }
}
