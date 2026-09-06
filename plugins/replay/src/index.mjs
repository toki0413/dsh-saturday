// @toki0413/plugin-replay —— Trajectory 回放插件（时间维可组合性的读侧）
// 瀑布事件流不可改、但可回放：把 append-only 轨迹读回来，
// 重建材料计算索引（谁算过什么、哪个引擎、最优能量）。
// 回放绝不重算物理——可逆的是研究决策，不是物理。
//
// 防回灌纪律：回放事件加 'replay/' 前缀，任何轨迹写入监听器
// （只监听 'saturday/simulation/converged'）不会把回放当新计算。

import { readFile } from 'node:fs/promises'
import { createCordisAdapter } from '@toki0413/kernel'
import { parseTrajectory, rebuildIndex, indexToSummary } from './replay.mjs'

export { parseTrajectory, rebuildIndex, indexToSummary } from './replay.mjs'

export default {
  name: 'saturday-replay',

  async apply(ctx, config = {}) {
    const rt = createCordisAdapter(ctx, config)

    rt.registerTool({
      name: 'trajectory.replay',
      description: '回放 Trajectory（append-only 事件流）：重建材料计算索引。' +
                   '可选把每条记录以 "saturday/replay/..." 事件重放给监听者。',
      parameters: {
        trajectoryPath: { type: 'string', description: '轨迹文件路径（默认本插件运行时配置）' },
        reemit: { type: 'boolean', description: '是否把记录重放为广播事件，默认 false' },
      },
      output: { type: 'object' },
      async execute(args) {
        const path = args.trajectoryPath ?? config.trajectoryPath
        if (!path) {
          throw new Error('trajectory.replay requires trajectoryPath ' +
                          '(argument or plugin config.trajectoryPath)')
        }
        const text = await readFile(path, 'utf8')
        const { records, skipped } = parseTrajectory(text)
        const index = rebuildIndex(records)

        if (args.reemit) {
          for (const record of records) {
            await rt.emit(`saturday/replay/${record.type ?? 'unknown'}`, record)
          }
        }

        return {
          replayed: records.length,
          skipped,
          materials: indexToSummary(index),
        }
      },
    })

    ctx.fiber.store.saturdayReplay = { rt }
  },
}
