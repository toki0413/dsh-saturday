// @toki0413/core —— 领域核心统一出口（零运行时依赖）
export { Material, MaterialService } from './material.mjs'
export {
  PotentialRegistry,
  engineSourceId,
  NoCapableProviderError,
  LicenseUnavailableError,
  GranularityUnavailableError,
  PropertyUnsupportedError,
  BASELINE_PROPERTIES,
} from './potential.mjs'
export { JobLedger, jobError } from './jobs.mjs'
export { makeCalculationRecord } from './calculation-record.mjs'
export {
  formationEnthalpy,
  convexHull,
  energyAboveHull,
  multiConvexHull,
  energyAboveHullMulti,
  MULTI_HULL_MAX_SUBSETS,
  compositionFromNumbers,
  thermoError,
} from './thermo.mjs'
export { PrototypeLibResolver, StructureNotFoundError } from './structure-resolver.mjs'
export { Z, SYMBOL, composeFormula } from './elements.mjs'
export {
  unitsError,
  UNIT_WHITELIST,
  BASE_UNITS,
  assertValidUnit,
  unitConvert,
  assertSameUnits,
  validateEngineUnits,
  validateEngineFingerprint,
  fingerprintEqual,
} from './units.mjs'
