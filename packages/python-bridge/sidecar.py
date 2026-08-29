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
        EMT_ELEMENTS,
    )
    HAS_ASE = True
except ImportError:
    HAS_ASE = False
    EMT_ELEMENTS = set()

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
    symbols = {Z_TO_SYMBOL.get(int(z), "") for z in structure["numbers"]}
    if HAS_ASE and symbols and symbols <= EMT_ELEMENTS:
        return "ase-emt"
    return "lj-mock"


def handle(method: str, params: dict):
    if method == "hello":
        return {
            "sidecar": "saturday-python-bridge",
            "version": "0.3.0",
            "calculators": {"ase-emt": HAS_ASE, "lj-mock": True},
            # 契约 §5.1：事件粒度声明（逐调用同步形态，均为迭代级）
            "eventGranularity": {"ase-emt": "iteration", "lj-mock": "iteration"},
        }
    if method == "roundtrip":
        # 互转精度自检：必须走真 ASE，无 ASE 时诚实报错而非静默降级
        if not HAS_ASE:
            raise RuntimeError("roundtrip requires ASE (data-plane identity check)")
        return ase_roundtrip(params["structure"], params.get("params", {}))
    if method == "relax":
        backend = pick_backend(params["structure"])
        fn = ase_relax if backend == "ase-emt" else lj_relax
        return fn(params["structure"], params.get("params", {}))
    if method == "calculate":
        backend = pick_backend(params["structure"])
        fn = ase_calc if backend == "ase-emt" else lj_calc
        return fn(params["structure"], params.get("params", {}))
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
