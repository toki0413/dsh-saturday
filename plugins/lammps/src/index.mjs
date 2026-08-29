// @saturday/plugin-lammps —— LAMMPS 引擎插件（契约 §4.2）
// 薄插件：只把 LammpsProvider 注册进核心插件的 PotentialRegistry。
// 注册即 effect：卸载时注销，激活指针若指向本引擎则自动重置。

import { createCordisAdapter } from '@saturday/kernel'
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

    rt.effect(() => {
      potential.register(provider)
      return () => potential.unregister(provider.name)
    }, 'lammps-provider')

    ctx.fiber.store.saturdayLammps = { provider }
  },
}
