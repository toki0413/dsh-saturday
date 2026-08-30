# Saturday Plugin Contract — English Digest

**Version**: v0 (experimental) · **Digest date**: 2026-08-30
**Authoritative text**: this is a faithful translation **digest** of
[`plugin-contract-v0.md`](./plugin-contract-v0.md) (Chinese). Where the two differ,
the Chinese original and the contract test suite prevail ("contract is the constitution,
tests are the verdict"). Section numbers below map 1:1 to the original.

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
| **Dependency hygiene (anti-corruption layer)** | Plugins depend only on the `SaturdayRuntime` interface exposed by `@saturday/kernel`; importing cordis/dsh is forbidden. The goal is not host-neutrality but confining upstream breaking changes to a single adapter file. |
| **Contract is the constitution** | This document + the contract test suite form the compatibility commitment; when doc and tests conflict, tests prevail. |
| **Lean core** | Everything is a plugin by default; entering the core requires proof (cross-plugin consistency / performance / security, pick one). |

### 1.2 Reversibility scopes (three levels; never conflate)

| Scope | Semantics | Mechanism |
|---|---|---|
| Software resources | Fully reversible | Every registration is an effect, auto-reverted on unload (cordis semantics) |
| Computation tasks | Idempotent + cancellable; **no rollback of completed computations** | `inputHash` dedup; tasks cancellable, no orphan processes |
| Physical devices | **Never rolled back** | Approval + audit + parameter allowlists (out of scope for v0) |

## 2. Plugin shape and lifecycle

Each plugin is an npm package default-exporting `{ name, apply }`. `apply(ctx, config)`
may only return `void | Promise<void> | disposer` (cordis v4); returning an arbitrary
object is rejected as an effect. Runtime handles are attached via `ctx.fiber.store`.

Lifecycle rules: (1) registration is an effect — nothing may survive `fiber.dispose()`;
(2) unload must not interrupt running tasks — hot engine switching only swaps the
"current engine" pointer; (3) failure means not mounted — no half-mounted state;
(4) missing config falls back to declared defaults or fails explicitly — never silent
degradation to undeclared behavior.

## 4. The five seam contracts

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

**Units and capability fingerprint (M1/M2/M3 — the generalization foundation for
heterogeneous engine ecosystems):**

- **M1 (registration gate)**: `manifest.units` (energy/length/time triple; values outside
  the allowlist or wrong dimensions are rejected) and `manifest.fingerprint`
  (`software`/`method` required; `version` honestly degrades to `'unknown'` when
  unobtainable) are validated at registration.
- **M2 (activation gate)**: hot-switching emits an event carrying a `fingerprintChange`
  diff declaration — stating *why* old energies are no longer comparable (liveness /
  invalidation propagation closes the loop).
- **M3 (energy-combination gate)**: before energies from different provenances enter a
  convex hull or ranking, fingerprint/units are reconciled; heterogeneous sources or unit
  systems are explicitly rejected — no silent mixing, no silent conversion. Explicit
  `unitConvert` is caller-initiated only and leaves a `convertedFrom` audit trail
  (declaration ≠ substitution; factors are mechanically recomputable).
- **Runtime version read-back (①)**: declared state ≠ measured state. `stampFingerprint`
  upgrades the fingerprint `version` from `'unknown'` to a probed value (enriching
  `version` only; probe failure never stamps). Fingerprint comparison applies an
  `unknown` wildcard on the version dimension: unprobed is not evidence of difference.

### 4.3 workflow — workflow plugins

Workflows are orchestration plugins (screening, free energy, ergodic reconciliation, …).
They compose engine primitives, never reimplement physics; they attach to the contract
test suite where applicable and register tools with explicit output rendering.

### 4.4 analysis — analysis plugins

Input/output type declarations + lineage registration are the two freeze points; analysis
results land in Trajectory alongside computation events (NEB barriers, EOS fitting are the
first two implementations).

### 4.5 sampler — inverse-design plugins (sampling semantics; clauses frozen)

The **only entry point for generative inverse design** (Boltzmann generators, latent
normalizing flows, crystal diffusion models all mount here). Core clauses:

- **Sampling is the only semantics**: relaxation is a many-to-one projection, so its
  preimage is inherently non-unique. Samplers deliver candidate distributions compatible
  with a target — never "the unique solution". Consumers must present non-uniqueness and
  likelihood together with candidates.
- **Candidates do not self-attest**: every candidate must be verifiable by sending it to
  an engine (`relax`/`calculate`); the generate → relax → reconcile loop is enforced by
  workflow orchestration. The engine is the only oracle.
- **Honest declarations are executable**: `likelihood: 'exact' | 'approximate' | 'none'`
  must be truthful — no pseudo-likelihoods; `invertible: false` must not provide `encode`
  (callers get an explicit error).
- **Ergodic reconciliation (oracle clause)**: given `energyModel`, ensemble statistics
  must reconcile against MD time averages of the same energy function; the reconciliation
  tool lives in the workflow seam, not inside the sampler.
- **Multi-anchor mixture proposals**: single-peak samplers are local; cross-basin
  exploration is orchestrated as weighted mixtures of anchors with closed-form mixture
  likelihoods (no downgrade of `'exact'`). An anchor store (provenance-checked retrieval)
  feeds mixture targets from accumulated closed-loop trajectories.

### 4.6 derivation — derivation registry (liveness foundation)

Every derived quantity registers its derivation inputs; upstream invalidation propagates
downstream along the derivation graph (idempotently); frozen results (experimental data,
delivered artifacts) receive correction entries instead of recomputation.

## 5–7. Handshake, domain objects, events

- **hello handshake**: the compute bridge declares capabilities (e.g. available
  calculators) at handshake; consumers branch on it honestly.
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
workspace regression **301/301** across 19 packages + summary layer 7/7;
Appendix A lists **66** clause-to-test evidence mappings.

## Appendix A (digest)

Appendix A maps each contractual clause to its enforcing test. Highlights of the most
recent entries (full table in the Chinese original):

- **49–52**: cross-engine four-stage evidence (unit/fingerprint gates: delivery
  declaration → M3 interception → M2 event → dual-engine comparison), conversion audit
  channel.
- **53**: runtime fingerprint read-back (stamp gate + per-engine probing + `unknown`
  wildcard).
- **54**: availability pre-flight demo (registration = declaration layer, availability =
  runtime layer; both honest).
- **55**: multi-anchor mixture sampling demo (closed-form likelihood recomputation, zero
  deviation; real-engine oracle recheck).
- **56**: second built-in evidence source (ideal mixing entropy −Σ x·ln x; extensibility
  of the Logits composition law demonstrated twice).
- **57**: machine audit of evidence-source independence (declarative `variables`
  vocabulary; three-state audit; gate rejects shared variables unexplained by the
  independence declaration; per-source mask counts delivered).
- **58**: `engine.availability` pre-check tool (query, not mutation: stamping off by
  default; registry never shrinks on probe failure).
- **59**: anchor store for mixture proposals (lineage-mandatory ingest, topology gate
  + composition L1 retrieval, empty retrieval refuses to fabricate anchors) — the
  first segment of the data pipeline toward self-supervised sampling.
- **60**: anchor-guided mixture proposals at the tool layer (`sampler.anchor.add` +
  `sampler.mixture`; session-scoped store, inline-anchor path shares the same pure
  target construction — no gate bypass; candidates never self-certify).
- **61**: anchor-guided closed loop end-to-end (`demo:anchor-guided`: ingest → retrieve
  → propose → real-EMT recheck → joint ranking, Σw = 1; tool-to-tool handoff carries
  deliverables only) + tool-chain contract review (anchor tools stay at the tool layer,
  no new `StructureSampler` seam; §4.5 ruling: `workflow.screen` does not take `anchors`
  directly — two-step orchestration is the composition law itself).
- **62**: closed-loop trajectory auto-ingest (second segment of the self-supervised data
  pipeline): converged relaxation + delivered final structure → relaxed structure auto-
  ingested into the session anchor store (provenance auto-declared `job:<id>#engine=<name>`);
  negative gates enforced (non-converged refused; legacy protocol without final structure
  refused — input never impersonates the relaxed product; idempotent under duplicate
  events); thin-event discipline: structure never duplicated into the Trajectory.
- **63**: anchor tools at the Agent layer (`demo:agent` stage D; tool-exit gate lesson:
  `graph: undefined` overwrite triggers 'not lossless JSON' rejection — explicit
  projection instead) + largest-remainder quota closed-form reconciliation (quota depends
  only on (n, normalized weights), seed-invariant; fractional ties go to the earlier
  anchor).
- **64**: fully automatic anchor-guided closed loop (`demo:anchor-auto`: real relaxations
  auto-ingested via the convergence-event listener — zero manual anchor operations —
  then retrieve → propose → recheck → joint ranking) + unknown-composition honest
  degradation chain (`distance: null` anchors rank last without fabricating values,
  yet still participate in mixtures — ranking last is not exclusion; distance
  declaration delivered faithfully at the tool layer); §4.5 ruling: no eviction/cap
  for the session anchor store (store lives and dies with the closed loop; eviction
  belongs to a persistent store; `topK` already bounds proposal participation).
- **65**: proposal lineage wired into the derivation registry (㉑, live context §8.2:
  optional `derivation` service — one proposal-level record with normalized anchor
  sources as inputs; anchor invalidation propagates to the proposal; untrackable
  sources never fake inputs; behavior unchanged without the service) + ternary
  scalability (㉒: {Cu,Ag,Au} retrieval ordering with the null-distance chain intact,
  three-weight quota closed form [0.5,0.3,0.2]×9 → [4,3,2] seed-invariant, deterministic
  proposal reproduction) + persistent anchor store prototype (㉓: lossless-JSON
  export / gated idempotent import primitives — the store itself stays session-scoped,
  disk persistence is the caller's responsibility, never fabricated).
- **66**: persistence file side + full-chain liveness of ranking-layer proposal refs +
  persistence primitives at the Agent layer (㉔/㉕/㉖): `sampler.anchor.save`/`load`
  (file end of the transport primitives — shared import loop, gates never bypassed;
  error paths honest: missing/corrupt/non-payload files refuse explicitly with
  `ANCHOR_PERSIST`, path always caller-declared; same-store reload idempotent) +
  `demo:agent` stage E (`save`/`load` exposed through the dsh harness — lossless-JSON
  exit gate stress-tested with full graph payloads; disk→reload→skip replay idempotence
  at the Agent layer) + `workflow.screen` accepts `proposalRef` as a ranking-layer
  derivation input: anchor invalidation → proposal invalidation → ranking invalidation
  (three-stage propagation fully live); undeclared behavior unchanged (no fabricated
  derivation inputs); invalid refs rejected by the registry. Division of labor with the
  §4.5 ruling on ⑬: what is not taken directly is `anchors` (structure bodies +
  sampling logic); what is taken directly is a derivation reference (orchestration-layer
  lineage wiring) — the composition law stays intact.

## Citation

The architectural paradigm is grounded in:

> Yifan Shi, Wei Zhang, Tianyi Cui. *A Programming Paradigm for Spatiotemporal
> Composability*. arXiv:2608.25512 [cs.PL], 2026.
