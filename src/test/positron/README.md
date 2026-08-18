# Positron API Tests

Integration tests that run the Julia extension inside a real
[Positron](https://positron.posit.co/) build and exercise its use of the
Positron API — code paths that plain Node or vanilla VS Code can't reach because
they depend on Positron's extension host (the `positron` module the extension
imports, and Positron's language-runtime registry).

These are separate from the Julia-side unit tests in `julia/Positron/test/` (run
with `npm run test:julia`), which test the `Positron.jl` kernel package rather
than the TypeScript extension.

## How it works

- `scripts/run-positron-tests.mjs` uses
  [`@posit-dev/positron-test-electron`](https://github.com/posit-dev/positron-test-electron)
  to download (and cache, under `.positron-test/`) a Positron build, then runs
  the compiled Mocha entry point (`out/test/positron/index.js`) inside its
  extension host — the Positron analog of `@vscode/test-electron`.
- `index.ts` is that entry point: it discovers the compiled `*.test.js` files in
  this directory and runs them with Mocha (tdd UI).
- Tests are compiled by `npm run compile` (`tsc`) along with the rest of the
  extension; `.vscodeignore` already excludes `out/test/**` from the packaged
  VSIX.

## Running locally

```bash
npm run test-positron                          # against the latest stable Positron
POSITRON_CHANNEL=daily npm run test-positron   # against a daily build
```

On Linux, Positron needs a display server, so run it under `xvfb-run` when
headless:

```bash
xvfb-run -a npm run test-positron
```

> **Note:** the suite also runs in CI on every PR and push to `main` via the
> `Positron API Tests` workflow (`.github/workflows/positron-api-tests.yaml`),
> which installs Julia (via `julia-actions/setup-julia`) so runtime discovery has
> a Julia to find.

## The tests

- **`extension.test.ts`** — the `positron` API module is present in the extension
  host and the extension (`ntluong95.positron-julia`) activates.
- **`runtime-registration.test.ts`** — after activation, a Julia runtime surfaces
  in Positron's registry (`positron.runtime.getRegisteredRuntimes` /
  `getPreferredRuntime('julia')`), exercising `registerLanguageRuntimeManager` +
  `JuliaRuntimeManager.discoverAllRuntimes` end-to-end. Requires a Julia on
  `PATH`.

## Adding tests

Add a `<name>.test.ts` file in this directory using Mocha's tdd UI
(`suite`/`test`). Prefer asserting on the extension's real behavior at the
Positron API boundary — import the extension's own code (e.g.
`createJuliaRuntimeMetadata` from `../../runtime`) and check what it produces for
/ receives from the live API, rather than poking the API directly.

Keep tests independent of a live kernel whenever possible: metadata- and
registry-level assertions are far faster and less flaky than starting a Julia
session. Good next candidates: a `createJuliaRuntimeMetadata` shape test, and a
`positron-supervisor` wiring test (`supervisorApi()` in `src/extension.ts`).
