# Portable compatibility evidence

This is a maintainer-only GitHub source surface. None of `ci/` or `.github/` ships in the Doctor tarball. Existing private tests and artifacts are not dependencies and must not be uploaded.

## Execution

The fixed workflow runs ubuntu-24.04, macos-14 and windows-2022 × Node 22.19.0 / 24 × Host 0.2.1-rc.2 / 0.2.1-rc.4. The receipt records actual OS release, architecture, Node and loaded package versions. Node 24 means the actual 24.x selected by setup-node, not an invented patch version.

```sh
node ci/compatibility.mjs --host 0.2.1-rc.2 --output "$RUNNER_TEMP/doctor-summary"
```

The driver creates one OS temporary domain, an isolated Home/workspace/npm configuration/cache and exact SDK fixture. It packs the explicit runtime whitelist, checks tarball inventory, installs that tarball and these public SDK packages with lifecycle scripts disabled:

- `@deepseek-ai/cordis@4.0.5`
- `@deepseek-ai/dsh@HOST_VERSION`
- `@deepseek-ai/dsh-credentials-local@HOST_VERSION`
- `@deepseek-ai/dsh-host-webserver@HOST_VERSION`
- `@deepseek-ai/dsh-client-connection@HOST_VERSION`

Their normal npm dependency closure is external SDK code. No new product dependency or model API key is needed. Network installation failure fails the row; it is not a skip or pass.

`host-http.mjs` is the extracted real Cordis/BrowserAuth HTTP core formerly in the private frontend transport script. It retains 26 owner/auth/Origin/Host/body-limit/epoch/sequence/privacy/unload checks. `platform-checks.mjs` adds 16 fixture groups: path mapping, CLI roots/links, file URLs, pnpm permissions and interpreter chain, DSH-only log discovery, workspace/temp cleanup, proxy/BOM/log repair backup/recheck/rollback and protected link targets. `matrix-contract.mjs` reuses the established evidence judge. Platform overrides test branches, not native operating systems.

Public CI checks installed runtime bytes exactly. For the manifest it permits only the observed removal of exactly one final LF and also requires exact parsed JSON values; other formatting or byte changes fail. It executes that installed candidate inside real SDK Host/HTTP. Graph rows and repair inputs are explicit fixtures; no desktop, visual, human-click, complete shipped preset or real-user repair result is claimed. Plugin-enable retains the existing private regression coverage; CI does not invent a second installer/recovery implementation.

A local cached-SDK reproduction may add `--runtime-root SDK_ROOT --prepared-package CANDIDATE_TGZ`. This read-only SDK mode runs staged source and records the supplied tarball hash, explicitly not npm installation or an Actions row. It never installs into an existing SDK/profile.

## Receipt and cleanup

Only `summary.json` is uploaded. Its allowlisted fields bind revision (when available), canonical source file hashes, package version/tarball hash, actual runtime versions, step status/exit code, timestamps, counts and listener/Home cleanup. No raw stdout/stderr, environment dump, cookies/tokens, temporary absolute path, profile, SDK directory or log is uploaded. Failed children expose fixed codes only. Captured output remains inside the temporary domain and is discarded. Cleanup failure, missing versions, failed checks or bad receipts fail the run.

Each child has a bounded deadline. Parent removal deletes only its own unique temporary domain. A killed worker must not be represented as clean; `listenerClosed` stays false. Workflow has contents:read only, pinned action SHAs, no secret references, no credential persistence, no PR-target execution or writes. SDK installation runs only in the temporary fixture with npm lifecycle scripts disabled.
