# julia-report-ci-results

> [!WARNING]
> This action is under active development and its interface may change.

A GitHub Action that renders a single CI job summary from the results of a
Julia test-and-lint run:

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
and works on fork PRs). It writes the report to the job summary and fails the
job when there are lint errors, failing test items, test definition errors, or
no result files at all.

Reports are truncated safely against GitHub's 1 MiB step-summary limit:
per-block caps first (failure messages keep their head, raw output keeps its
tail), then whole sections are dropped worst-first with a notice.

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

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `results-path` | yes | Directory containing test-result `*.json` files. |
| `lint-results-path` | no | Directory containing lint `*.sarif` file(s). May be missing or empty when lint was skipped. |

## Development

The action is bundled into `dist/index.js` (committed). After changing `src/`,
run:

```
npm install
npm test
npm run build
```

and commit the updated `dist/index.js` together with the source change.
