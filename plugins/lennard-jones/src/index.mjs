// @saturday/plugin-lj —— 零依赖纯 JS Lennard-Jones 引擎插件（契约 §4.2）
// 数据面自带（进程内，无任何外部依赖）：开箱即用路径的引擎实体——
// 任何装了 Node 的环境都能跑通弛豫/筛选/自由能/遍历对账全链路。
// 物理档位是玩具势（manifest 如实声明），精度需求升级时换装
// ASE/LAMMPS/MACE 引擎（能力路由），本插件与它们并列注册互不冲突。

import { createCordisAdapter } from '@saturday/kernel'
import { LjProvider } from './lj-provider.mjs'

export { LjProvider } from './lj-provider.mjs'
export {
  LJ_PARAMS, ljCalculate, ljRelax, ljMd, ljHarmonic, ljReferenceEnergy,
  LjElementUnsupportedError,
} from './lj-engine.mjs'

export default {
  name: 'saturday-lj',

  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)

    const potential = rt.getService('potential')
    if (!potential) {
      throw new Error('plugin-lj requires service "potential" (mount the saturday core plugin first)')
    }

    const provider = new LjProvider(config)

    rt.effect(() => {
      potential.register(provider)
      return () => potential.unregister(provider.name)
    }, 'lj-provider')

    ctx.fiber.store.saturdayLj = { rt, provider }
  },
}
