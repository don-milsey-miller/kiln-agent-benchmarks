# MS2 — isolation, grading, and bounded runner

## Outcome

MS2 passed its offline implementation gate on 2026-10-22. No GPU, RunPod
instance, hosted model, or paid API was used.

## Agent bundles

Each agent-visible bundle is produced with `git archive` from the audited
pre-fix SHA. It contains no `.git` directory, Git remote, later commit, fixing
patch, hidden evaluator, raw log, or private manifest.

| Task | Pre-fix SHA | Files | Tree SHA-256 |
| --- | --- | ---: | --- |
| S1 | `4dbfc49bc567ba13656531872c4c3c5e5e9f3001` | 1,151 | `b7f66efe6d98f4221228b9692060c063898a41fff638fe9c1ac479a8b6b0c686` |
| M1 | `b641f6d45821a1fd17a51718622b3879ebead0ac` | 1,208 | `d6a9de945c4395765c3fd7195d7cae9c14349852388de1a7adda7123fc506a9d` |
| L1 | `ba251ce1ddc70656a7cae5628e4ea64d4ec8fe23` | 1,208 | `48516d78a1526960cb79cdf4fc05c6df5175ac42a97675a49628986c8883c508` |

Generated bundles and their detailed manifests remain under ignored
`artifacts/private/` paths.

## Grading boundary

The runner computes the candidate delta, rejects forbidden or out-of-scope
paths, and replays only allowed production changes onto a fresh pre-fix tree.
Agent-modified tests, package manifests, evaluator files, and CI configuration
are never transferred to the grader.

Private task graders were rerun against both historical sides. All three failed
their hidden behavioral check before the fix and passed after it. Their selected
unchanged regression groups passed 27/29 tests for S1's historical pre/fixed
trees, 5/6 for M1, and 72/72 for L1. M1 remains a native Windows grading step.

## Runner controls

- Separate disposable agent and grader workspaces.
- Explicit per-task production-path allowlists.
- Bounded execution, cancellation classes, and descendant cleanup.
- JSONL protocol validation and bounded stdout/stderr capture.
- Stable result classes and a versioned run-result schema.
- Immutable model repository revisions and the measured vLLM/Pi profile.
- A fixed three-task × three-model plan, one model per assigned GPU.
- Readiness and budget gates that fail closed.
- A required external MS4 authorization record; none currently exists.

The offline WSL2 backend uses user, mount, PID, and network namespaces, replaces
`/mnt` with an empty filesystem, and starts the agent with an empty environment
plus a minimal allowlist. The grader and raw evidence remain on the Windows host
and are not mounted into the agent namespace.

## Deployment boundary

Paid execution is deliberately disabled. A RunPod/RHEL deployment must first
attest a dedicated unprivileged agent identity and a network relay that exposes
only the selected loopback vLLM endpoint. This is a deployment readiness check,
not permission to provision a Pod or begin MS4.
