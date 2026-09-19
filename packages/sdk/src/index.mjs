// @toki0413/plugin-sdk —— 引擎插件脚手架。作者填一份描述符 → 生成过契约/conformance 的引擎插件包，
// 不必手写 provider（复用 @toki0413/core/descriptor-provider + codecs + conformance）。
export {
  engineDescriptorTemplate, enginePluginFiles,
} from './scaffold.mjs'
export { writePluginScaffold } from './cli.mjs'
