// @saturday/core —— 领域核心统一出口（零运行时依赖）
export { Material, MaterialService } from './material.mjs'
export {
  PotentialRegistry,
  NoCapableProviderError,
  LicenseUnavailableError,
  GranularityUnavailableError,
  PropertyUnsupportedError,
  BASELINE_PROPERTIES,
} from './potential.mjs'
export { makeCalculationRecord } from './calculation-record.mjs'
export {
  formationEnthalpy,
  convexHull,
  energyAboveHull,
  compositionFromNumbers,
  thermoError,
} from './thermo.mjs'
export { PrototypeLibResolver, StructureNotFoundError } from './structure-resolver.mjs'
export { Z, SYMBOL, composeFormula } from './elements.mjs'
