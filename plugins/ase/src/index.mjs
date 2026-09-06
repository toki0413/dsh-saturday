// @toki0413/plugin-ase —— 通用 ASE 计算器引擎插件（契约 §4.2）
// 数据面自带：插件携带自己的 Python sidecar（python-sidecar/ase_calc.py），
// 经 @toki0413/python-bridge 通用客户端挂接——薄插件自带数据平面的样板。

import { fileURLToPath } from 'node:url'
import { createCordisAdapter } from '@toki0413/kernel'
import { PythonBridge } from '@toki0413/python-bridge'
import { AseProvider, EngineUnavailableError } from './ase-provider.mjs'

export { AseProvider, EngineUnavailableError } from './ase-provider.mjs'

const SIDECAR = fileURLToPath(new URL('../python-sidecar/ase_calc.py', import.meta.url))

export default {
  name: 'saturday-ase',

  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)

    const potential = rt.getService('potential')
    if (!potential) {
      throw new Error('plugin-ase requires service "potential" (mount the saturday core plugin first)')
    }

    // 注入桥（测试用）优先；默认起自己的 sidecar
    const bridge = config.bridge ?? new PythonBridge({ sidecar: config.sidecar ?? SIDECAR, python: config.python })
    if (!config.bridge) await bridge.connect()

    // 挂载即校验请求的计算器在 sidecar 清单内（握手如实上报可构造清单）：
    // python 在场但缺 ASE 时清单为空——挂载显式失败而非首次真物理调用才爆，
    // 调用方（演示/测试）按同一契约分支（契约 §4.2：显式失败，绝不静默替换）
    const requested = config.calculator ?? 'lj'
    if (!config.bridge && !bridge.sidecarInfo?.calculators?.includes(requested)) {
      await bridge.disconnect().catch(() => {})
      throw new EngineUnavailableError(requested,
        `sidecar reports no constructable calculators (ASE missing: ${JSON.stringify(bridge.sidecarInfo?.calculators ?? [])})`)
    }

    const provider = new AseProvider({
      bridge,
      calculator: config.calculator,
      calculatorParams: config.calculatorParams,
    })

    rt.effect(() => {
      potential.register(provider)
      return () => potential.unregister(provider.name)
    }, 'ase-provider')

    // sidecar 生命周期绑定 fiber（自带桥时才由本插件负责断开）
    if (!config.bridge) rt.effect(() => () => bridge.disconnect(), 'ase-sidecar')

    ctx.fiber.store.saturdayAse = { provider, bridge }
  },
}
