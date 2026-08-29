"""ASE EMT 适配器：真实有效介质理论势弛豫（生产路径的占位引擎）。

支持元素：Al, Cu, Ag, Au, Ni, Pd, Pt（EMT 覆盖的 fcc 金属）。
函数签名与 emt_mock 完全一致——sidecar 按 ASE 可用性自动选择后端。
"""
from __future__ import annotations

import time
from typing import Any

import numpy as np
from ase import Atoms
from ase.calculators.emt import EMT
from ase.filters import UnitCellFilter
from ase.optimize import BFGS

EMT_ELEMENTS = {"Al", "Cu", "Ag", "Au", "Ni", "Pd", "Pt"}


def _to_atoms(structure: dict) -> Atoms:
    return Atoms(
        numbers=structure["numbers"],
        positions=np.array(structure["positions"], dtype=float),
        cell=np.array(structure["cell"], dtype=float),
        pbc=True,
    )


def roundtrip_structure(structure: dict, params: dict) -> dict[str, Any]:
    """互转精度自检：dict → ASE Atoms → dict（不挂计算器）。

    用于验证 Saturday graph ↔ ASE 表示往返无损（float64 全精度）；
    验收条款“ASE 互转精度测试”（路线 Week 9）的数据面实现。
    """
    atoms = _to_atoms(structure)
    return {
        "numbers": [int(z) for z in atoms.numbers],
        "positions": atoms.positions.tolist(),
        "cell": atoms.cell.tolist(),
        "pbc": [bool(p) for p in atoms.pbc],
    }


def relax_structure(structure: dict, params: dict) -> dict[str, Any]:
    """原子位置 + 晶胞联合弛豫（BFGS on UnitCellFilter）。"""
    t0 = time.time()
    atoms = _to_atoms(structure)
    atoms.calc = EMT()

    fmax = float(params.get("fmax", 0.05))
    max_steps = int(params.get("max_steps", 200))

    opt = BFGS(UnitCellFilter(atoms), logfile=None)
    converged = opt.run(fmax=fmax, steps=max_steps)

    return {
        "converged": bool(converged),
        "energy": float(atoms.get_potential_energy()),
        "positions": atoms.positions.tolist(),
        "cell": atoms.cell.tolist(),
        "n_steps": int(opt.get_number_of_steps()),
        "wall_seconds": round(time.time() - t0, 3),
        "calculator": "ase-emt",
    }


def calculate_properties(structure: dict, params: dict) -> dict[str, Any]:
    """静态单点：能量 + 力。控制面门禁的第二道防线：
    EMT 无电子结构，未声明性质直接报错，绝不静默置 None（诚实纪律）。"""
    atoms = _to_atoms(structure)
    atoms.calc = EMT()
    out: dict[str, Any] = {
        "energy": float(atoms.get_potential_energy()),
        "forces": atoms.get_forces().tolist(),
        "calculator": "ase-emt",
    }
    for p in params.get("properties", []):
        if p not in out:
            raise ValueError(f"ase-emt cannot compute property '{p}'")
    return out
