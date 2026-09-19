// 准谐热膨胀纯函数测试：闭式对账（抛物线顶点、合成模型 s*(T) 解析、Grüneisen 拟合、非法输入）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parabolaVertex, quasiharmonic, gruneisenFromFreqs } from '../src/phonon-qha.mjs'

const close = (a, b, eps, msg = '') => assert.ok(Number.isFinite(a) && Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (±${eps}) ${msg}`)

test('1. parabolaVertex 对已知二次精确命中顶点', () => {
  // 开口向上 y=(x-2)²+2 采样 x=1,2,3 → y=3,2,3，顶点 x*=2
  const p = parabolaVertex(1, 3, 2, 2, 3, 3)
  close(p.x, 2, 1e-9); assert.equal(p.ok, true)
  // 开口向下（中点最高）→ ok=false（无内部极小）
  const d = parabolaVertex(1, 2, 2, 3, 3, 2)
  assert.equal(d.ok, false)
})

test('2. 合成准谐模型：s*(T)=1+cT/2k 精确复现，V(T) 升、α>0', () => {
  const k = 50, a = 0.002, baseVolume = 4 * 3.615 ** 3 // 任意正体积
  const scales = [0.97, 0.98, 0.99, 1.0, 1.01, 1.02, 1.03]
  const eStatic = scales.map(s => k * (s - 1) ** 2)
  const temperatures = [100, 300]
  // fvib 项设计使 F=E_static − c·T·s（meV→eV 后 c·T·s），c=a
  const fvibMeV = scales.map(s => temperatures.map(T => -a * T * s * 1000))
  const out = quasiharmonic({ baseVolume, scales, eStatic, fvibMeV, temperatures })
  for (let j = 0; j < temperatures.length; j++) {
    const expected = 1 + (a * temperatures[j]) / (2 * k)
    close(out.points[j].scale, expected, 1e-3, `s* @ T=${temperatures[j]}`)
  }
  // V(T) 随 T 升、α>0
  assert.ok(out.points[1].volume > out.points[0].volume, 'V 随 T 升')
  assert.ok(out.points[0].alphaPerK > 0 && out.points[1].alphaPerK > 0, '正热膨胀')
  // volume = baseVolume·scale³
  close(out.points[0].volume, baseVolume * out.points[0].scale ** 3, 1e-6)
})

test('3. T→0 回到静态平衡体积 scale=1', () => {
  const k = 50, baseVolume = 100
  const scales = [0.98, 0.99, 1.0, 1.01, 1.02]
  const eStatic = scales.map(s => k * (s - 1) ** 2)
  const out = quasiharmonic({ baseVolume, scales, eStatic, fvibMeV: scales.map(() => [0]), temperatures: [1] })
  close(out.points[0].scale, 1.0, 1e-6, '无振动态贡献 → 静态平衡')
  close(out.equilibriumT0.scale, 1.0, 1e-6)
})

test('4. Grüneisen：ω∝V^(−γ) 拟合回 γ', () => {
  const gamma = 2.0
  const volumes = [95, 100, 105, 110]
  const omegaByVolume = volumes.map(V => [1, 5, 8].map(w0 => w0 * (V / 100) ** (-gamma)))
  const { modeGammas, gammaAvg } = gruneisenFromFreqs({ volumes, omegaByVolume })
  for (const g of modeGammas) close(g, gamma, 1e-6, `模式 γ=${g}`)
  close(gammaAvg, gamma, 1e-6)
})

test('5. 非法输入显式报错，不静默', () => {
  assert.throws(() => quasiharmonic({ baseVolume: 0, scales: [1, 2, 3], eStatic: [0, 0, 0], fvibMeV: [[0], [0], [0]], temperatures: [1] }), e => e.code === 'QHA_BAD_INPUT')
  assert.throws(() => quasiharmonic({ baseVolume: 1, scales: [1, 1, 2], eStatic: [0, 0, 0], fvibMeV: [[0], [0], [0]], temperatures: [1] }), e => e.code === 'QHA_BAD_INPUT', '非严格升序')
  assert.throws(() => quasiharmonic({ baseVolume: 1, scales: [1, 2, 3], eStatic: [0, 0], fvibMeV: [[0], [0], [0]], temperatures: [1] }), e => e.code === 'QHA_BAD_INPUT', 'eStatic 长度不齐')
  assert.throws(() => gruneisenFromFreqs({ volumes: [1], omegaByVolume: [[1]] }), e => e.code === 'QHA_BAD_INPUT')
})
