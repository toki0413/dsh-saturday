#!/usr/bin/env python3
"""Saturday Python sidecar —— stdio JSON-lines 协议。

协议：每行一个 JSON 对象。
  请求:  {"id": str, "method": str, "params": dict}
  响应:  {"id": str, "result": any} | {"id": str, "error": {"code": str, "message": str}}

计算器后端按"每次调用的元素"路由：
  - 结构元素全部落在 EMT 覆盖范围（Al Cu Ag Au Ni Pd Pt）且 ASE 可用 → ASE EMT（真实物理）
  - 否则 → LJ 玩具势（emt_mock，兜底，保证任意元素都能跑通流程）
两个适配器函数签名一致，可互换。
"""
import json
import sys

try:
    from adapters.ase_emt import (
        relax_structure as ase_relax,
        calculate_properties as ase_calc,
        roundtrip_structure as ase_roundtrip,
        reference_energy as ase_reference_energy,
        EMT_ELEMENTS,
    )
    HAS_ASE = True
except ImportError:
    HAS_ASE = False
    EMT_ELEMENTS = set()

try:
    from adapters.rdkit_struct import (
        smiles_to_graph as rdkit_smiles,
        relax_structure as rdkit_relax,
        calculate_properties as rdkit_calc,
    )
    HAS_RDKIT = True
except ImportError:
    HAS_RDKIT = False

from adapters.emt_mock import (
    relax_structure as lj_relax,
    calculate_properties as lj_calc,
)

# 原子序数 → 元素符号（MVP 元素表子集，与 src/core/elements.mjs 对齐）
Z_TO_SYMBOL = {
    1: "H", 3: "Li", 6: "C", 8: "O", 13: "Al", 14: "Si", 18: "Ar",
    22: "Ti", 26: "Fe", 28: "Ni", 29: "Cu", 46: "Pd", 47: "Ag",
    78: "Pt", 79: "Au",
}


def pick_backend(structure: dict) -> str:
    # 分子体系（pbc 显式全 False）→ 轻量分子引擎 RDKit MMFF/UFF（正统分子力场）。
    # 不降级到 lj-mock：后者依赖周期晶胞（对零晶胞求逆 → 奇异矩阵），
    # 金属势 EMT 也不描述分子键——两者对孤立分子都是错误物理。
    pbc = structure.get("pbc")
    is_molecule = pbc is not None and not any(pbc)
    if is_molecule:
        if not HAS_RDKIT:
            raise RuntimeError(
                "molecular structure (pbc=False) requires RDKit MMFF/UFF engine "
                "(install rdkit; lj-mock/EMT are periodic/metallic and invalid for isolated molecules)"
            )
        return "rdkit-mmff"
    symbols = {Z_TO_SYMBOL.get(int(z), "") for z in structure["numbers"]}
    if HAS_ASE and symbols and symbols <= EMT_ELEMENTS:
        return "ase-emt"
    return "lj-mock"


def handle(method: str, params: dict):
    if method == "hello":
        # 实测态回读：ASE 可用时携带实际版本，供引擎指纹从声明态升级；
        # 不可用时 None（诚实降级，不冒充已知）
        ase_version = None
        if HAS_ASE:
            import ase as _ase
            ase_version = getattr(_ase, "__version__", None)
        return {
            "sidecar": "saturday-python-bridge",
            "version": "0.3.4",
            "calculators": {"ase-emt": HAS_ASE, "lj-mock": True, "rdkit-mmff": HAS_RDKIT},
            "structureSources": {"rdkit-struct": HAS_RDKIT},
            # 契约 §5.1：事件粒度声明（逐调用同步形态，均为迭代级）
            "eventGranularity": {"ase-emt": "iteration", "lj-mock": "iteration"},
            "aseVersion": ase_version,
        }
    if method == "roundtrip":
        # 互转精度自检：必须走真 ASE，无 ASE 时诚实报错而非静默降级
        if not HAS_ASE:
            raise RuntimeError("roundtrip requires ASE (data-plane identity check)")
        return ase_roundtrip(params["structure"], params.get("params", {}))
    if method == "reference_energy":
        # 元素参考态（热力学第一档）：能量零点必须来自真 EMT 弛豫，
        # LJ 玩具势无此承诺，无 ASE 时诚实报错而非静默降级
        if not HAS_ASE:
            raise RuntimeError("reference_energy requires ASE (elemental reference state needs real EMT)")
        return ase_reference_energy(params["symbol"], params.get("params", {}))
    if method == "relax":
        backend = pick_backend(params["structure"])
        fn = {"ase-emt": ase_relax, "lj-mock": lj_relax, "rdkit-mmff": rdkit_relax}[backend]
        return fn(params["structure"], params.get("params", {}))
    if method == "calculate":
        backend = pick_backend(params["structure"])
        fn = {"ase-emt": ase_calc, "lj-mock": lj_calc, "rdkit-mmff": rdkit_calc}[backend]
        return fn(params["structure"], params.get("params", {}))
    if method == "smiles_to_graph":
        # 分子结构生成（C 阶段）：RDKit 缺失显式报错（不冒充可用）
        if not HAS_RDKIT:
            raise RuntimeError("smiles_to_graph requires RDKit (install rdkit or use a periodic structure source)")
        return rdkit_smiles(params["smiles"], params.get("params", {}))
    if method == "shutdown":
        # 先应答再退出（在 main 循环里处理）
        return {"bye": True}
    raise ValueError(f"Unknown method: {method}")


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            result = handle(req["method"], req.get("params", {}))
            print(json.dumps({"id": req["id"], "result": result}), flush=True)
            if req["method"] == "shutdown":
                return
        except Exception as exc:  # 结构化错误回传，不让 sidecar 崩溃
            req_id = None
            try:
                req_id = json.loads(line).get("id")
            except Exception:
                pass
            print(json.dumps({
                "id": req_id,
                "error": {"code": type(exc).__name__, "message": str(exc)},
            }), flush=True)


if __name__ == "__main__":
    main()
