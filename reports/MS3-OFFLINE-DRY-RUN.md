# MS3 — offline harness dry run

Runs: **10** · Wall time: **10.67s** · RunPod spend: **$0.00**

| Run | Task | Adapter | Classification | Seconds | Changed files |
| --- | --- | --- | --- | ---: | ---: |
| control-valid | CONTROL | mock-agent | `passed` | 6.082 | 1 |
| control-failing | CONTROL | mock-agent | `failed_tests` | 0.539 | 1 |
| control-noop | CONTROL | mock-agent | `failed_tests` | 0.479 | 0 |
| control-timeout | CONTROL | mock-agent | `timeout` | 0.893 | 0 |
| control-canceled | CONTROL | mock-agent | `canceled` | 0.409 | 0 |
| control-malformed | CONTROL | mock-agent | `agent_error` | 0.407 | 0 |
| control-agent-error | CONTROL | mock-agent | `agent_error` | 0.481 | 0 |
| control-scope-violation | CONTROL | mock-agent | `policy_violation` | 0.414 | 1 |
| control-evaluator-failure | CONTROL | mock-agent | `infra_error` | 0.481 | 1 |
| control-isolation-probe | CONTROL | mock-agent | `failed_tests` | 0.485 | 0 |

## Controls demonstrated

- Valid, invalid, no-op, timeout, cancellation, malformed-output, agent-error, policy-violation, and evaluator-infrastructure paths were classified independently.
- The WSL2 namespace probe reported Windows drive visible=false, network reachable=false, and host secret visible=false.
- Timed-out descendant survived=false.
- Every agent attempt began from a fresh synthetic source bundle and was graded in a separate clean workspace.
- Raw stdout, stderr, candidate workspaces, and grader workspaces remain under ignored local artifacts.

## Limitations and next gate

- This rehearsal used a synthetic controllable agent, not Qwen, Muse, Gemma, Pi, vLLM, or a paid API.
- The paid backend remains disabled until a RunPod/RHEL sandbox can expose only its selected local vLLM endpoint and an explicit MS4 authorization is recorded.
- Windows-native M1 grading remains a host-side trusted evaluator step after patch transfer.
