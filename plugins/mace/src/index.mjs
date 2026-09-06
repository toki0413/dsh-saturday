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

    // 挂载即探测：环境不可用则不注册（显式降级——与 bridge 数据面回退同款：
    // 报告如实、engine.availability 可查；注册一个环境损坏的引擎会让 auto 路由
    // 在全量共置场景永远选中它然后失败）
    const probeOk = config.skipProbe ? true : await provider.probeModule()
    if (!probeOk) {
      process.stderr.write('[plugin-mace] mace-torch 环境不可用（python -c "import mace" 失败），跳过注册；relax 任务将由路由器降级到可用引擎\n')
      ctx.fiber.store.saturdayMace = { provider, registered: false }
      return
    }

    rt.effect(() => {
      potential.register(provider)
      return () => potential.unregister(provider.name)
    }, 'mace-provider')

    ctx.fiber.store.saturdayMace = { provider }
  },
}
