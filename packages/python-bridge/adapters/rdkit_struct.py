"""RDKit adapter：分子体系的结构生成 + 轻量分子引擎（C 阶段：分子 QC 扩展）。

- smiles_to_graph：SMILES → 3D 构象 → Saturday graph（pbc=False）
- calculate_properties / relax_structure：MMFF94 / UFF 分子力场单点与弛豫
  （正统分子引擎，优于把金属势 EMT 或周期 LJ 玩具势用于孤立分子）。

RDKit 缺失时 adapter 不可导入，sidecar hello 如实报告（不冒充可用）；
导入成功但运行失败显式报错。能量单位：RDKit 力场给 kcal/mol，统一换算为 eV
（系统声明单位，1 kcal/mol = 0.0433641 eV），不混用。
"""

from __future__ import annotations

from typing import Any

import numpy as np

# kcal/mol → eV（RDKit 力场能量/梯度原生单位换算到系统统一的 eV）
KCALMOL_PER_EV = 0.04336410


def _build_mol_at_positions(numbers, positions, smiles=None):
    """structure graph → 带指定坐标共象的 RDKit mol（供力场计算）。

    优先用 SMILES 重建拓扑（原子序与 smiles_to_graph 输出一致，化学上可靠）；
    无 SMILES 或原子数不匹配（下游改过原子）时回退 xyz 键感知。
    失败显式报错（不静默给错拓扑的能量）。
    """
    from rdkit import Chem

    n = len(numbers)
    pos = np.array(positions, dtype=float)
    if pos.shape != (n, 3):
        raise ValueError(f"positions shape {pos.shape} inconsistent with {n} atoms")

    mol = None
    if smiles:
        try:
            cand = Chem.AddHs(Chem.MolFromSmiles(smiles))
        except Exception:
            cand = None
        # SMILES 只有在能完整重现图原子集（数量 + 多元价）时才可信；
        # 否则（原子被取代/删减）拓扑与坐标不对应，回退键感知
        if cand is not None and cand.GetNumAtoms() == n:
            stored = sorted(int(z) for z in numbers)
            built = sorted(a.GetAtomicNum() for a in cand.GetAtoms())
            if stored == built:
                mol = cand
    if mol is None:
        mol = _mol_from_xyz(numbers, pos)

    conf = Chem.Conformer(mol.GetNumAtoms())
    for i, p in enumerate(pos):
        conf.SetAtomPosition(i, [float(p[0]), float(p[1]), float(p[2])])
    mol.RemoveAllConformers()
    mol.AddConformer(conf, assignId=True)
    return mol


def _mol_from_xyz(numbers, pos):
    """无 SMILES 时从坐标感知分子拓扑（rdDetermineBonds）；失败显式报错。"""
    from rdkit import Chem
    from rdkit.Chem import rdDetermineBonds

    rw = Chem.RWMol()
    for z in numbers:
        rw.AddAtom(Chem.Atom(int(z)))
    conf = Chem.Conformer(len(numbers))
    for i, p in enumerate(pos):
        conf.SetAtomPosition(i, [float(p[0]), float(p[1]), float(p[2])])
    rw.AddConformer(conf, assignId=True)
    mol = rw.GetMol()
    try:
        rdDetermineBonds.DetermineBonds(mol, charge=int(0))
    except Exception as exc:
        raise ValueError(
            f"cannot perceive molecular topology from coordinates without a SMILES "
            f"(rdDetermineBonds failed: {exc}); supply a SMILES-bearing structure"
        ) from exc
    return mol


def _forcefield(mol):
    """为 mol 选择力场：MMFF 优先（覆盖面广），不可用回退 UFF（通用）。

    返回 (ff, name)；两者均不可用时显式报错（不静默给零力）。
    """
    from rdkit.Chem import AllChem

    props = AllChem.MMFFGetMoleculeProperties(mol)
    if props is not None:
        ff = AllChem.MMFFGetMoleculeForceField(mol, props)
        if ff is not None:
            return ff, "rdkit-mmff"
    try:
        ff = AllChem.UFFGetMoleculeForceField(mol)
        if ff is not None:
            return ff, "rdkit-uff"
    except Exception:
        pass
    raise ValueError("no RDKit force field (MMFF/UFF) available for this molecule")


def calculate_properties(structure: dict, params: dict) -> dict[str, Any]:
    """分子单点：MMFF/UFF 能量 + 力（梯度取负）。统一输出 eV / eV/Å。

    控制面门禁第二道防线：未声明性质直接报错，绝不静默置 None（诚实纪律）。
    """
    mol = _build_mol_at_positions(
        structure["numbers"], structure["positions"], structure.get("smiles")
    )
    ff, name = _forcefield(mol)
    energy = ff.CalcEnergy() * KCALMOL_PER_EV
    grad = np.asarray(ff.CalcGrad(), dtype=float).reshape(-1, 3) * KCALMOL_PER_EV
    forces = (-grad).tolist()
    out: dict[str, Any] = {
        "energy": float(energy),
        "forces": forces,
        "calculator": name,
    }
    for p in params.get("properties", []):
        if p not in out:
            raise ValueError(f"{name} cannot compute property '{p}'")
    return out


def relax_structure(structure: dict, params: dict) -> dict[str, Any]:
    """分子弛豫：MMFF/UFF 力场最小化（无晶胞自由度，孤立分子坐标优化）。

    rc==0 视为收敛；fmax 门禁对应 RMS 梯度阈值（kcal/mol/Å 换算到 eV/Å）。
    """
    import time

    t0 = time.time()
    mol = _build_mol_at_positions(
        structure["numbers"], structure["positions"], structure.get("smiles")
    )
    ff, name = _forcefield(mol)
    rc = int(ff.Minimize(maxIts=int(params.get("max_steps", 500))))
    grad = np.asarray(ff.CalcGrad(), dtype=float) * KCALMOL_PER_EV
    fmax = float(np.max(np.abs(grad))) if grad.size else 0.0
    conf = mol.GetConformer()
    return {
        "converged": rc == 0,
        "energy": float(ff.CalcEnergy() * KCALMOL_PER_EV),
        "positions": conf.GetPositions().tolist(),
        "cell": [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]],
        "fmax": fmax,
        "n_steps": int(ff.NumIterations()) if hasattr(ff, "NumIterations") else 0,
        "wall_seconds": round(time.time() - t0, 3),
        "calculator": name,
    }


def smiles_to_graph(smiles: str, params: dict) -> dict[str, Any]:
    """SMILES → 加氢 → ETKDG 3D 构象 → MMFF/UFF 力场弛豫 → graph。

    返回 graph 无 cell、pbc=[False, False, False]（分子体系：无周期边界）。
    """
    from rdkit import Chem
    from rdkit.Chem import AllChem

    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise ValueError(f"invalid SMILES: {smiles!r}")
    mol = Chem.AddHs(mol)
    seed = int(params.get("seed", 42))
    if AllChem.EmbedMolecule(mol, randomSeed=seed, useRandomCoords=True) != 0:
        raise ValueError(f"ETKDG embedding failed for {smiles!r}")
    # 力场弛豫：MMFF 优先（覆盖面广），不可用回退 UFF（通用）；均失败则保留嵌入构象并如实声明
    forcefield = "embedded"
    try:
        if AllChem.MMFFHasAllMoleculeParams(mol):
            AllChem.MMFFOptimizeMolecule(mol, maxIters=int(params.get("mmffIters", 500)))
            forcefield = "MMFF"
        else:
            AllChem.UFFOptimizeMolecule(mol, maxIters=int(params.get("uffIters", 500)))
            forcefield = "UFF"
    except Exception:
        pass  # 力场弛豫是构象质量优化，失败不阻断（嵌入构象仍可用），forcefield 如实降档

    conf = mol.GetConformer()
    positions = conf.GetPositions().tolist()
    numbers = [atom.GetAtomicNum() for atom in mol.GetAtoms()]
    return {
        "numbers": [int(z) for z in numbers],
        "positions": positions,
        "cell": None,
        "pbc": [False, False, False],
        "smiles": smiles,
        "forcefield": forcefield,
        "calculator": "rdkit-struct",
    }
