# julia-report-ci-results

> [!WARNING]
> This action is under active development and its interface may change.

The reporting half of the
[testitem-workflow](https://github.com/julia-testitems/testitem-workflow)
reusable workflow: a GitHub Action that renders a single CI job summary from
the results of a Julia test-and-lint run. It can also be used directly, but it
is designed around the file formats and artifact flow of the other actions in
that workflow:

- **Test results**: a directory of JSON files written by
  [julia-run-testitems](https://github.com/julia-actions/julia-run-testitems)
  (one file per matrix leg, downloaded from artifacts). Results for the same
  test item from different OS/version legs are merged, identical failures are
  deduplicated across profiles, and profile lists are compressed per OS.
- **Lint results** (optional): a directory containing SARIF file(s) as
  produced by [julia-lint](https://github.com/julia-actions/julia-lint) /
  [`julialint`](https://github.com/julia-vscode/LintApp.jl).
- **Results from legs allowed to fail** (optional): a second directory of the
  same JSON files, for matrix legs whose failures must not fail CI — see
  [Legs allowed to fail](#legs-allowed-to-fail).

The action is pure TypeScript (`node20`) — it needs no Julia installation, no
checkout, and no cache, and makes no GitHub API calls (so it needs no token
and works on fork PRs). It writes the report to the job summary and (by
default) fails the job when there are lint errors, failing test items, test
definition errors, or no result files at all; each of those conditions can be
made non-fatal via the `fail-on-*` inputs.

Test process outputs (worker-level output such as precompilation failures,
outside any single test item) are labeled with the profile name of the result
file they came from — each matrix leg writes one result file with a single
profile, so the profile identifies the platform. A short process id is
appended only when one leg ran several processes.

The full, untruncated process outputs are also uploaded as a
`test-process-logs` artifact (one `.log` file per process, named by profile
and short process id), and the summary links to it. When the artifact upload
is not possible (e.g. outside the Actions runtime), the report still renders —
only the links are dropped.

Reports are truncated safely against GitHub's 1 MiB step-summary limit:
per-block caps first (failure messages keep their head, raw output keeps its
tail), then whole sections are dropped worst-first with a notice. Process
outputs are the first section to be dropped; the truncation notice then links
to the `test-process-logs` artifact so the verbose output stays accessible.

## Usage

```yaml
report-results:
  needs: [run-tests, lint]
  if: ${{ !cancelled() }}
  runs-on: ubuntu-latest
  steps:
    - uses: actions/download-artifact@v8
      with:
        pattern: testitemresults-blocking-*
        path: testresults
        merge-multiple: true
    - uses: actions/download-artifact@v8
      with:
        pattern: testitemresults-allowfail-*
        path: allowfailresults
        merge-multiple: true
    - uses: actions/download-artifact@v8
      with:
        pattern: lintresults*
        path: lintresults
        merge-multiple: true
    - uses: julia-actions/julia-report-ci-results@main
      with:
        results-path: testresults
        allowed-failure-results-path: allowfailresults
        lint-results-path: lintresults
```

> [!IMPORTANT]
> `merge-multiple: true` on the download steps is required: the action scans
> `results-path` non-recursively, so all result files must land flat in one
> directory. Without it, each artifact is placed in its own subdirectory and
> the action finds no result files.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `results-path` | yes | | Directory containing test-result `*.json` files. Files that are not test-result JSONs are skipped with a warning. |
| `lint-results-path` | no | | Directory containing lint `*.sarif` file(s). May be missing or empty when lint was skipped. |
| `allowed-failure-results-path` | no | | Directory containing test-result `*.json` files from legs allowed to fail. May be missing or empty. |
| `fail-on-missing-results` | no | `true` | Fail the step when no test-result files are found in `results-path`, or when a leg listed in `expected-profiles` that is not allowed to fail reported nothing. Files in `allowed-failure-results-path` do not count. |
| `fail-on-test-failures` | no | `true` | Fail the step when there are failing test items or test definition errors. |
| `fail-on-lint-errors` | no | `true` | Fail the step when there are error-severity lint results. |
| `process-logs-retention-days` | no | | Retention in days for the uploaded `test-process-logs` artifact. Empty uses the repository default. |
| `expected-profiles` | no | | JSON array of `{"name": <profile name>, "allowFailure": <bool>}` naming the legs this run should have heard from. A leg that reported nothing is then called out in the summary. Empty disables the check. See [Missing legs](#missing-legs). |

## Outputs

| Output | Description |
| --- | --- |
| `failed` | `true`/`false`: whether any CI issues were found (independent of the `fail-on-*` settings). |
| `test-count` | Number of distinct test items in the report. |
| `failed-count` | Number of test items with issues on a leg that must pass. |
| `allowed-failure-count` | Number of test items whose only issues are on legs allowed to fail. |
| `definition-error-count` | Number of test definition errors. |
| `lint-error-count` | Number of error-severity lint results. |
| `process-logs-artifact-id` | Id of the uploaded `test-process-logs` artifact, or empty when nothing was uploaded. |
| `missing-profiles` | Comma-separated names of expected profiles that reported no results, blocking ones first. Empty when `expected-profiles` was not set. |

## Missing legs

The action reads whatever result files it is given; on its own it cannot tell a run
with three legs from a six-leg run whose other three artifacts never arrived. Without
help it only notices the all-or-nothing case — *zero* blocking result files — so a
partial set renders as a complete, passing report.

`expected-profiles` closes that gap. Pass the legs the run should have heard from and
any that reported nothing are listed in the summary; missing blocking legs also fail
the step under `fail-on-missing-results`, while missing legs marked `allowFailure` are
reported with a warning only. Each `name` must match the `profile-name` that leg was
run with, which is the name it records in its results.

The caller builds the list, so the profile-name format stays wherever the legs are
defined rather than being duplicated here. In testitem-workflow it comes from
`julia-compute-test-matrix`'s matrix:

```yaml
- id: expected-profiles
  shell: bash
  env:
    TEST_MATRIX: ${{ needs.compute-test-matrix.outputs.test-matrix }}
  run: |
    profiles=$(jq -c '[.[] | {name: "Julia \(.["juliaup-channel"]):\(.os)", allowFailure: (.["allow-failure"] == true)}]' <<< "$TEST_MATRIX")
    echo "profiles=$profiles" >> "$GITHUB_OUTPUT"
```

This is what makes GitHub's **Re-run failed jobs** safe to use: a partial re-run
re-runs only the failed legs, so if any other leg's artifact has expired or was
deleted, the report says so instead of quietly reporting on a subset.

## Legs allowed to fail

A matrix leg may be non-blocking — an rc or nightly Julia, a flaky platform — and
its failures should be visible in the report without failing CI. Those legs write
their results into a separate artifact bucket, which is downloaded into its own
directory and passed as `allowed-failure-results-path`.

The split is by directory rather than by profile name because the classification has
to cover more than test items: test definition errors carry no profile, and a leg that
dies before writing results has no profile at all. Everything found under
`allowed-failure-results-path` is non-blocking by construction.

Concretely, results read from that directory:

- do not fail the step, and are excluded from `failed-count` and
  `definition-error-count`'s fatal effect (they are still counted for display);
- render with ⚠️ instead of ❌, under a *(allowed to fail)* heading;
- do not satisfy `fail-on-missing-results` — if every blocking leg failed to report,
  that is still a missing-results failure.

A test item that fails on a blocking leg *and* on an allowed one still fails CI.

In testitem-workflow this is driven by `julia-compute-test-matrix`'s `allow-failure`
input, which marks the legs; the workflow routes their artifacts here.

## File-format contracts

- **Test results**: each `*.json` file must be in the format written by
  `TestItemControllers.Results.write_json`
  ([TestItemControllers](https://github.com/julia-vscode/TestItemControllers.jl)`/src/results.jl`),
  which is what `julia-run-testitems`' `results-path` input produces.
- **Profile names**: the per-OS compression of the summary works best when
  profile names follow the convention `Julia <juliaup-channel>:<os>` (e.g.
  `Julia 1.10.5~x64:ubuntu-latest`), which is what testitem-workflow passes to
  `julia-run-testitems`' `profile-name` input. Other profile names are
  rendered verbatim.
- **Lint results**: SARIF as emitted by
  [`julialint`](https://github.com/julia-vscode/LintApp.jl), with
  repo-relative artifact URIs.

## Development

The action is bundled into `dist/index.js` (committed). After changing `src/`,
run:

```
npm install
npm test
npm run build
```

and commit the updated `dist/index.js` together with the source change.
