# MS0 — provenance audit

Audited 2026-10-22 against the complete `don-milsey-miller/kiln` Git history,
the issue records, and the closing pull requests.

## Outcome

| Task | Issue | Audited pre-fix | Audited fix | Result |
| --- | ---: | --- | --- | --- |
| S1 | #162 | `4dbfc49bc567ba13656531872c4c3c5e5e9f3001` | `8a5354c3a87d1c338d9e300c285a843a1cb55056` | Replacement provenance accepted. |
| M1 | #200 | `b641f6d45821a1fd17a51718622b3879ebead0ac` | `d8e964363a05367c47a4985b709a3be815894974` | Provenance accepted. |
| L1 | #215 | `ba251ce1ddc70656a7cae5628e4ea64d4ec8fe23` | `3c602f49fd46b3fc2222e0a48bb8257bd07347a8` | Provenance accepted. |

## Rejected S1 candidate and replacement

Issue #160 was closed by PR #161. Its implementation commit is `90484ed0…`,
whose direct parent is `46efeeb6…`; merge commit `4dbfc49b…` brought that fix to
`main`. The handoff's proposed fixing commit, `8a5354c3…`, is a later follow-up,
and its proposed `^` revision is exactly `4dbfc49b…`—a revision that already
contains the PR #161 fix. The provisional pair therefore cannot be used.

The corrected code boundary was tested, but the expected behavioral failure did
not reproduce on the Windows runner. Issue #160 is retained as rejected
provenance and is not admitted as a benchmark task.

The approved replacement is issue #162, closed by PR #168. Its single
implementation commit is `8a5354c3…`, whose direct parent is
`4dbfc49b…`; merge commit `29399338…` brought it to `main`. The issue, pull
request, commit message, and diff all describe the same interactive live-check
consent defect. The direct parent/fix pair is therefore the audited boundary.

## M1 and L1

Both proposed fixing commits are single-parent commits directly following the
selected pre-fix revisions. Their issue records, commit messages, diffs, and
closing pull requests agree with the claimed defect and fix.

## Prompt freeze

Agent-facing prompts were frozen for all three ready tasks:

- S1: `95c4b475ed0c1e7778b1a8a97535b6ba8919e028515bced2ae33e943ef721983`
- M1: `aad52a189b67b4d6b99d37baa0517c852e9d67776c973d71c21cb15ddfe7f96e`
- L1: `0bc5f77531cbde5666a4d655f7baa1a7207b5b40c3e7efde16984f0764e549c3`
