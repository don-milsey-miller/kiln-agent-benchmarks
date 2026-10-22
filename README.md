# Kiln private coding-agent benchmark

This repository holds the non-production benchmark definition and public,
sanitized evidence for comparing coding agents on historical Kiln tasks. Kiln's
production repository is used read-only for provenance and reconstruction.

## Current milestone

MS0 (provenance) and MS1 (historical red/green validation) were evaluated on
2026-10-22. Two cases are ready and one is blocked:

| Task | Status | Result |
| --- | --- | --- |
| S1 / issue #160 | `not_benchmark_ready` | The provisional pair is invalid and the corrected pre-fix revision did not reproduce the failure on the Windows PTY runner. |
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

No model was run and no RunPod resources were provisioned during MS0/MS1.
