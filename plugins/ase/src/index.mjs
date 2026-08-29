// @saturday/plugin-ase —— 通用 ASE 计算器引擎插件（契约 §4.2）
// 数据面自带：插件携带自己的 Python sidecar（python-sidecar/ase_calc.py），
// 经 @saturday/python-bridge 通用客户端挂接——薄插件自带数据平面的样板。

import { fileURLToPath } from 'node:url'
import { createCordisAdapter } from '@saturday/kernel'
import { PythonBridge } from '@saturday/python-bridge'
import { AseProvider } from './ase-provider.mjs'

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
