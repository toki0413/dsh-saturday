// @toki0413/plugin-mace —— MACE（mace-torch）ML 势引擎插件（契约 §4.2）
// 薄插件：只把 MaceProvider 注册进核心插件的 PotentialRegistry。
// 注册即 effect：卸载时注销，激活指针若指向本引擎则自动重置。

import { createCordisAdapter } from '@toki0413/kernel'
import { MaceProvider } from './mace-provider.mjs'

export { MaceProvider, EngineUnavailableError } from './mace-provider.mjs'

export default {
  name: 'saturday-mace',

  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)

    // 引擎插件必须挂到已有注册表上：缺服务即挂载失败（契约 §2"失败即不挂载"）
    const potential = rt.getService('potential')
    if (!potential) {
      throw new Error('plugin-mace requires service "potential" (mount the saturday core plugin first)')
    }

    const provider = new MaceProvider({
      model: config.model,
      python: config.python,
      spawnImpl: config.spawnImpl,
      checkImpl: config.checkImpl,
      runImpl: config.runImpl,
    })

    rt.effect(() => {
      potential.register(provider)
      return () => potential.unregister(provider.name)
    }, 'mace-provider')

    ctx.fiber.store.saturdayMace = { provider }
  },
}
