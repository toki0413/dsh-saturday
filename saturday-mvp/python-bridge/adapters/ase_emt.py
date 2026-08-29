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
    """静态单点：能量 + 力。EMT 无电子结构，bandgap/dos 显式置 None。"""
    atoms = _to_atoms(structure)
    atoms.calc = EMT()
    out: dict[str, Any] = {
        "energy": float(atoms.get_potential_energy()),
        "forces": atoms.get_forces().tolist(),
        "calculator": "ase-emt",
    }
    for p in params.get("properties", []):
        if p not in out:
            out[p] = None
    return out
