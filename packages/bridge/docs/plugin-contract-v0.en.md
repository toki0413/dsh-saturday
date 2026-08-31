# Saturday Plugin Contract — English Digest

**Version**: v0 (experimental)
**Authoritative text**: this is a translation digest of
[`plugin-contract-v0.md`](./plugin-contract-v0.md) (Chinese). Where the two differ,
the Chinese original and the contract test suite prevail. Section numbers below map
1:1 to the original.

---

## 1. Positioning and scope

Saturday is a **plugin runtime for materials computation**: engines, structure sources,
workflows, and analysis tools all mount as plugins. **dsh (DeepSeek Harness) is the only
official host**; bare cordis is not a second host but the dev/CI mode of the same kernel
(Cordis v4). This document defines the seam contracts between plugins and the runtime —
the "constitution" of the ecosystem, taking precedence over any single feature.

### 1.1 The three disciplines

| Discipline | Content |
|---|---|
| **Dependency hygiene (anti-corruption layer)** | Plugins depend only on the `SaturdayRuntime` interface exposed by `@saturday/kernel`; importing cordis/dsh is forbidden. Upstream breaking changes are confined to a single adapter file. |
| **Contract is the constitution** | This document + the contract test suite form the compatibility commitment; when doc and tests conflict, tests prevail. |
| **Lean core** | Everything is a plugin by default; entering the core requires proof (cross-plugin consistency / performance / security, pick one). |

### 1.2 Reversibility scopes (three levels; never conflate)

| Scope | Semantics | Mechanism |
|---|---|---|
| Software resources | Fully reversible | Every registration is an effect, auto-reverted on unload (cordis semantics) |
| Computation tasks | Idempotent + cancellable; no rollback of completed computations | `inputHash` dedup; tasks cancellable, no orphan processes |
| Physical devices | Never rolled back | Approval + audit + parameter allowlists (out of scope for v0) |

## 2. Plugin shape and lifecycle

Each plugin is an npm package default-exporting `{ name, apply }`. `apply(ctx, config)`
may only return `void | Promise<void> | disposer` (cordis v4); returning an arbitrary
object is rejected as an effect. Runtime handles are attached via `ctx.fiber.store`.

Lifecycle rules: (1) registration is an effect — nothing may survive `fiber.dispose()`;
(2) unload must not interrupt running tasks — hot engine switching only swaps the
"current engine" pointer; (3) failure means not mounted — no half-mounted state;
(4) missing config falls back to declared defaults or fails explicitly — never silent
degradation to undeclared behavior.

## 4. The seam contracts

### 4.1 structure-resolver — structure source plugins

Table-lookup style sources (prototype libraries, databases). Resolved structures carry
lineage entries recording their origin. Distinct from §4.5: lookup sources return known
structures; samplers return candidates drawn from a distribution.

### 4.2 potential-provider — engine plugins

Providers implement `relax` / `calculate` / optional `md` primitives and declare
capabilities via `manifest` for routing. Key clauses:

- **Routing contract**: routing authority belongs to `PotentialRegistry` (autoRoute scores
  by task profile); providers never pick their own substitutes; an explicit `engine`
  argument overrides routing. Unavailable engines are rejected with `ENGINE_UNAVAILABLE` —
  never silently replaced.
- **Property capability gate**: baseline quantities (energy/forces) are implicit for any
  `calculate` capability; all other properties must be declared in
  `capabilities[].properties`. Undeclared properties are explicitly rejected
  (`PROPERTY_UNSUPPORTED`) — silently returning `null` is forbidden.
- **Results are immutable facts**: once returned, they enter lineage and Trajectory.
- **Idempotence**: same `graph + params` ⇒ same result (cache hits allowed). `md` is the
  exception: idempotence holds only under a fixed `params.seed`.

### 4.3 workflow — workflow plugins

Workflows are orchestration plugins (screening, free energy, ergodic reconciliation, …).
They compose engine primitives, never reimplement physics; they attach to the contract
test suite where applicable and register tools with explicit output rendering.

### 4.4 analysis — analysis plugins

Input/output type declarations + lineage registration are the two freeze points; analysis
results land in Trajectory alongside computation events (NEB barriers, EOS fitting are the
first two implementations).

### 4.5 sampler — inverse-design plugins (sampling semantics)

The entry point for generative inverse design (Boltzmann generators, latent
normalizing flows, crystal diffusion models all mount here). Core clauses:

- **Sampling is the only semantics**: relaxation is a many-to-one projection, so its
  preimage is inherently non-unique. Samplers deliver candidate distributions compatible
  with a target — never "the unique solution". Consumers must present non-uniqueness and
  likelihood together with candidates.
- **Candidates do not self-attest**: every candidate must be verifiable by sending it to
  an engine (`relax`/`calculate`); the generate → relax → reconcile loop is enforced by
  workflow orchestration. The engine is the only oracle.
- **Declarations are executable**: `likelihood: 'exact' | 'approximate' | 'none'` must be
  truthful — no pseudo-likelihoods; `invertible: false` must not provide `encode`
  (callers get an explicit error).
- **Ergodic reconciliation (oracle clause)**: given `energyModel`, ensemble statistics
  must reconcile against MD time averages of the same energy function; the reconciliation
  tool lives in the workflow seam, not inside the sampler.
- **Multi-anchor mixture proposals**: single-peak samplers are local; cross-basin
  exploration is orchestrated as weighted mixtures of anchors with closed-form mixture
  likelihoods (no downgrade of `'exact'`). An anchor store (provenance-checked retrieval)
  feeds mixture targets from accumulated closed-loop trajectories.

#### Anchor store, persistence, and data governance (§4.5.1–4.5.3)

The anchor pipeline is the data foundation beneath mixture proposals:

- **Anchor store** (session-scoped, pure layer): `add` requires lineage; `retrieve`
  applies a topology gate plus composition L1 distance ordering (missing composition ranks
  last with `distance: null`); empty retrieval refuses to fabricate anchors.
- **Auto-ingest**: converged relaxations deliver their final structure into the store
  automatically, with provenance declared from the job; non-converged results and legacy
  payloads without final structures are refused — input never impersonates the relaxed
  product.
- **Persistence**: `sampler.anchor.save` / `load` are transport primitives over lossless
  JSON payloads (`saturday-anchor-store/2` with per-entry `saturday-anchor-entry/1`
  stamps). Gates-first integrity: read/parse/version/size/entry stamps all pass before any
  reload begins; corrupted entries are localized, never guilt-by-association; multi-payload
  merges deduplicate by lineage.
- **Governance**: `sampler.anchor.audit` is a read-only three-state lineage audit
  (traceable / untracked / corrupt) with actionable repair hints; `sampler.anchor.repair`
  writes a new payload under per-entry explicit authorization (the original is kept as
  evidence; corruption is never repaired into existence); auditing is repair's acceptance
  surface; `sampler.anchor.stats` observes capacity without mutating.
  Observe → repair → accept → ingest is the four-ring chain.
- **Trigger criteria**: `trajectoryTriggerAssessment` reconciles capacity readings against
  caller-declared thresholds (quantity / coverage / trackable-ratio dimensions reported
  independently); conclusions persist as snapshots (`saturday-trigger-snapshot/1`) that
  survive sessions verbatim; `trajectoryTriggerReadiness` reports the presence/gaps of the
  five infrastructure surfaces (observation / criterion / snapshot / repair / derivation).
  Reports are presented, not enforced — criteria inform decisions, they do not gate them.

### 4.6 derivation — derivation registry (liveness foundation)

Every derived quantity registers its derivation inputs; upstream invalidation propagates
downstream along the derivation graph (idempotently); frozen results (experimental data,
delivered artifacts) receive correction entries instead of recomputation.

### 4.7 Units and capability fingerprint

The generalization foundation for heterogeneous engine ecosystems, enforced as three
gates:

- **M1 (registration gate)**: `manifest.units` (energy/length/time triple; values outside
  the allowlist or wrong dimensions are rejected) and `manifest.fingerprint`
  (`software`/`method` required; `version` degrades to `'unknown'` when unobtainable) are
  validated at registration.
- **M2 (activation gate)**: hot-switching emits an event carrying a `fingerprintChange`
  diff declaration — stating why old energies are no longer comparable (invalidation
  propagation closes the loop).
- **M3 (energy-combination gate)**: before energies from different provenances enter a
  convex hull or ranking, fingerprint/units are reconciled; heterogeneous sources or unit
  systems are explicitly rejected — no silent mixing, no silent conversion. Explicit
  `unitConvert` is caller-initiated only and leaves a `convertedFrom` audit trail
  (declaration ≠ substitution; factors are mechanically recomputable).

Supporting mechanisms:

- **Runtime version read-back**: `stampFingerprint` upgrades the fingerprint `version`
  from `'unknown'` to a probed value (enriching `version` only; probe failure never
  stamps). Fingerprint comparison applies an `unknown` wildcard on the version dimension:
  unprobed is not evidence of difference.
- **Availability pre-flight**: `engine.availability` reports per engine — registration is
  the declaration layer, availability is the runtime layer. A pre-flight is a query, not a
  mutation (`stamp` defaults to false).

### 4.8 Evidence composition law (joint ranking over multiple evidence sources)

`combineEvidence` (pure layer) adds log-weights of independent evidence sources under
three disciplines:

1. **Independence declaration is mandatory** (missing ⇒ `EVIDENCE_INDEPENDENCE_UNDECLARED`);
   sources may declare a dependency-variable vocabulary (`variables`), machine-audited
   three-state (independent / degenerate / unverifiable): detected shared variables must be
   explained in the declaration text;
2. **Per-candidate evidence masks**: missing is missing — zero-fill is forbidden (log
   weight 0 = fabricated neutral evidence); candidates with no source coverage are refused
   from ranking (`EVIDENCE_NO_COVERAGE`);
3. **log-sum-exp normalization** (shift-invariant) + combination-cap gate + source-name
   deduplication.

Evidence sources are registry-driven descriptors `{ name, requires, logWeights,
independenceNote }` (optional `variables`); injecting a custom source changes no screening
code. Built-in sources: energy (enumeration/sampling recheck), distance-to-hull (`hull`),
and ideal mixing entropy (`mixing-entropy`, per-candidate composition prior −Σ x·ln x).

## 5–7. Handshake, domain objects, events

- **hello handshake**: the compute bridge declares capabilities (e.g. available
  calculators) at handshake; consumers branch on it.
- **Event granularity**: `eventGranularity: 'iteration' | 'job'` — orchestrators must not
  request finer monitoring than declared (`GRANULARITY_UNAVAILABLE`).
- **Material**: immutable domain object; `substitute` returns a fork (lineage appended,
  original untouched); results and views flow through lineage + append-only Trajectory.
- **Dual-channel events**: computation events and analysis events share one provenance
  chain; Trajectory is append-only and replay rebuilds indexes with anti-reinjection
  prefixes (decisions are reversible; physics is not).

## 8. Compatibility and version governance

Semver within v0 allows breaking changes; the contract test suite
(`@saturday/contract-tests`) is the executable compatibility promise across five seams
(structure-resolver / potential-provider / workflow / sampler / derivation). New plugins
pass the constitution by running `npm test`.

**Current baseline** (mechanically regenerated by `npm run summary`):
workspace regression **335/335** across 19 packages + summary layer 7/7;
Appendix A lists **76** clause-to-test evidence mappings.

**Release form**: per-package `files` whitelists keep artifacts to implementation and
necessary data (verified mechanically by `scripts/pack-check.mjs`); `repository` / `bugs`
metadata point at the real repository (github.com/toki0413/dsh-saturday).

## Appendix A (digest)

Appendix A maps each contractual clause to its enforcing test (full table in the Chinese
original). The most recent capabilities, grouped by theme:

- **Cross-engine comparability**: four-stage evidence chain across engines — delivery
  declaration → M3 interception → M2 fingerprint-change event → dual-engine comparison;
  plus the conversion audit channel (`convertedFrom`, mechanically recomputable factors).
- **Runtime read-back and availability**: fingerprint stamping with per-engine probing
  (sidecar handshake / binary banner / `__version__`) and the `unknown` wildcard;
  availability pre-flight demos and the `engine.availability` query tool.
- **Mixture sampling**: multi-anchor mixture proposals with closed-form likelihood
  recomputation (zero deviation from the `'exact'` declaration) and real-engine oracle
  recheck; the second built-in evidence source (ideal mixing entropy) demonstrating the
  extensibility of the composition law.
- **Evidence independence**: machine audit of evidence-source independence over a
  declarative `variables` vocabulary; the gate rejects shared variables unexplained by the
  independence declaration; per-source mask counts are delivered with results.
- **Anchor pipeline**: provenance-mandatory ingest → topology + composition retrieval →
  mixture proposals → anchor-guided closed loop (`demo:anchor-guided`: ingest, retrieve,
  propose, real-EMT recheck, joint ranking with Σw = 1) → fully automatic ingest from
  converged relaxations (`demo:anchor-auto`) — with honest degradation for unknown
  composition (`distance: null` ranks last without fabricating values, yet still
  participates in mixtures).
- **Agent-layer orchestration**: anchor tools, audit, repair, and reload all reachable
  through natural language in `demo:agent`; tool-to-tool handoff carries deliverables
  only; the lossless-JSON tool-exit gate is enforced end to end; largest-remainder quota
  allocation is closed-form and seed-invariant.
- **Persistence and resume**: lossless-JSON save/load primitives with gates-first
  integrity (version stamps, size reconciliation, entry-level corruption localization,
  multi-payload merged reload with lineage dedup); `demo:anchor-resume` carries lineage
  across sessions — reloaded anchors participate immediately, and behavior is provably
  lossless across the disk round-trip.
- **Governance**: read-only three-state lineage audit with repair hints; payload-side
  repair under per-entry explicit authorization (original kept as evidence; corruption
  never repaired into existence); repaired-and-accepted payloads become data fuel with
  lineage using the repaired source — observe → repair → accept → ingest, fully linked at
  the Agent layer.
- **Trigger criteria**: capacity observation (`stats`) reconciled against caller-declared
  thresholds; conclusions persisted as verbatim snapshots that survive sessions;
  criterion conclusions optionally registered as derivations so evidence invalidation
  revokes them; a readiness report over the five infrastructure surfaces.
- **Release readiness**: failure drills (torn payloads and snapshots refused with zero
  store pollution; one-good-one-bad merges refused whole-batch); order-of-magnitude
  performance readings at thousand scale presented as facts without gates; per-package
  `npm pack --dry-run` verification (version consistency + `files` whitelist).

## Citation

The architectural paradigm is grounded in:

> Yifan Shi, Wei Zhang, Tianyi Cui. *A Programming Paradigm for Spatiotemporal
> Composability*. arXiv:2608.25512 [cs.PL], 2026.
