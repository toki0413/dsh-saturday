#!/usr/bin/env python3
"""Saturday MACE 常驻 sidecar —— JSON-lines 协议（与 python-bridge 完全一致）。

存在理由：MACE 的一次性子进程形态每次调用重载 torch + 模型，GPU 在场时
进程开销也远大于计算本身。常驻模式模型只加载一次，跨作业复用：
  请求:  {"id": str, "method": str, "params": dict}
  响应:  {"id": str, "result": any} | {"id": str, "error": {"code": str, "message": str}}
方法：hello（握手+实测版本/设备）/ relax / calculate（能量+力）/ md（Langevin NVT）/ shutdown
错误结构化回传，sidecar 不崩溃（与主 sidecar 同款纪律）。
"""
import json
import os
import sys

MODEL = os.environ.get("MACE_MODEL", "medium")
DTYPE = os.environ.get("MACE_DTYPE", "float64")

_calc = None


def get_calc():
    """模型惰性加载一次，跨作业复用（这是常驻的全部意义）。"""
    global _calc
    if _calc is None:
        from mace.calculators import mace_mp
        _calc = mace_mp(model=MODEL, default_dtype=DTYPE)
    return _calc


def to_atoms(graph):
    """AtomGraph → Atoms：periodic=False（分子）不带晶胞；缺省周期性。"""
    from ase import Atoms
    periodic = bool(graph.get("periodic", True))
    atoms = Atoms(
        numbers=[n["number"] for n in graph["nodes"]],
        positions=[n["position"] for n in graph["nodes"]],
        pbc=periodic,
    )
    if periodic:
        atoms.set_cell(graph["cell"])
        atoms.wrap()
    atoms.calc = get_calc()
    return atoms


def graph_positions(atoms):
    return [[float(x) for x in p] for p in atoms.get_positions()]


def handle(method, params):
    if method == "hello":
        import mace
        import torch
        get_calc()  # 握手即加载模型：就绪性验证前置到挂载，不留到首个作业
        return {
            "sidecar": "saturday-mace",
            "version": getattr(mace, "__version__", None),
            "model": MODEL,
            "device": "cuda" if torch.cuda.is_available() else "cpu",
            "dtype": DTYPE,
        }

    if method == "calculate":
        atoms = to_atoms(params["graph"])
        p = params.get("params", {})
        forces = [list(map(float, f)) for f in atoms.get_forces()]
        result = {
            "energy": float(atoms.get_potential_energy()),
            "forces": forces,
            "calculator": "mace:" + MODEL,
        }
        if "stress" in p.get("properties", []):
            raise ValueError("stress not declared by mace sidecar (未实现的能力不声明)")
        return result

    if method == "relax":
        from ase.optimize import BFGS
        atoms = to_atoms(params["graph"])
        p = params.get("params", {})
        opt = BFGS(atoms)
        converged = opt.run(fmax=p.get("fmax", 0.05), steps=p.get("max_steps", 200))
        return {
            "converged": bool(converged),
            "energy": float(atoms.get_potential_energy()),
            "n_steps": int(opt.nsteps),
            "positions": graph_positions(atoms),
            "calculator": "mace:" + MODEL,
        }

    if method == "md":
        from ase.md.langevin import Langevin
        from ase import units
        p = params.get("params", {})
        temperature_k = p.get("temperatureK")
        steps = p.get("steps", 100)
        dt_fs = p.get("dtFs", 1.0)
        if not isinstance(temperature_k, (int, float)) or temperature_k <= 0:
            raise ValueError("md requires params.temperatureK > 0 (K)")
        if not isinstance(steps, int) or steps < 1:
            raise ValueError("md requires params.steps >= 1")
        if dt_fs <= 0:
            raise ValueError("md requires params.dtFs > 0 (fs)")
        atoms = to_atoms(params["graph"])
        # ase Langevin 参数名是 temperature_K（带下划线）；云端实跑实证：写 temperatureK
        # 会在远端抛 "Exactly one of 'temperature', 'temperature_K'"——fake 单测只能验协议，
        # Python 侧签名必须真机验证
        dyn = Langevin(atoms, timestep=dt_fs * units.fs,
                       temperature_K=float(temperature_k), friction=0.005)
        dyn.run(steps=steps)
        # 温度由动能算：T = 2·KE / (ndof·kB)（ase 3.28 Langevin 无 get_temperature，
        # 云端实跑实证；能量均分计数用 3N 自由度，无约束体系即本形态）
        ke = dyn.atoms.get_kinetic_energy()
        ndof = 3 * len(dyn.atoms)
        temperature_K = 2.0 * ke / (ndof * units.kB)
        return {
            "energy": float(atoms.get_potential_energy()),
            "temperature_K": float(temperature_K),
            "steps": int(steps),
            "dtFs": float(dt_fs),
            "ensemble": "NVT-Langevin",
            "calculator": "mace:" + MODEL,
        }

    if method == "shutdown":
        return {"bye": True}

    raise ValueError(f"Unknown method: {method}")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            result = handle(req.get("method", ""), req.get("params", {}))
            print(json.dumps({"id": req_id, "result": result}), flush=True)
            if req.get("method") == "shutdown":
                return
        except Exception as exc:
            print(json.dumps({
                "id": req_id,
                "error": {"code": exc.__class__.__name__, "message": str(exc)},
            }), flush=True)


if __name__ == "__main__":
    main()
