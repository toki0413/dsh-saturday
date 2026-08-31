// 可用性预检演示：异构引擎生态的环境如实报告
// 对每个已注册引擎：可用性探测 + 运行时版本回读（实测态升级）——
//   可用者呈实测态（指纹 version 从声明态 'unknown' 盖章升级），
//   不可用者如实报告原因（注册 = 声明层，可用 = 运行时层，两层各自诚实）。
// 诚实声明：本演示输出依赖运行环境——同一份代码在装了/没装 LAMMPS/MACE 的
// 机器上给出不同的表，两种输出都是正确的（这正是预检的意义）。
// 运行：node demo-availability.mjs（ase 段依赖 Python sidecar）

import { Context } from '@deepseek-ai/cordis'
import plugin from './src/saturday.plugin.mjs'
import asePlugin from '@saturday/plugin-ase'
import { LammpsProvider } from '@saturday/plugin-lammps'
import { MaceProvider } from '@saturday/plugin-mace'

const ctx = new Context()
const fiber = await ctx.registry.plugin({
  name: 'saturday',
  apply: (ctx) => plugin.apply(ctx, {}),
})
const { potential } = fiber.store.saturday

// ase：自带 sidecar 插件（probeVersion 走自己的 sidecar 握手）
const aseFiber = await ctx.registry.plugin({
  name: 'saturday-ase',
  apply: (ctx) => asePlugin.apply(ctx, {}),
})
const aseProvider = aseFiber.store.saturdayAse.provider

// lammps/mace：批处理引擎——注册 = 声明层（M1 门禁注册即验 units/fingerprint），
// 可用性与版本探测真实环境（不缓存：环境可能在运行中变化，与 mace 预检同款纪律）
const lammps = new LammpsProvider()
const mace = new MaceProvider()
potential.register(lammps)
potential.register(mace)

console.log('── 可用性预检 + 实测态版本回读──\n')
const engines = [
  { name: 'emt-mock', probe: async () => null,
    note: 'mock 引擎：按定义不回读（身份即 LJ-mock，version 声明 unknown 本身就是诚实）' },
  { name: 'ase', probe: () => aseProvider.probeVersion(),
    note: '常驻 sidecar：握手回读 ase.__version__' },
  { name: 'lammps', probe: () => lammps.probeVersion(),
    note: '批处理二进制：解析 `lmp -h` 横幅' },
  { name: 'mace', probe: () => mace.probeVersion(),
    note: '一次性子进程：import mace; __version__' },
]

console.log('引擎        状态     指纹（归一形态）                          探测路径')
console.log('──────────  ───────  ──────────────────────────────────────  ──────────────────────────────')
for (const e of engines) {
  let version = null
  try { version = await e.probe() } catch { version = null }   // 探测失败不抛错：诚实降级
  if (version) potential.stampFingerprint(e.name, { version })  // 探测成功 → 盖章升级实测态
  const fp = potential.get(e.name)._fingerprint
  const status = e.name === 'emt-mock' ? '✓ mock' : version ? '✓ 可用' : '✗ 缺失'
  console.log(`${e.name.padEnd(10)}${status.padEnd(9)}${`${fp.software}/${fp.method}@${fp.version}`.padEnd(40)}${e.note}`)
}

console.log('\n诚实声明：')
console.log(' - 注册 ≠ 可用：不可用引擎不从注册表移除（声明层完整），使用时由 ENGINE_UNAVAILABLE')
console.log('   门禁拦下（绝不静默替换成别的引擎，契约 §4.2 路由契约）')
console.log(' - 探测失败不盖章：version 保持 "unknown" 声明态（不拿未知冒充已知）')
console.log(' - 指纹比较 version 维 unknown 通配：未探测不构成差异证据，但同源判定随附"含未验证维"声明')

await aseFiber.dispose()
await fiber.dispose()
