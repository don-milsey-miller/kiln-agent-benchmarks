# Kiln private coding-agent benchmark

This repository holds the non-production benchmark definition and public,
sanitized evidence for comparing coding agents on historical Kiln tasks. Kiln's
production repository is used read-only for provenance and reconstruction.

## Current milestone

MS0 (provenance) and MS1 (historical red/green validation) were evaluated on
2026-10-22. The original S1 case was rejected and replaced with issue #162.
All three current cases are ready:

| Task | Status | Result |
| --- | --- | --- |
| S1 / issue #162 | `ready` | A real Windows PTY returned string `"yes"` before the fix and Boolean `true` after it; the fixed setup path invokes its stubbed canary exactly once. |
| M1 / issue #200 | `ready` | Native Windows red/green reproduction confirmed the crash status, release, and cleanup behavior. |
| L1 / issue #215 | `ready` | The pre-fix wrapper omitted the research route; the fixed wrapper and real-child loopback tests passed. |

See [`reports/MS0-PROVENANCE.md`](reports/MS0-PROVENANCE.md),
[`reports/MS1-HISTORICAL-VALIDATION.md`](reports/MS1-HISTORICAL-VALIDATION.md),
and [`manifests/tasks.public.json`](manifests/tasks.public.json).

## Confidential boundary

This GitHub repository is currently **public**. Evaluator source, raw logs,
working clones, and private manifests are therefore ignored and remain only in
the local `C:\Users\milsy\Documents\kiln-ai-benchmark` checkout. Do not push
those files unless the repository is made private and the boundary is reviewed.

MS2 then built history-free task bundles, private independent graders, a bounded
Pi/vLLM execution adapter, and a versioned result schema. MS3 exercised ten
offline control paths through a WSL2 filesystem/network namespace; every
classification and isolation assertion matched. See
[`reports/MS2-ISOLATION-RUNNER.md`](reports/MS2-ISOLATION-RUNNER.md) and
[`reports/MS3-OFFLINE-DRY-RUN.md`](reports/MS3-OFFLINE-DRY-RUN.md).
Repeatable local commands are documented in
[`docs/OFFLINE-HARNESS.md`](docs/OFFLINE-HARNESS.md).

The rejected issue #160 audit is retained for traceability. No model was run and
no RunPod resources were provisioned during MS0–MS3.

MS4 ran the separately authorized nine-attempt pilot on one three-GPU RunPod
instance. All attempts completed or reached their bound without an inference or
infrastructure error, but none passed the independent hidden grader: six failed
behavioral tests, one timed out, and two violated the frozen file-scope policy.
The pod was terminated after artifact verification. The rounded account debit
was **$20.02**, within the approved **$50** ceiling. See the
[`HTML report`](reports/MS4-PAID-PILOT.html),
[`Markdown summary`](reports/MS4-PAID-PILOT.md), and
[`structured evidence`](evidence/ms4-results.json).
