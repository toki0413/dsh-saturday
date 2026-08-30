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
        # pbc 默认关：周期晶胞中粒子互不相作用（全零 Hessian），与结构 pbc=True 对齐显式开启；
        # 调用方可用 params 覆盖（含关回 pbc 的孤立团簇场景）
        params = {"pbc": True, **params}
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


def calculate(spec: dict) -> dict:
    """静态单点：能量 + 力（遍历对账系综侧与常规分析共用）。"""
    from ase import Atoms  # noqa: PLC0415

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
    return {
        "energy": float(atoms.get_potential_energy()),
        "forces": atoms.get_forces().tolist(),
    }


def md(spec: dict) -> dict:
    """Langevin 恒温 MD（§4.5 遍历对账的时间平均侧）。

    返回逐采样步的势能/动能/温度序列；积分器与计算器均由调用方显式指定，
    不可用时报 EngineUnavailableError，不静默降级（契约 §4.2）。
    """
    import time as _time

    from ase import Atoms  # noqa: PLC0415
    from ase import units  # noqa: PLC0415
    from ase.md.langevin import Langevin  # noqa: PLC0415

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
    temperature_K = float(params.get("temperature_K", 300.0))
    steps = int(params.get("steps", 200))
    dt_fs = float(params.get("dt_fs", 1.0))
    sample_every = max(1, int(params.get("sample_every", 5)))
    friction = float(params.get("friction", 0.01))
    seed = params.get("seed")
    if seed is not None:
        import numpy as np  # noqa: PLC0415
        np.random.seed(int(seed))

    t0 = _time.time()
    dyn = Langevin(
        atoms,
        timestep=dt_fs * units.fs,
        temperature_K=temperature_K,
        friction=friction,
        logfile=None,
        fixcm=False,  # 小体系下 fixcm=True 不严格采样 NVT（ASE ≥3.28 弃用警告）；
                      # 遍历对账要求采样分布诚实，质心漂移由对账方自行约束（如周期性小盒）
    )

    def _kT() -> float:
        v = atoms.get_velocities()
        return float((0.5 * (atoms.get_masses()[:, None] * v * v).sum()) / (1.5 * len(atoms)) / units.kB)

    energies, kinetics, temperatures = [], [], []
    def sample():
        energies.append(float(atoms.get_potential_energy()))
        kinetics.append(float(atoms.get_kinetic_energy()))
        temperatures.append(_kT())
    sample()
    for _ in range(steps):
        dyn.run(sample_every)
        sample()

    return {
        "energies": energies,
        "kinetic": kinetics,
        "temperatures": temperatures,
        "temperature_K": temperature_K,
        "n_steps": steps,
        "wall_seconds": round(_time.time() - t0, 3),
    }


def harmonic(spec: dict) -> dict:
    """谐波锚点数据面：弛豫到局部极小 → 中心差分 Hessian → 质量加权简正模频率。

    只返回 u0 与全量频率表；振动自由能闭式在 JS 纯层（单一闭式来源）。
    周期小胞的声学模是真实声学模，不擅自剔除；虚频如实计数上报，
    由调用方声明而非静默修正（同参考态纪律：不假设零点）。
    """
    import math  # noqa: PLC0415
    import time as _time  # noqa: PLC0415

    import numpy as np  # noqa: PLC0415
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
    t0 = _time.time()

    # 1) 锚点 = 机械平衡点：先弛豫到局部极小（BFGS，与 relax 算子同一参数族）
    opt = BFGS(atoms)
    converged = opt.run(
        fmax=params.get("fmax", 0.05),
        steps=params.get("max_steps", 200),
    )
    u0 = float(atoms.get_potential_energy())

    # 2) Hessian：力对位移的中心差分，H_{ia,jb} = -dF_{ia}/dx_{jb}
    h = float(params.get("displacement_angstrom", 0.01))
    n3 = 3 * len(atoms)
    pos0 = atoms.get_positions().copy()
    hess = np.zeros((n3, n3))
    for j in range(n3):
        f_plus = f_minus = None
        for sign in (1.0, -1.0):
            pos = pos0.copy()
            pos[j // 3, j % 3] += sign * h
            atoms.set_positions(pos)
            f = atoms.get_forces().ravel()
            if sign > 0:
                f_plus = f
            else:
                f_minus = f
        hess[:, j] = -(f_plus - f_minus) / (2.0 * h)
        atoms.set_positions(pos0)
    hess = 0.5 * (hess + hess.T)  # 数值噪声对称化（解析 Hessian 本身对称）

    # 3) 质量加权对角化：λ 单位 eV/(Å²·amu) → ν_THz = sqrt(λ)·sqrt(16.02176634/1.66053906892e-27)/(2π·1e12)
    masses = np.repeat(atoms.get_masses(), 3)
    hess_mw = hess / np.sqrt(np.outer(masses, masses))
    eigvals = np.linalg.eigvalsh(hess_mw)
    freq_factor = math.sqrt(16.02176634 / 1.66053906892e-27) / (2.0 * math.pi * 1e12)
    # 平动零模（周期晶胞 Γ 点声学模）与真虚频分开计数：零模不进振动闭式（如实声明），
    # 真虚频拒绝锚点（鞍点）——两种情况都不静默修正。
    tol = float(params.get("zero_mode_tol", 1e-4))
    real_freqs = sorted(math.sqrt(lam) * freq_factor for lam in eigvals if lam > tol)
    zero_modes = int(((eigvals >= -tol) & (eigvals <= tol)).sum())
    n_imag = int((eigvals < -tol).sum())

    return {
        "converged": bool(converged),
        "u0_eV": u0,
        "n_atoms": len(atoms),
        "n_modes": n3,
        "frequencies_thz": real_freqs,
        "zero_modes": zero_modes,
        "imaginary_modes": n_imag,
        "displacement_angstrom": h,
        "wall_seconds": round(_time.time() - t0, 3),
    }


def handle(method: str, params: dict):
    if method == "hello":
        # 实测态回读（①）：ASE 可导入时携带实际版本，供引擎指纹从声明态升级；
        # 不可用时 None（诚实降级，不冒充已知）
        try:
            import ase as _ase  # noqa: PLC0415
            ase_version = getattr(_ase, "__version__", None)
        except Exception:
            ase_version = None
        return {
            "sidecar": "saturday-ase-calc",
            "version": "0.1.0",
            "calculators": available(),
            # 契约 §5.1：md 能力声明（遍历对账时间平均侧，§4.5）；harmonic：谐波锚点数据面（§9 第二档锚点物理化）
            "operations": {"relax": True, "calculate": True, "md": True, "harmonic": True},
            "eventGranularity": "iteration",
            "aseVersion": ase_version,
        }
    if method == "relax":
        return relax(params)
    if method == "calculate":
        return calculate(params)
    if method == "md":
        return md(params)
    if method == "harmonic":
        return harmonic(params)
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
