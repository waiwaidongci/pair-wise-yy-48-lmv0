// 浏览器互斥锁测试运行器。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { rmSync } from 'node:fs'

const outfile = new URL('../.tmp-hostlock-test.mjs', import.meta.url)
await build({
  entryPoints: [new URL('../src/sync/host-lock-test.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: outfile.pathname,
  logLevel: 'warning',
})

try {
  await import(pathToFileURL(outfile.pathname).href)
} finally {
  rmSync(outfile.pathname, { force: true })
}
