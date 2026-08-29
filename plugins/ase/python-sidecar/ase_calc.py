#!/usr/bin/env python3
"""@saturday/plugin-ase 数据面 —— 通用 ASE 计算器 sidecar。

与主 sidecar（packages/python-bridge/sidecar.py）同协议（stdio JSON-lines），
但语义不同：计算器由调用方显式指定（'lj' | 'emt'），不可用时结构化报错
（EngineUnavailableError），绝不隐式替换成别的计算器（契约 §4.2）。
"""
import json
import sys


def make_calculator(spec: dict):
    """按名称构造 ASE 计算器；参数透传。不可用则结构化报错。"""
    name = spec.get("name", "lj")
    params = spec.get("params", {}) or {}
    if name == "lj":
        from ase.calculators.lj import LennardJones  # noqa: PLC0415
        return LennardJones(**params)
    if name == "emt":
        from ase.calculators.emt import EMT  # noqa: PLC0415
        return EMT()
    raise EngineUnavailableError(f"unknown calculator: {name}")


class EngineUnavailableError(Exception):
    """显式失败：计算器不可用（未安装 / 未知名称），不得静默降级。"""


def available():
    """逐一探测可构造的计算器清单（hello 时上报）。"""
    out = []
    for name in ("lj", "emt"):
        try:
            make_calculator({"name": name})
            out.append(name)
        except Exception:
            pass
    return out


def relax(spec: dict) -> dict:
    from ase import Atoms  # noqa: PLC0415
    from ase.optimize import BFGS  # noqa: PLC0415

    structure = spec["structure"]
    atoms = Atoms(
        numbers=structure["numbers"],
        positions=structure["positions"],
        cell=structure["cell"],
        pbc=True,
    )
    try:
        atoms.calc = make_calculator(spec.get("calculator", {"name": "lj"}))
    except ImportError as exc:
        raise EngineUnavailableError(str(exc)) from exc

    params = spec.get("params", {}) or {}
    opt = BFGS(atoms)
    converged = opt.run(
        fmax=params.get("fmax", 0.05),
        steps=params.get("max_steps", 200),
    )
    return {
        "converged": bool(converged),
        "energy": float(atoms.get_potential_energy()),
        "n_steps": int(opt.nsteps),
    }


def handle(method: str, params: dict):
    if method == "hello":
        return {
            "sidecar": "saturday-ase-calc",
            "version": "0.1.0",
            "calculators": available(),
            "eventGranularity": "iteration",
        }
    if method == "relax":
        return relax(params)
    if method == "shutdown":
        return {"bye": True}
    raise ValueError(f"Unknown method: {method}")


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            result = handle(req["method"], req.get("params", {}))
            print(json.dumps({"id": req_id, "result": result}), flush=True)
            if req["method"] == "shutdown":
                return
        except Exception as exc:  # 结构化错误回传，sidecar 不崩
            print(json.dumps({
                "id": req_id,
                "error": {"code": type(exc).__name__, "message": str(exc)},
            }), flush=True)


if __name__ == "__main__":
    main()
