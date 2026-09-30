/* eslint-disable no-console */
// 浏览器自旋锁并发互斥测试：用最小 localStorage 平台 shim 加载真实 host.ts。
declare const process: { exit(code: number): never }

class StorageShim {
  private map = new Map<string, string>()
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value))
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
}

function addEventListener() {}

class BroadcastChannelShim {
  onmessage: ((event: { data: unknown }) => void) | null = null
  constructor(public name: string) {}
  postMessage() {}
  addEventListener() {}
  close() {}
}

const g = globalThis as unknown as Record<string, unknown>
g.localStorage = new StorageShim()
g.sessionStorage = new StorageShim()
g.window = { addEventListener, setTimeout: (fn: TimerHandler, ms: number) => setTimeout(fn, ms) }
g.addEventListener = addEventListener
g.BroadcastChannel = BroadcastChannelShim

async function main() {
  const { getBrowserHost } = await import('./host')
  const host = getBrowserHost()

  // 临界区互斥：并行启动 8 个临界区，每个内持有 active 计数，最大并发必须为 1
  let active = 0
  let maxActive = 0
  const tasks = Array.from({ length: 8 }, (_, i) =>
    host.withLock(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await host.sleep(5)
      active -= 1
      return i
    }),
  )
  const results = await Promise.all(tasks)
  const unique = new Set(results).size

  // 可重入/错误后释放：临界区抛错后下一个任务必须仍能拿到锁
  let released = false
  try {
    await host.withLock(() => {
      throw new Error('boom')
    })
  } catch {
    await host.withLock(() => {
      released = true
    })
  }

  const ok = maxActive === 1 && unique === 8 && released
  console.log(`最大并发: ${maxActive}（期望 1），完成 ${unique}/8，抛错后释放: ${released}`)
  console.log(ok ? '浏览器互斥锁测试通过 ✓' : '浏览器互斥锁测试失败 ✗')
  process.exit(ok ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
