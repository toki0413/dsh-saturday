// @saturday/plugin-ergodic —— 遍历对账工作流插件（契约 §4.5 oracle 条款）
// 给定参考结构 + 采样器 + 能量函数（引擎）：
//   系综侧 = 采样候选在同一能量函数下的逐点单点；
//   时间平均侧 = 同一能量函数、同一参考结构起点的恒温 MD；
//   两侧均值在容差内对账，判定连同采样器似然声明的强度一起诚实返回。
// 对账工具落在工作流层，不进采样器本体（§4.5）。

import { createCordisAdapter } from '@saturday/kernel'
import { checkErgodic } from './ergodic.mjs'

export { checkErgodic, compareEnsembleToMD, ergodicVerdict, ergodicError } from './ergodic.mjs'

export default {
  name: 'saturday-ergodic',

  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)

    rt.registerTool({
      name: 'workflow.ergodic',
      description: '遍历对账（§4.5 oracle 条款）：采样候选的能量系综平均 对 ' +
                   '同一能量函数恒温 MD 的时间平均。判定强度取决于采样器的似然声明：' +
                   'likelihood: none 时为信息性量化，声明似然可求时构成对 Boltzmann 采样声明的直接检验。',
      parameters: {
        referenceId: { type: 'string', required: true, description: '参考结构材料 ID（MD 起点）' },
        n: { type: 'integer', default: 8, description: '采样候选数量（系综侧）' },
        seed: { type: 'integer', default: 1, description: '采样种子' },
        sigma: { type: 'number', default: 0.05, description: '微扰位移标准差（Å）' },
        engine: { type: 'string', default: 'auto', description: '能量函数（引擎名，须支持 calculate 与 md）' },
        temperatureK: { type: 'number', default: 300, description: 'MD 温度（K）' },
        mdSteps: { type: 'integer', default: 200, description: 'MD 步数' },
        dtFs: { type: 'number', default: 1, description: 'MD 时间步长（fs）' },
        mdSeed: { type: 'integer', description: 'MD 随机种子（确定性复现）' },
        tolerance: { type: 'number', default: 0.05, description: '均值差容差（eV）' },
      },
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(args) {
        // 服务依赖在调用时解析：缺依赖显式报错，不静默降级（契约 §2）
        const materialService = rt.getService('material')
        const potential = rt.getService('potential')
        const sampler = rt.getService('sampler/reference-perturbation')
        if (!materialService || !potential || !sampler) {
          throw new Error('workflow.ergodic requires services "material", "potential" and ' +
                          '"sampler/reference-perturbation" (mount the saturday core and ' +
                          'sampler-perturb plugins first)')
        }
        const reference = await materialService.get(args.referenceId)
        const candidates = await sampler.sample(
          { reference },
          { n: args.n, seed: args.seed, sigma: args.sigma },
        )
        return checkErgodic({
          reference,
          candidates,
          samplerManifest: sampler.manifest,
          samplerName: sampler.name,
          potential,
          engine: args.engine,
          mdParams: {
            temperatureK: args.temperatureK,
            steps: args.mdSteps,
            dtFs: args.dtFs,
            sampleEvery: args.sampleEvery,
            seed: args.mdSeed,
          },
          tolerance: args.tolerance,
          emit: (type, event) => rt.emit(type, event),
        })
      },
    })

    ctx.fiber.store.saturdayErgodic = { rt }
  },
}
