# Offline benchmark operations

These commands run from the benchmark repository root on the designated Windows
runner. They do not provision RunPod or contact a model endpoint.

## Validate source and controls

```powershell
npm run check
```

This runs the unit/control tests, verifies prompt hashes, checks immutable model
revision syntax, confirms every task is ready, and confirms paid execution is
disabled.

## Rebuild agent-visible source bundles

```powershell
npm run build:bundles -- C:\path\to\complete\kiln\clone
```

The source repository must contain the audited commits. Bundles are created with
`git archive` under ignored `artifacts/private/bundles/`. Their tree hashes must
match `manifests/tasks.public.json`. Do not substitute a shallow clone unless it
contains all three exact pre-fix objects.

## Rerun the offline MS3 controls

```powershell
npm run dry-run
```

This requires WSL2 distribution `Ubuntu-24.04` with `unshare`, `mount`, `tar`,
and GNU `timeout`. It runs only the synthetic controllable agent. Raw runs are
written under ignored `artifacts/raw/`; sanitized evidence and the Markdown
report are regenerated in `evidence/` and `reports/`.

## Private graders

Evaluator source and configuration remain ignored because the GitHub repository
is public. On the trusted Windows host, after dependencies are installed in a
clean candidate tree, the dispatcher is:

```powershell
node evaluator-private\grade-task.mjs S1 C:\path\to\candidate
node evaluator-private\grade-task.mjs M1 C:\path\to\candidate
node evaluator-private\grade-task.mjs L1 C:\path\to\candidate
```

Exit `0` means targeted and regression checks passed, exit `1` means a behavioral
or regression failure, and exit `2` means an infrastructure failure. M1 refuses
to grade anywhere except native Windows.

## Paid execution lock

There is intentionally no command that starts MS4. The Pi adapter, pinned model
configuration, readiness probe, budget reservation, and authorization validator
are library components only. Paid execution remains unavailable until all of the
following are recorded and verified:

1. Separate user approval for MS4, its exact task/model matrix, provider, image
   digest, infrastructure actions, and maximum budget.
2. A private authorization record matching those approved values.
3. A RHEL deployment sandbox in which the unprivileged agent can reach only its
   selected local vLLM relay and cannot read grader/reference data.
4. Successful endpoint, version, revision, cleanup, and budget readiness checks.
