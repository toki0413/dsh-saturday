"""EMT-mock 适配器：Lennard-Jones 玩具势下的晶格弛豫。

⚠️ 这是占位实现（PyPI 不可达时的 spike 选择），不是真实 EMT。
生产替换路径：ASE 的 `ase.calculators.emt.EMT` + `ase.optimize`，
本模块的函数签名（structure dict 进、结果 dict 出）保持不变。

弛豫语义：对所有原子坐标与晶胞做统一缩放 s，最小化 LJ 对能量 E(s)。
这等价于零压晶格优化的一维近似——足够验证桥接链路与长任务行为。
"""
from __future__ import annotations

import time
from typing import Any

import numpy as np
from scipy.optimize import minimize_scalar

# LJ 参数（Ar 量级，玩具值）
EPSILON = 0.0104  # eV
SIGMA = 3.4       # Å
CUTOFF = 2.5 * SIGMA


def _pair_energy(positions: np.ndarray, cell: np.ndarray) -> float:
    """周期边界下的 LJ 对能量（最小镜像约定）。"""
    n = len(positions)
    energy = 0.0
    inv_cell = np.linalg.inv(cell)
    for i in range(n):
        for j in range(i + 1, n):
            d = positions[j] - positions[i]
            # 最小镜像
            frac = inv_cell @ d
            frac -= np.round(frac)
            d = cell @ frac
            r = float(np.linalg.norm(d))
            if 1e-8 < r < CUTOFF:
                sr6 = (SIGMA / r) ** 6
                energy += 4 * EPSILON * (sr6 * sr6 - sr6)
    return energy


def _scaled(structure: dict, s: float) -> tuple[np.ndarray, np.ndarray]:
    positions = np.array(structure["positions"], dtype=float) * s
    cell = np.array(structure["cell"], dtype=float) * s
    return positions, cell


def relax_structure(structure: dict, params: dict) -> dict[str, Any]:
    """统一缩放弛豫：min_s E(s)。"""
    t0 = time.time()
    positions0, cell0 = _scaled(structure, 1.0)
    e0 = _pair_energy(positions0, cell0)

    def objective(s: float) -> float:
        positions, cell = _scaled(structure, s)
        return _pair_energy(positions, cell)

    # 模拟真实计算的耗时（验证桥的长任务行为），可配置
    simulated_seconds = float(params.get("simulated_seconds", 0.5))
    if simulated_seconds > 0:
        time.sleep(simulated_seconds)

    opt = minimize_scalar(objective, bounds=(0.9, 1.1), method="bounded",
                          options={"xatol": 1e-5})
    s_star = float(opt.x)
    positions_f, cell_f = _scaled(structure, s_star)
    e_f = float(opt.fun)

    return {
        "converged": bool(opt.success),
        "energy": e_f,
        "energy_initial": e0,
        "scale": s_star,
        "n_steps": int(opt.nfev),
        "positions": positions_f.tolist(),
        "cell": cell_f.tolist(),
        "wall_seconds": round(time.time() - t0, 3),
        "calculator": "lj-mock",
    }


def calculate_properties(structure: dict, params: dict) -> dict[str, Any]:
    """静态单点：能量（LJ）。bandgap 等性质真实引擎才有，这里显式返回 None。"""
    positions, cell = _scaled(structure, 1.0)
    energy = _pair_energy(positions, cell)
    props = params.get("properties", ["energy"])
    out: dict[str, Any] = {"energy": float(energy), "calculator": "lj-mock"}
    for p in props:
        if p not in out:
            out[p] = None  # 玩具势给不了的性质，显式置空而非编造
    return out
