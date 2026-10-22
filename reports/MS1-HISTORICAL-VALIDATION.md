# MS1 — historical validation

## Runner

- Microsoft Windows 11 Pro 10.0.26300, build 26300, 64-bit
- PowerShell 7.6.5
- Node.js 24.18.0
- npm 11.16.0
- Git 2.52.0.windows.1
- Historical installs: `npm ci` from each snapshot's locked dependencies
- RunPod/GPU spend: **$0**; no Pod was provisioned

Node 24.18.0 matches the version recorded by the historical M1 and L1 pull
requests.

## S1 — ready (replacement issue #162)

The original issue #160 case remains rejected: its provisional pair was invalid,
and the corrected boundary did not reproduce the claimed failure on this runner.
With approval to replace it, S1 now uses issue #162 and the direct boundary
`4dbfc49b…` → `8a5354c3…`.

An independent evaluator sent `yes` through the real Clack renderer in a Windows
ConPTY. The pre-fix revision returned string `"yes"`, which fails the strict
Boolean authorization contract. The fixed revision returned Boolean `true`.
The evaluator therefore failed before the fix and passed after it.

The same focused historical suite passed 27/27 before and 29/29 after the fix.
The fixed suite's added real-PTY regression passed, and its setup integration
test passed with a stubbed canary invoked exactly once. No provider was contacted
and no credential was used.

## M1 — ready

The independent Windows evaluator failed on `b641f6d4…` with the historical
error: PowerShell attempted to convert signed `-1073740791` to `System.UInt32`,
wrote no `exited` record, and therefore did not complete normal release.

The same evaluator passed on `d8e96436…`:

- child exit: `3221226505` (`0xC0000409`)
- host exit, interpreted as unsigned: `3221226505`
- job release: successful
- remaining job members: none
- stderr: empty

The pre-fix existing suite passed 5/5 because it lacked the crash-code case.
The fixed suite passed 6/6, including the new Windows regression.

## L1 — ready

The independent evaluator failed on `ba251ce1…` because the production
`kiln_delegate` wrapper did not pass a research-permission decision or resolved
research environment to the delegation runtime.

The same evaluator passed on `3c602f49…`. The resulting child environment
contained the permitted project and state mode plus the research credential,
while excluding `KILN_RUN_ID` and an unrelated sentinel secret.

Relevant pre-fix tests passed 70/70 because they did not exercise this route.
The fixed set passed 87/87. That includes real delegated children in project and
user state modes against a loopback research backend, vault-only credential
routing, denial paths, non-research role isolation, and session-state exclusion.

## Gate result

S1, M1, and L1 have each passed the historical red/green gate. MS1 is complete.
This does not authorize MS2 or any model run; those remain outside the approved
milestone scope.
