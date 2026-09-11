// @toki0413/plugin-lammps —— LAMMPS 引擎插件（契约 §4.2）
// 薄插件：只把 LammpsProvider 注册进核心插件的 PotentialRegistry。
// 注册即 effect：卸载时注销，激活指针若指向本引擎则自动重置。
// 挂载即探测（plugin-mace 先例）：环境不可用则不注册并显式报告，
// 避免 auto 路由在全量共置场景选中一个注定失败的引擎。

import { createCordisAdapter } from '@toki0413/kernel'
import { LammpsProvider } from './lammps-provider.mjs'

export { LammpsProvider, EngineUnavailableError, toLammpsData } from './lammps-provider.mjs'

export default {
  name: 'saturday-lammps',

  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)

    // 引擎插件必须挂到已有注册表上：缺服务即挂载失败（契约 §2"失败即不挂载"）
    const potential = rt.getService('potential')
    if (!potential) {
      throw new Error('plugin-lammps requires service "potential" (mount the saturday core plugin first)')
    }

    const provider = new LammpsProvider({
      binary: config.binary,
      potentialFile: config.potentialFile,
      spawnImpl: config.spawnImpl,
    })

    // 挂载即探测：势文件未配/二进制不可达则不注册（显式降级，报告如实；
    // 注入 checkImpl 供测试复用，skipProbe 供已验证环境跳过探测）
    const probe = config.skipProbe
      ? { ok: true }
      : config.checkImpl
        ? (await config.checkImpl() ? { ok: true } : { ok: false, reason: 'checkImpl returned falsy' })
        : await provider.probeAvailability()
    if (!probe.ok) {
      process.stderr.write(`[plugin-lammps] LAMMPS 环境不可用（${probe.reason}），跳过注册；relax 任务将由路由器降级到可用引擎\n`)
      ctx.fiber.store.saturdayLammps = { provider, registered: false }
      return
    }

    rt.effect(() => {
      potential.register(provider)
      return () => potential.unregister(provider.name)
    }, 'lammps-provider')

    ctx.fiber.store.saturdayLammps = { provider }
  },
}
