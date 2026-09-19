# @toki0413/plugin-sdk —— 把一个引擎接进 Saturday / Agent

给一份**引擎描述符**，生成一个过契约的引擎插件包；provider 由 `@toki0413/core/descriptor-provider`
按描述符装配，你不手写 provider 代码。适合"我有一个 CLI 引擎/脚本，想让 Agent 能调、还自带
provenance/失效传播"的计算组。

## 快速上手

```bash
npx create-saturday-plugin myengine ./plugin-myengine
# 生成 ./plugin-myengine/{package.json, src/descriptor.mjs, src/index.mjs, test/descriptor.test.mjs}
```

或编程式：`enginePluginFiles({ name, descriptor })` → 文件映射；`writePluginScaffold(dir, {name, descriptor})` 落盘。

## 你只需编辑 `src/descriptor.mjs`

| 字段 | 填什么 |
|------|--------|
| `name` | 引擎名（注册用） |
| `binaryDefault` | 可执行文件（作者也可经 `config.binary` 覆盖） |
| `manifest.units` | 引擎实际单位三元组 `{energy,length,time}`，须在白名单内（eV/Ry/…、Å/Bohr/…、fs/ps/s） |
| `manifest.fingerprint` | `{software, method, version?}`；version 拿不到就留 `unknown`（诚实降级） |
| `manifest.capabilities` | 每项 `type` + `accuracy/speed/cost∈[0,1]` + 可选 `maxAtoms` |
| `structure.inputFormat` | 结构序列化用的**已注册 codec**：`lammps-data` / `xyz` / `poscar`（没有就先给 core 加一个 codec） |
| `run.template` / `run.args` | 输入脚本模板（`{{dataFile}}`/`{{potentialFile}}` 占位）与命令行参数 |
| `output.energy.regex` | 从引擎 stdout 解析终态能量的正则（第 1 捕获组） |
| `versionProbe` | 运行时版本回读命令 + 解析正则（探测失败自动保持 unknown） |
| `availability.requireConfig` | 挂载前必须的配置项（如 `potentialFile`）；缺则判不可用、不静默降级 |

生成包内 `test/descriptor.test.mjs` 是**开箱即过**的静态形状 + conformance 测；把你自己引擎的
伪 stdout 加进一个 `potentialProviderContract(...)`，照 `plugins/lammps` 的写法补运行时契约测。

## 边界（诚实）
- 覆盖"常见 CLI 一进一出 + 已有 codec 支持的输入格式"这一大类；复杂引擎（多步 prep、重启、并行环境）
  仍需自己写 provider（seam 不变）。
- 描述符是 JS 对象/JSON，不是 YAML（js-yaml 属外部依赖，违反零运行时依赖）。
- 生成的插件与手写引擎（ase/lammps/mace/lj）并列注册，跨引擎组合仍受单位/指纹门禁约束。
