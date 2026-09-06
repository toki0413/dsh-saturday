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
    # pbc 透传（C 阶段：分子体系 pbc=False，cell 可为零矩阵）；缺省周期性（兼容既有调用）
    pbc = structure.get("pbc")
    cell = structure.get("cell")
    return Atoms(
        numbers=structure["numbers"],
        positions=np.array(structure["positions"], dtype=float),
        cell=np.array(cell, dtype=float) if cell is not None else np.zeros((3, 3)),
        pbc=np.array(pbc, dtype=bool) if pbc is not None else True,
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
    """原子位置弛豫（分子，全 pbc=False：直接 BFGS）或位置+晶胞联合弛豫
    （周期性体系：BFGS on UnitCellFilter）。"""
    t0 = time.time()
    atoms = _to_atoms(structure)
    atoms.calc = EMT()

    fmax = float(params.get("fmax", 0.05))
    max_steps = int(params.get("max_steps", 200))

    if any(atoms.pbc):
        opt = BFGS(UnitCellFilter(atoms), logfile=None)
    else:
        opt = BFGS(atoms, logfile=None)
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


def reference_energy(symbol: str, params: dict) -> dict[str, Any]:
    """元素参考态每原子能量（热力学第一档）：fcc 单胞 + BFGS 全弛豫到 EMT 自身平衡态。
    形成焓的能量零点必须显式计算，不得静默假设为零；不支持的元素直接报错。"""
    if symbol not in EMT_ELEMENTS:
        raise ValueError(f"ase-emt has no reference state for element '{symbol}'")
    from ase.build import bulk
    t0 = time.time()
    atoms = bulk(symbol, "fcc", cubic=True)
    atoms.calc = EMT()
    opt = BFGS(UnitCellFilter(atoms), logfile=None)
    converged = opt.run(fmax=float(params.get("fmax", 0.02)), steps=int(params.get("max_steps", 200)))
    return {
        "symbol": symbol,
        "energy_per_atom": float(atoms.get_potential_energy() / len(atoms)),
        "converged": bool(converged),
        "n_steps": int(opt.get_number_of_steps()),
        "wall_seconds": round(time.time() - t0, 3),
        "calculator": "ase-emt",
    }
