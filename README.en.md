# Saturday — A Plugin Runtime for Materials Computing

[![CI](https://github.com/toki0413/dsh-saturday/actions/workflows/ci.yml/badge.svg)](https://github.com/toki0413/dsh-saturday/actions/workflows/ci.yml)
[![Install on Smithery](https://smithery.ai/badge/toki0413/saturday-materials)](https://smithery.ai/servers/toki0413/saturday-materials)

[简体中文](./README.md) | English

**Everything is a plugin.** Saturday is not another materials-computing engine and replaces no
DFT / MD / FEM / CFD solver. It is the **composition layer** for materials computing: engines,
structure sources, workflows and analysis tools all mount as plugins onto the
**DeepSeek Harness (dsh) / `@deepseek-ai/cordis` v4** runtime, where an agent mounts, unmounts
and composes them freely.

The plugin interface specification lives in
`packages/bridge/docs/plugin-contract-v0.md` (Chinese original, with an English digest alongside).

## Core Paradigm

### Spatiotemporal Composability

Grounded in the companion Cordis paper:

> *A Programming Paradigm for Spatiotemporal Composability*, Yifan Shi, Wei Zhang, Tianyi Cui,
> arXiv:2608.25512 [cs.PL] (Peking University / DeepSeek-AI).

Saturday maps the paper's two orthogonal dimensions onto materials computing:

| Dimension | Paper | Saturday's domain reading | In this repo |
|---|---|---|---|
| Time | Fully invertible component effects (revertible effects) | Research is a suspendable / forkable / replayable event stream; decisions are reversible, physics is not | Compute events → append-only Trajectory with per-variant provenance; `trajectory.replay` rebuilds the index |
| Space | Declared dependencies + reactive management (reactive coeffects) | Cross-engine / cross-scale capabilities activate on demand | Engines declare capabilities at hello handshake; consumers decide dynamically |

### Materials Computing = Two Channels of Events

Runtime behaviour of each engine (DFT/MD/FEM/CFD) projects onto two event kinds; the Saturday bus
only routes, never rewrites physics:

- **Cascade events (causal chain)**: relaxation steps, SCF iterations, MD stepping — a state
  relay that is totally ordered and replayable (time dimension);
- **Broadcast events (one-to-many)**: convergence reached, energy anomaly, property computed —
  many consumers subscribe and react (space dimension).

Event granularity varies by engine (iteration-level ↔ job-level) and is declared explicitly in
the capability handshake.

### Atomic Operations

Every research action decomposes into independently callable, freely composable primitives
(`relax` / `calculate` / `substitute` …), exposed simultaneously to agent tools, DSLs and the
programming API. Atomicity is scoped: the software-resource domain is fully reversible (cordis
effect), the compute-task domain is idempotent + cancellable, the physical-device domain never
rolls back.

### The Living Materials Context

The materials context is a **reactive lineage graph** on top of the cascade-event accumulator:
every exported quantity declares its derivation source, and upstream changes propagate
invalidation downstream automatically. The derivation ledger (`@toki0413/plugin-derivation`) is
the runtime carrier of this shape and is already wired into a real screening workflow (a
hot-swapped potential invalidates the whole chain along engine references). The immutable fork
semantics of `Material.substitute` keeps lineage traceable end to end.

## Capabilities (v0.3)

| Capability | Tool | Notes |
|---|---|---|
| Material loading | `material.load` | Formula → structure (prototype library, TiO2 polymorphs selectable) |
| Molecular structure source | `structure.fromSmiles` | SMILES → 3D conformer (RDKit ETKDG + MMFF/UFF pre-relaxation) → aperiodic Material (pbc=False); explicit error when RDKit is missing, never a silent downgrade |
| Structure relaxation | `potential.relax` | Periodic systems: real ASE EMT physics (UnitCellFilter + BFGS); molecular systems (pbc=False): RDKit MMFF/UFF force-field engine (system–engine matching, mismatches rejected explicitly); pure-Node environments fall back to the zero-dependency `lj-js` engine (LJ toy potential) |
| Doping screening | `workflow.screen` | Batch relaxation of host + N doped variants → energy ranking → per-variant provenance; with an injected reference state it upgrades to strict formation enthalpy + multicomponent convex-hull criteria; multi-concentration scans and co-doping supported; sampled candidates join the joint ranking (energy evidence × proposal likelihood → importance weights); evidence sources are registry-extensible (hull distance, ideal mixing entropy, …) |
| MP structure source | `structure.resolve` | Remote resolution via Materials Project (`@toki0413/plugin-mp`, needs MP_API_KEY) |
| Trajectory replay | `trajectory.replay` | Rebuild the compute index from the append-only event stream (`@toki0413/plugin-replay`) |
| Barrier analysis | `analysis.neb` | NEB minimum-energy path and transition-state barrier (`@toki0413/plugin-neb`) |
| Equation of state | `analysis.eos` | Third-order Birch-Murnaghan fitting (`@toki0413/plugin-eos`) |
| Phonons | `analysis.phonon` | Γ-point phonons: force-injected finite displacement + acoustic sum rule, frequencies / imaginary modes / explicit-threshold stability verdict (`@toki0413/plugin-phonon`) |
| Candidate sampling | `sampler.perturb` | Reference-structure perturbation sampling (`@toki0413/plugin-sampler-perturb`) |
| OU sampling | `sampler.ou` | Ornstein-Uhlenbeck sampling: closed-form transition kernel + exact proposal likelihood; multi-anchor mixture proposals for cross-basin exploration (`@toki0413/plugin-sampler-ou`) |
| Flow sampling | `sampler.flow` | Affine coupling flow: bijective transport with `invertible:true` + exact change-of-variables likelihood, `encode` maps back to latent space (`@toki0413/plugin-sampler-flow`) |
| Random structure search | `sampler.rss` | Uniform random structure generation under composition/count/cell constraints with a minimum-distance gate and seed determinism; second generative implementation of §4.5 (non-flow route), likelihood honestly declared as none (`@toki0413/plugin-rss`) |
| Sample-then-verify loop | `workflow.explore` | Candidates are re-computed by the engine and ranked by energy (the engine is the only oracle, `@toki0413/plugin-explore`) |
| Ergodic reconciliation | `workflow.ergodic` | Sampling ensemble averages vs thermostated MD time averages; verdict strength graded by the sampler's likelihood declaration (`@toki0413/plugin-ergodic`) |
| Configurational free energy | `workflow.freeEnergy` | Temperature-grid thermostated MD + thermodynamic integration; free-energy zero point (anchor) injected explicitly, harmonic approximation supported (`@toki0413/plugin-free-energy`) |
| Live context | `derivation.*` | Derivation ledger: exported quantities declare their source, invalidation propagates along the derivation graph, frozen results take corrections as appends (`@toki0413/plugin-derivation`) |
| Anchor store | `sampler.anchor.*` | Relaxed-and-converged structures auto-ingest (lineage required) → retrieve → mixture proposals; persistence, lineage audit, repair and trigger-criteria reconciliation (data-governance toolchain) |

### MCP server: any MCP host, zero code

The whole tool surface (32 tools) is exposed over the Model Context Protocol via
`@toki0413/mcp-server` (stdio): Claude Desktop, Cursor, Cline or any MCP host connects with no
glue code. Parameter schemas flow straight from each tool's contract declaration; tool failures
surface as MCP `isError` responses carrying structured error codes.

```bash
npx @toki0413/mcp-server        # stdio; SATURDAY_DISABLE excludes plugins
```

Hosted on Smithery: [toki0413/saturday-materials](https://smithery.ai/servers/toki0413/saturday-materials).

Adapter boundary: the MCP server depends only on the hostless bootstrap in `@toki0413/kernel`
(`bootstrapPlugins`; cordis imports stay inside the kernel package) and on plugin packages.
Plugins know nothing about MCP — the anti-corruption-layer discipline is unchanged.

Engine plugin matrix (all wired into the `@toki0413/contract-tests` standard suite):
`emt-mock` (core, ASE EMT / LJ), `lj-js` (zero-dependency pure JS, teaching-grade toy potential,
graceful fallback data plane), `lammps` (batch, job granularity), `mace` (ML potential with
availability pre-check), `ase` (generic ASE calculators, own sidecar).

EMT energy zeros are equilibrium fcc crystals per element; `energyPerAtom` approximates formation
enthalpy. Measured Cu doping screening:
**Cu3Pt (-0.10) < Cu3Au (-0.02) < Cu (0) < Cu3Ni (+0.01) < Cu3Ag (+0.02) eV/atom** — ordering
(Cu-Pt / Cu-Au) vs phase-separation (Cu-Ni / Cu-Ag) tendencies agree with experimental metallurgy.

## Environment Matrix

Out of the box: after `git clone → npm install`, **all 12 demos run on a pure Node environment**
(no extra dependencies). The data plane adapts to the environment and the startup banner reports
it truthfully (not a silent degradation: the fallback engine is an explicitly registered engine).

| Environment | Data plane / engines | Notes |
|---|---|---|
| Pure Node (no Python) | `lj-js` (zero-dependency pure JS, LJ toy potential) | All demos run; teaching-grade accuracy (toy potential declared up front; reference states are engine-self-consistent, not experimental) |
| + Python ≥ 3.10 + ASE ≥ 3.22 | `emt-mock` (real EMT) + `ase` | Unlocks EMT accuracy; falls back honestly if ASE is missing in the sidecar |
| + LAMMPS / MACE | `lammps` / `mace` | Production engines; missing environments are reported truthfully by the availability pre-check (`demo:availability`) |

- **Node ≥ 22** (hard requirement of dsh; bare-cordis tests run on Node 20)
- Python data-plane deps: numpy + scipy (only needed to upgrade accuracy)
- On Windows the `python` command is used by default; override via `bridge.python`
- pnpm

## CI (dual data-plane matrix)

Every push/PR runs two tiers (`.github/workflows/ci.yml`), matching the environment matrix:

| Tier | Environment | Verifies |
|---|---|---|
| zero-deps | Pure Node (no Python dependencies) | The out-of-the-box promise: graceful fallback to `lj-js`, full test suite + demo smoke + release-form check |
| full-fidelity | Node + Python + ASE + scipy | EMT true-physics tier: real relaxation / reference states / roundtrip self-checks + summary regeneration smoke |

Both tiers run the same tests; the suites are environment-adaptive (`HAS_ASE` / `dataPlane`
probing + explicit skips — honest, never silent). True-physics assertions (lattice constants,
strict formation enthalpy, roundtrip self-checks) only execute on the fidelity tier; the
zero-deps tier skips them truthfully instead of faking.

## Structure (npm workspaces)

```
packages/
  kernel/                     # @toki0413/kernel — anti-corruption layer: the only file touching cordis
    src/cordis-adapter.mjs    #   SaturdayRuntime interface + append-only Trajectory
    src/bootstrap.mjs         #   hostless bootstrap + aggregated tool surface (MCP server / CI)
  core/                       # @toki0413/core — domain core (zero runtime dependencies)
    src/material.mjs          #   Material domain object (lineage, views, substitute doping)
    src/potential.mjs         #   PotentialRegistry (engine seam + scored routing + granularity gates)
    src/structure-resolver.mjs#   structure-resolution seam (prototype library, polymorphs + 7 fcc metals)
    src/elements.mjs          #   element table (Z / symbols / electronegativity, formula composition)
  python-bridge/              # @toki0413/python-bridge — generic Python sidecar client
    src/bridge.mjs            #   stdio JSON-lines, handshake / timeout / batching
    sidecar.py + adapters/    #   main sidecar: per-call routing ASE EMT / LJ fallback by element
  contract-tests/             # @toki0413/contract-tests — contract suite (compatibility by test, not promise)
    src/index.mjs             #   structureResolver / potentialProvider / workflow / sampler / derivation
  bridge/                     # @toki0413/bridge — dsh bundle (the saturday main plugin)
    src/saturday.plugin.mjs   #   cordis plugin entry { name, apply }
    profiles/cordis.patch.yml #   example mount line for a dsh profile
    docs/plugin-contract-v0.md#   Plugin Contract v0 (experimental)
    docs/contract-coordinates.* #  contract coordinates (saturday.contract/v0) + TUI admission self-check
  mcp-server/                 # @toki0413/mcp-server — MCP protocol projection of the tool surface (32 tools)
plugins/                      # plugin ecosystem (new plugins must pass the contract suite)
  screening/                  #   workflow: batch doping screening
  mp-structure-source/        #   structure source: Materials Project
  lammps/ mace/ ase/ lennard-jones/  # engines
  replay/ neb/ eos/ phonon/   #   analysis: replay, NEB, EOS, Γ-point phonons
  sampler-perturb/ sampler-ou/ sampler-flow/  # sampling: perturb / OU mixture / affine flow
  explore/ ergodic/ free-energy/              # workflows: verify loop / ergodic check / free energy
  derivation/                 #   live context: invalidation propagation + lazy recompute
```

## Running

```bash
npm install             # workspaces: @deepseek-ai/cordis (peer) + all @toki0413/* linked
npm test                # all workspace tests
npm run summary         # regenerate the project summary (runs every suite + parses the contract evidence table → SUMMARY.md/.json)
node scripts/pack-check.mjs   # release-form check (per-package pack dry-run: version consistency + files whitelist)

# End-to-end demos (none need an API key; all run on pure Node:
# without Python the data plane falls back to the zero-dependency lj-js engine, banner reported truthfully)
npm run demo --workspace @toki0413/bridge                    # basic end-to-end
npm run demo:screening --workspace @toki0413/bridge          # doping screening (environment-adaptive: EMT or lj-js)
npm run demo:screening-ternary --workspace @toki0413/bridge  # ternary screening (multicomponent convex hull)
npm run demo:concentrations --workspace @toki0413/bridge     # multi-concentration / co-doping scans
npm run demo:freeenergy --workspace @toki0413/bridge         # configurational free energy (Langevin MD + harmonic anchor)
npm run demo:cross-engine --workspace @toki0413/bridge       # cross-engine comparison (unit / fingerprint gates)
npm run demo:availability --workspace @toki0413/bridge       # engine availability pre-check
npm run demo:mixture-sampling --workspace @toki0413/bridge   # multi-anchor mixture sampling
npm run demo:anchor-guided --workspace @toki0413/bridge      # anchor-guided loop (ingest → retrieve → propose → verify → rank)
npm run demo:anchor-auto --workspace @toki0413/bridge        # fully automatic anchor loop
npm run demo:anchor-resume --workspace @toki0413/bridge      # cross-session resume (persist → refill → continue)
npm run demo:agent --workspace @toki0413/bridge              # agent session end-to-end (mock LLM, ten stages)
```

## Mounting on dsh (full runtime)

```bash
npm i @deepseek-ai/dsh                 # requires Node ≥ 22
export DSH_HOME=~/.dsh
dsh web --help                         # first run initializes the web profile
# 1) declare in $DSH_HOME/profiles/web/package.json dependencies:
#    "@toki0413/bridge": "file:/path/to/Saturday/packages/bridge"
# 2) cd $DSH_HOME/profiles/web && pnpm install
# 3) copy the - insert: line from packages/bridge/profiles/cordis.patch.yml into the profile's cordis.patch.yml
dsh --profile web --dump-config        # verify the composition tree contains the saturday line
dsh web                                # launch
```

`demo:agent` shows the full orchestration of an agent session: a bare-cordis process assembles
all the real dsh services plus a scripted mock model, covering ten stages — material loading,
real relaxation, sampling with joint ranking, anchor persistence and resume, lineage audit,
repair acceptance and backfill — all driven in natural language.

## Design Principles

- **The contract is the constitution**: `@toki0413/contract-tests` ships standard assertion sets
  for five seams (structure-resolver / potential-provider / workflow / sampler / derivation);
  a new plugin runs `npm test` to pass the constitution. Compatibility is promised by tests,
  not by documentation.
- **Anti-corruption layer (dependency hygiene)**: domain code never imports cordis; upstream
  breakage is contained to one adapter file. dsh is the only official host; bare cordis is the
  development / CI mode.
- **Units and capability fingerprints are contractual**: engine registration validates the unit
  triple and capability fingerprint; conversions are caller-initiated only; energies from
  different sources or units are rejected before entering comparison paths. Measured versions
  can be stamped back at runtime (`demo:cross-engine` / `demo:availability`).
- **Thermodynamic honesty**: energy zeros are declared explicitly — strict formation enthalpy
  and convex-hull criteria need explicit reference states, and degrade honestly when unavailable.
  The same holds for free-energy anchors.
- **Sampling semantics**: inverse design is sampling from a compatible distribution, not
  inversion; likelihood evaluability is declared; candidates must be verifiable by recompute —
  the engine is the only oracle.
- **Lineage is liveness**: exported quantities register their derivation source; invalidation
  propagates along the derivation graph; persisted payloads carry traceable declarations and can
  be retracted across sessions.
- **Regenerable summaries**: `npm run summary` mechanically assembles `SUMMARY.md` from test
  output and the contract evidence table — never hand-written, never hand-maintained.

## Citation

Saturday's architecture paradigm builds on:

```bibtex
@misc{shi2026cordis,
  title         = {A Programming Paradigm for Spatiotemporal Composability},
  author        = {Shi, Yifan and Zhang, Wei and Cui, Tianyi},
  year          = {2026},
  eprint        = {2608.25512},
  archivePrefix = {arXiv},
  primaryClass  = {cs.PL},
  url           = {https://arxiv.org/abs/2608.25512}
}
```

## License

MIT
