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
  [`julialint`](https://github.com/julia-vscode/JuliaLintApp.jl).

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
        pattern: testitemresults-*
        path: testresults
        merge-multiple: true
    - uses: actions/download-artifact@v8
      with:
        pattern: lintresults*
        path: lintresults
        merge-multiple: true
    - uses: julia-actions/julia-report-ci-results@main
      with:
        results-path: testresults
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
| `fail-on-missing-results` | no | `true` | Fail the step when no test-result files are found. |
| `fail-on-test-failures` | no | `true` | Fail the step when there are failing test items or test definition errors. |
| `fail-on-lint-errors` | no | `true` | Fail the step when there are error-severity lint results. |
| `process-logs-retention-days` | no | | Retention in days for the uploaded `test-process-logs` artifact. Empty uses the repository default. |

## Outputs

| Output | Description |
| --- | --- |
| `failed` | `true`/`false`: whether any CI issues were found (independent of the `fail-on-*` settings). |
| `test-count` | Number of distinct test items in the report. |
| `failed-count` | Number of test items with issues. |
| `definition-error-count` | Number of test definition errors. |
| `lint-error-count` | Number of error-severity lint results. |
| `process-logs-artifact-id` | Id of the uploaded `test-process-logs` artifact, or empty when nothing was uploaded. |

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
  [`julialint`](https://github.com/julia-vscode/JuliaLintApp.jl), with
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
