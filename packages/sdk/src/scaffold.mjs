// @toki0413/plugin-sdk 脚手架生成器（纯）——给一份引擎描述符，产出一个"作者只填 descriptor.mjs、
// 不写 provider 代码"的引擎插件包文件映射。生成的插件用 @toki0413/core/descriptor-provider 装配
// provider，静态 conformance 开箱即过；运行时 potentialProviderContract（需作者的真二进制/伪 stdout）
// 留注释指向 plugins/lammps 模板。写侧（落盘/CLI）在 cli.mjs；此处只产字符串，可确定性测。

function safeName(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name)) {
    throw Object.assign(new Error(`plugin name "${name}" must be lowercase kebab (a-z0-9-) (SDK_BAD_NAME)`), { code: 'SDK_BAD_NAME' })
  }
  return name
}

/** 起步描述符模板（作者改这些字段即可；inputFormat 需指向已注册 codec）。 */
export function engineDescriptorTemplate({ name, binary = name, marker = 'SATURDAY_ENERGY\\s+(-?\\d+(?:\\.\\d+)?)', inputFormat = 'xyz' } = {}) {
  if (!name) throw Object.assign(new Error('engineDescriptorTemplate requires name'), { code: 'SDK_BAD_NAME' })
  return {
    name, version: '0.1.0', displayName: name, binaryDefault: binary,
    manifest: {
      capabilities: [{ type: 'relax', accuracy: 0.5, speed: 0.5, cost: 0.5, maxAtoms: 1000 }],
      constraints: {}, eventGranularity: 'job',
      units: { energy: 'eV', length: 'Å', time: 'fs' },
      fingerprint: { software: name, method: 'TODO-describe-your-method', version: 'unknown' },
    },
    versionProbe: { args: ['--version'], regex: 'TODO-version-regex' },
    availability: { requireConfig: [] },
    structure: { inputFormat },
    run: { dataFile: 'in.dat', inputFile: 'run.in', args: [inputFormat === 'xyz' ? 'in.dat' : '-in', 'run.in'], template: 'TODO your input script; end with print "SATURDAY_ENERGY <value>"' },
    output: { energy: { name: 'energy', regex: marker } },
    result: { converged: true, nSteps: 0 },
  }
}

function genPackageJson(pkgName, name) {
  const pkg = {
    name: pkgName, version: '0.1.0',
    description: `${name} engine plugin — scaffolded by @toki0413/plugin-sdk (descriptor-driven, no hand-written provider).`,
    type: 'module', main: 'src/index.mjs',
    exports: { '.': './src/index.mjs' },
    scripts: { test: 'node --test "test/*.test.mjs"' },
    dependencies: { '@toki0413/core': '^0.3.0', '@toki0413/kernel': '^0.3.0' },
    files: ['src'], license: 'MIT',
  }
  return JSON.stringify(pkg, null, 2) + '\n'
}
function genDescriptor(descriptor) {
  return '// Edit THIS file to wrap your engine. Fields are consumed by @toki0413/core/descriptor-provider.\n'
    + 'export const ENGINE_DESCRIPTOR = ' + JSON.stringify(descriptor, null, 2) + '\n'
}
function genIndex(name) {
  const storeKey = 'saturday' + name.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase())
  const lines = [
    "// " + name + " engine plugin — scaffolded by @toki0413/plugin-sdk.",
    '// Provider is assembled from descriptor.mjs via @toki0413/core/descriptor-provider;',
    '// to adapt, edit descriptor.mjs (command/template/output regex/units), not this file.',
    "import { createCordisAdapter } from '@toki0413/kernel'",
    "import { makeDescriptorProvider } from '@toki0413/core/descriptor-provider'",
    "import { ENGINE_DESCRIPTOR } from './descriptor.mjs'",
    '',
    'export default {',
    "  name: 'saturday-" + name + "',",
    '  async apply(ctx, config = {}) {',
    '    const rt = createCordisAdapter(ctx, config)',
    "    const potential = rt.getService('potential')",
    '    if (!potential) throw new Error(\'plugin requires service "potential" (mount saturday core first)\')',
    '    const provider = makeDescriptorProvider(ENGINE_DESCRIPTOR, {',
    '      binary: config.binary, potentialFile: config.potentialFile, spawnImpl: config.spawnImpl,',
    '    })',
    "    rt.effect(() => { potential.register(provider); return () => potential.unregister(provider.name) }, '" + name + "-provider')",
    '    ctx.fiber.store.' + storeKey + ' = { rt, provider }',
    '  },',
    '}',
  ]
  return lines.join('\n') + '\n'
}
function genTest(name) {
  const lines = [
    "// " + name + " scaffold test — shape + static conformance run out of the box.",
    '// Add a fake-binary potentialProviderContract once you know your stdout, mirroring plugins/lammps.',
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { makeDescriptorProvider } from '@toki0413/core/descriptor-provider'",
    "import { conformanceReport } from '@toki0413/core/conformance'",
    "import { ENGINE_DESCRIPTOR } from '../src/descriptor.mjs'",
    '',
    "test('descriptor shape', () => {",
    "  assert.equal(typeof ENGINE_DESCRIPTOR.name, 'string')",
    '  assert.ok(Array.isArray(ENGINE_DESCRIPTOR.manifest.capabilities) && ENGINE_DESCRIPTOR.manifest.capabilities.length >= 1)',
    "  assert.ok(ENGINE_DESCRIPTOR.structure && ENGINE_DESCRIPTOR.structure.inputFormat, 'structure.inputFormat names a codec (lammps-data / xyz / ...)')",
    "  assert.ok(ENGINE_DESCRIPTOR.output && ENGINE_DESCRIPTOR.output.energy && ENGINE_DESCRIPTOR.output.energy.regex, 'output.energy.regex parses your marker')",
    '})',
    '',
    "test('scaffolded provider passes static conformance', () => {",
    '  const provider = makeDescriptorProvider(ENGINE_DESCRIPTOR, { spawnImpl: () => { throw new Error("no binary in scaffold test") } })',
    '  const rep = conformanceReport({ provider })',
    "  assert.equal(rep.passed, true, rep.checks.filter(c => !c.ok).map(c => c.id + ':' + c.detail).join(' | '))",
    '})',
  ]
  return lines.join('\n') + '\n'
}

/** 产文件映射（相对路径 → 内容）。不落盘（写侧在 cli/writePluginScaffold）。 */
export function enginePluginFiles({ name, scope = '@toki0413', descriptor } = {}) {
  safeName(name)
  const d = descriptor ?? engineDescriptorTemplate({ name })
  if (!d || d.name !== name) {
    throw Object.assign(new Error(`descriptor.name must equal plugin name "${name}" (SDK_NAME_MISMATCH)`), { code: 'SDK_NAME_MISMATCH' })
  }
  const pkgName = `${scope}/plugin-${name}`
  return {
    'package.json': genPackageJson(pkgName, name),
    'src/descriptor.mjs': genDescriptor(d),
    'src/index.mjs': genIndex(name),
    'test/descriptor.test.mjs': genTest(name),
  }
}
