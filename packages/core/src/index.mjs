// @saturday/core —— 领域核心统一出口（零运行时依赖）
export { Material, MaterialService } from './material.mjs'
export {
  PotentialRegistry,
  NoCapableProviderError,
  LicenseUnavailableError,
  GranularityUnavailableError,
} from './potential.mjs'
export { PrototypeLibResolver, StructureNotFoundError } from './structure-resolver.mjs'
export { Z, SYMBOL, composeFormula } from './elements.mjs'
