// 测试启动器：用 esbuild 的 JS API 打包规则测试再执行。
// 不直接调 esbuild CLI，避免主包 bin 与当前平台不一致时无法启动。
const { buildSync } = require('esbuild')
const { execFileSync } = require('child_process')
const path = require('path')

const root = path.join(__dirname, '..')
const outfile = path.join(root, 'node_modules', '.tmp', 'communication-flow.test.mjs')

buildSync({
  entryPoints: [path.join(root, 'tests', 'communication-flow.test.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: { '@': path.join(root, 'src') },
  outfile,
})

execFileSync(process.execPath, [outfile], { stdio: 'inherit' })
