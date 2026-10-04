# Documentation reading path

Current source baseline: `7ce7aa8020bc9bdf0c70648d175632e19f65b7d6`, inspected October 4, 2026. [Repository README](../README.md) introduces usage and setup.

1. [Architecture](architecture.md): actual components, imports, dataflows, state/resource ownership and extension recipes.
2. [GraphIR contract](graph-ir-contract.md): canonical schema, source/revision identity, navigation intent and cache-key definitions.
3. [Next steps and test responsibility](architecture-next-steps.md): ranked, independently reviewable proposals and their approval/regression boundaries.
4. [Profiling and verification](architecture-profiling.md): reproducible measurement plan, this run's bounded local baseline and missing evidence.

Use [Deployment and operations](deployment.md) for runtime configuration, limits, recovery and deployment procedures. Use [CodeVisualizer dependency](codevisualizer-core-dependency.md) for pin/setup/update mechanics. Neither guide authorizes production changes.

## Documentation inventory and authority

| Document | Role and how to read it |
| --- | --- |
| [File-layer limitations](file-layer-limitations.md) | Current semantic caveats plus explicitly historical provisioning incidents. Consult the runbook for current operations. |
| [Function renderer](function-layer-renderer.md) | Historical design/comparison and semantics, with current full-label behavior noted at the top. Old dimensions/truncation and screenshots are not current acceptance. |
| [Repository density](repository-layer-density.md) | Historical MOO-69 measurements/proposals. Main-route ingestion cap and label behavior were superseded; PR dialog exception is in the architecture guide. |
| [Garrison handoff](garrison-handoff.md) | Historical product-evaluation questions, updated by a supersession note; not an implementation backlog to execute wholesale. OA-210/product outcomes remain unresolved. |
| [Baseline](baseline.md) | Longitudinal implementation/test/deployment record. Commands and deployment claims within historical stages are not the current setup entrypoint. |
| [Integration review, October 4](integration-review-20261004.md) | Earlier integration snapshot including a red upstream-label gate; keep this evidence, then read the later acceptance report. |
| [Integration acceptance, October 4](integration-acceptance-20261004.md) | Local evidence at exact adoption trees; later GitHub release updates record merge/deploy. Not fresh tests or proof of complete product acceptance. |
| [Full-label repair review](full-label-repair-review.md) | Historical independent review of the original label lane; later integrated raw-label repair supersedes its implementation status. |
| [superpowers plans/specs](superpowers/) | Dated security-scanner and layer-direction design records; not a general current architecture guide. |
| [Card README](../card/README.md) | Separate GitHub Action usage and card gallery. |

The October 4 release updates in [#27](https://github.com/OwenTanzer/codeflow/issues/27#issuecomment-5982498675), [#28](https://github.com/OwenTanzer/codeflow/issues/28#issuecomment-5982499249) and [#29](https://github.com/OwenTanzer/codeflow/issues/29#issuecomment-5982499768) supersede older implementation-pending prose without completing all checklists. [PR #34](https://github.com/OwenTanzer/codeflow/pull/34) records merge/deploy at `7ce7aa8`. #30's current task begins safe documentation mapping only.
