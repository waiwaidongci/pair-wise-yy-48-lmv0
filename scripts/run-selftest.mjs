// 将 TS 自测打包成临时 ESM 后用 Node 运行。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { rmSync } from 'node:fs'

const outfile = new URL('../.tmp-selftest.mjs', import.meta.url)
await build({
  entryPoints: [new URL('../src/sync/selftest.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: outfile.pathname,
  sourcemap: 'inline',
  logLevel: 'warning',
})

try {
  await import(pathToFileURL(outfile.pathname).href)
} finally {
  rmSync(outfile.pathname, { force: true })
}
