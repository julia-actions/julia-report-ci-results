# julia-report-ci-results

This is an experiment, nothing to see at the moment.

## Requirements and caching

The action requires `julia` on the PATH (e.g. via
`julia-actions/install-juliaup`); nothing installs it for you.

The action does not cache anything itself — it instantiates its dependencies
into the default Julia depot (`~/.julia`). To cache the depot, add a job-level
cache step before this action:

```yaml
- uses: julia-actions/install-juliaup@v2
  with:
    channel: release
- uses: julia-actions/cache@v2
```

Note: if the job sets `JULIA_DEPOT_PATH`, the action now uses that depot
(earlier versions overrode it with a private depot under `runner.tool_cache`).
