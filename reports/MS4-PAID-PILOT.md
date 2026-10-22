# MS4 — nine-run paid pilot

Experiment: `ms4-pilot-20261022` · Runs: **9/9** · Passed: **0** · GPU-hours: **1.44** · Billed cost: **$20.02**

| Run | Task | Model | Classification | Agent seconds | Changed files | Targeted | Regressions |
| --- | --- | --- | --- | ---: | ---: | --- | --- |
| l1-gemma | L1 | gemma | `failed_tests` | 484.0 | 1 | false | false |
| l1-muse | L1 | muse | `failed_tests` | 888.0 | 2 | false | false |
| l1-qwen | L1 | qwen | `failed_tests` | 972.0 | 0 | false | true |
| m1-gemma | M1 | gemma | `policy_violation` | 361.0 | 2 | — | — |
| m1-muse | M1 | muse | `failed_tests` | 1132.0 | 1 | false | true |
| m1-qwen | M1 | qwen | `policy_violation` | 306.0 | 3 | — | — |
| s1-gemma | S1 | gemma | `failed_tests` | 150.0 | 0 | false | true |
| s1-muse | S1 | muse | `failed_tests` | 271.0 | 2 | false | true |
| s1-qwen | S1 | qwen | `timeout` | 602.0 | 0 | false | true |

## Controls

- Every attempt used a fresh history-stripped task tree and unique unprivileged identity.
- The paid sandbox admitted only the assigned vLLM endpoint through a Unix-socket relay; external network, direct host loopback, sibling model sockets, and root SSH material were blocked before execution.
- Graders and reference fixes remained on the trusted Windows host. M1 was graded natively on Windows.
- The pod was capped at $50 and all candidate changes were scope-checked before grading.

## Interpretation limit

This one-run-per-model-per-task pilot is diagnostic. It does not establish a statistically reliable model ranking, and public-history training contamination cannot be excluded.
