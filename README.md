<p align="center">
<img width="214" height="251" alt="julia-positron" src="https://github.com/user-attachments/assets/1d38f542-3c41-4b94-9189-31d1e7a8246b" />

</p>

# Julia for Positron

Julia language support for [Positron](https://github.com/posit-dev/positron). Based on [julia-vscode](https://code.visualstudio.com/docs/languages/julia), [Julia for Positron](https://github.com/ntluong95/positron-julia), and @wesm's closed PR on the positron repo.

> [!IMPORTANT]
> From version 0.1.3, the extension will be maintained under [TidierOrg](https://github.com/TidierOrg).

## Features

- **Julia Runtime** — Start interactive Julia sessions directly in Positron's Console. Define variables, run code, and inspect results with the Variables pane and Data Explorer.
- **Language Server** — Powered by [LanguageServer.jl](https://github.com/julia-vscode/LanguageServer.jl) for diagnostics, completions, go-to-definition, hover info, and more. Automatically installed on first use.
- **Runtime Completions** — Supplements LSP completions with live variables and functions from the running Julia session via the Jupyter `complete_request` protocol.
- **Run Multiline Statements** — Press `Ctrl+Enter` / `Cmd+Enter` to send the full statement at the cursor to the console, wherever the cursor is in it: the first line, a continuation line of a multi-line call, a line inside a `function`/`for`/`if`/`begin` block, or its closing `end`. Handles unclosed brackets, trailing operators and pipe chains, strings and comments, docstrings, and `x[end]`. Inside a `module`, each statement of the module body runs on its own. **Julia: Run Selection** without a selection runs the same statement.
- **Run Several Statements at Once** — Code pasted into the console, or run from a Quarto cell, runs one statement at a time: each statement's output appears as it finishes, the Quarto gutter shows which statement is running, and execution stops at the first error. A `module … end` block always runs as one input. Needs Positron 2026.09 for the console; Quarto progress works from 2026.08.
- **Profiler** — `@profview expr` in the Julia console profiles `expr` and shows a flame graph; Ctrl/Cmd+click a frame to open its source line. **Julia: Profile Selection** (editor context menu) profiles the selection or the statement at the cursor, and **Julia: Next / Previous / Delete Profile** move through the last 20 profiles. `@profview expr C = true` also shows C frames.
- **Inline Results** *(optional)* — Mark code you run from the editor with `✓` or `✗`, plus a preview of the value or error, like julia-vscode. Off by default; see [Inline Results](#inline-results).
- **Semantic Highlighting** — Enhanced syntax highlighting with semantic information from the Language Server for accurate color coding of functions, types, modules, and other language constructs.
- **Data Explorer** — Open DataFrames, matrices, and other tabular data in Positron's interactive Data Explorer with sorting, filtering, and summary statistics. Convert the current state of the Data Explorer into to Code
- **Import Data** — In Positron 2026.09 or newer, **Import Data** (in the Data Explorer, the File menu, the Variables pane, or a file's context menu) generates Julia code for CSV/TSV ([CSV.jl](https://github.com/JuliaData/CSV.jl)), Excel ([XLSX.jl](https://github.com/JuliaData/XLSX.jl)), and Parquet ([Parquet.jl](https://github.com/JuliaIO/Parquet.jl)) files, preselected when a Julia console is active. Ask it to include the Data Explorer's filters and sorts, and the code reproduces them with DataFrames.jl. Add the reader package to your environment first (`] add CSV DataFrames`), or let [Missing Package Prompts](#missing-package-prompts) offer to install it.
- **Variables Pane** — Browse all session variables with type and value summaries.
- **Help Integration** — View Julia documentation inline via Positron's Help pane.
- **Plots** — Julia plots are captured and displayed in Positron's Plots pane.
- **Package Pane** — Browse and manage Julia packages directly within Positron.
- **Project Environments** — The status bar shows the active Julia project; click it to switch. The console, language server, and new terminals all use the same project. A folder without a `Project.toml` uses your global environment (`@v1.x`) unless you choose **Activate '<folder>' as a new project**, which makes it the project (Pkg creates `Project.toml` on the first `add`).
- **Terminals Match the Console** — New integrated terminals put the Julia console's `julia` first on `PATH` and set `JULIA_PROJECT` to its project, so `julia` in a terminal is the same Julia and project as the console (`positron.julia.terminal.useConsoleEnvironment`).
- **Interpreter Setup** — Julia versions installed with juliaup, on `PATH`, or in standard locations are found automatically and cached by Positron between windows, so startup doesn't search for them again. The Start Session menu offers **Install Julia via juliaup** when juliaup is missing, and **Activate Julia Project Environment…**.
- **Pkg REPL Mode** — Type `]` at an empty console prompt to switch to `pkg>`, run Pkg commands like `status` or `add DataFrames`, and press Backspace at an empty `pkg>` prompt to return to `julia>`. One-shot commands (`] add DataFrames`) work too.
- **Create New Package** — Scaffold a new package with [PkgTemplates.jl](https://github.com/JuliaCI/PkgTemplates.jl) via `Julia: Create New Package` in the command palette: tests and README always included, plus optional git repository, MIT license, GitHub Actions CI, and Documenter docs.
- **TestItem Compatible** - Uses the same testing system as `julia-vscode`
- **Debugger** - Use breakpoints, inspect local and global variables, etc.
- **Formatting** — Format Document (Shift+Alt+F) and Format Selection (Ctrl+K Ctrl+F) via [JuliaFormatter.jl](https://github.com/domluna/JuliaFormatter.jl), powered by the language server. Configurable through a `.JuliaFormatter.toml` file at the workspace root.
- **Missing Package Prompts** — Detects packages your code references but that aren't installed, and offers to install them from the console, before running a file, and in the editor. See [Missing Package Prompts](#missing-package-prompts) — these rely on Positron preview settings.

## Requirements

- [Positron IDE](https://github.com/posit-dev/positron) 2026.08 or newer
- [Julia](https://julialang.org/downloads/) 1.10 or newer
- [IJulia](https://github.com/JuliaLang/IJulia.jl) installed in your global package environment (e.g. "1.12") 

## Getting Started

1. Install Julia from [julialang.org](https://julialang.org/downloads/) or via [juliaup](https://github.com/JuliaLang/juliaup).
2. Install this extension in Positron (Extensions view → Install from VSIX, or from the marketplace).
3. Open a `.jl` file or start a Julia console session from the interpreter picker.

On first launch, the extension automatically installs required Julia packages (`IJulia`, `LanguageServer.jl`, and supporting dependencies). This one-time setup may take a few minutes.

## Troubleshooting

**Only one Julia version shows up, although juliaup has several channels installed**

Fixed in 0.2.7. Versions up to 0.2.6 asked juliaup for each channel's binary with `juliaup which`, which juliaup 1.19 doesn't have, so only the `julia` on `PATH` (and Julia installed in standard locations) was found. The extension now reads juliaup's `juliaup.json` directly. After upgrading, you may need to pick your Julia interpreter once, because the juliaup launcher is now listed as the Julia version it starts.

**The console uses a different project than the folder I opened (issue #29)**

Changed in 0.2.7. The extension no longer looks for a `Project.toml` above the folder you opened: a folder inside another project uses your global environment, and the status bar, console, and language server agree on it. To use the opened folder as a project, click the environment in the status bar and choose **Activate '<folder>' as a new project**; to use the parent project, pick it from the same list.

**Pressing Enter on an incomplete line in the console (e.g. `function f(x)`) clears it and runs nothing**

Fixed in 0.2.6. From Positron 2026.09, the Julia session checks console input for completeness itself, and versions up to 0.2.5 dropped the "incomplete" answer, so Positron treated the input as run. The console now shows a continuation prompt again.

**`MethodError: no method matching runserver(...)` when the language server starts**

Fixed in 0.2.5. LanguageServer.jl 6.0 changed the arguments of `runserver`, and versions up to 0.2.4 installed whichever LanguageServer.jl release was newest, so the language server crashed on every fresh install on Julia 1.11 or newer. The extension now installs LanguageServer.jl 5.x, and repairs an incompatible install automatically on the next start.

If you can't upgrade yet, pin LanguageServer.jl 5 in the extension's own depot, then reload the window:

```bash
JULIA_DEPOT_PATH="<lsdepot>" julia --startup-file=no --project="<lsdepot>/environments/v<minor>" -e 'using Pkg; Pkg.add(name="LanguageServer", version="5"); Pkg.compat("LanguageServer", "5"); Pkg.precompile()'
```

`<lsdepot>` is the `LS depot` path printed at the top of the Julia Language Server output, for example `~/.positron/extensions/ntluong95.positron-julia-0.2.4/lsdepot/v1.12` (over Remote SSH it's under `~/.positron-server/extensions/`). `<minor>` is your Julia version, for example `1.12`.

**`ERROR: LoadError: IJulia not properly installed. Please run Pkg.build("IJulia")` at session start**

Fixed as of this release — the kernel bootstrap now detects an unbuilt `IJulia` and builds it automatically on the next session start, no manual steps needed.

If you're on an older version and hit this now, run the suggested command yourself in a plain Julia terminal (not `sudo julia` — a normal user can write the required file, and `sudo` leaves root-owned files behind in your Julia depot):

```bash
julia --project="<extension install dir>/julia/Positron" -e 'using Pkg; Pkg.instantiate(); Pkg.build("IJulia")'
```

Then restart the Julia console session in Positron. Find `<extension install dir>` from the path in the error message itself (it's printed as part of the stacktrace).

> [!NOTE]
> As of this release, the extension no longer registers a Julia kernel in your global Jupyter data directory as a side effect of this build step — Positron launches the kernel itself and never used that registration. If you also use `IJulia` outside Positron (e.g. JupyterLab) and want that kernel registered, run `julia -e 'using Pkg; Pkg.build("IJulia")'` in your own environment.

## Inline Results

Set `positron.julia.inlineResults.enabled` to `true` to mark code you run from a Julia editor at the end of its last line:

```julia
using DataFrames                ✓
DataFrame(x = 1,
          y = 2)                ✓ 1×2 DataFrame
z = undefined_thing             ✗ UndefVarError: `undefined_thing` not defined in `Main`
```

- `⋯` shows while the code is running, then `✓` when it completes or `✗` when it throws an error.
- The returned value (or the error message) is previewed next to the marker; hover the marker to see it in full. Set `positron.julia.inlineResults.showValue` to `false` to show only `✓` / `✗`.
- Works with `Ctrl+Enter` / `Cmd+Enter`, running a selection, **Julia: Run Selection**, and the code cell commands. Output still goes to the console as usual.
- A marker disappears when you edit its code, when the Julia session restarts, or when you run **Julia: Clear Inline Results**.

Markers for `Ctrl+Enter` / `Cmd+Enter` rely on Positron reporting where executed code came from, which needs **Positron 2026.02 or newer**.

```jsonc
{
  "positron.julia.inlineResults.enabled": true,
  // Optional: only show ✓ / ✗, without the value or error message
  "positron.julia.inlineResults.showValue": false
}
```

## Missing Package Prompts

When your Julia code references a package that isn't installed, Positron can offer to install it in three places:

| Where | What you see | Positron setting |
| ----- | ------------ | ---------------- |
| **Console** | An `Install <Pkg>` suggestion beneath a `Package X not found in current path` error | `packages.suggestInstallOnError` |
| **Before running a file** | An *Install Missing Packages* dialog listing every missing package, with **Install Packages and Run** | `packages.confirmMissingOnRun` |
| **Editor** | A `N missing packages` warning badge in the editor action bar | `packages.warnMissingInEditor` |

> [!WARNING]
> These are **Positron preview features**, not settings contributed by this extension. They require a recent Positron build (reported working on **2026.08.0 build 249** and newer) — on older builds the settings don't exist and no prompts appear, regardless of this extension's version.
>
> All three default to `true`, so normally no configuration is needed. If a prompt doesn't appear, open **Settings** and search for `packages.` to confirm the relevant setting above is enabled — each surface is gated *independently*, so the console suggestion can work while the editor badge is switched off.

To enable them explicitly, add to your `settings.json`:

```jsonc
{
  // Suggest installing a package when a console error reports it missing
  "packages.suggestInstallOnError": true,
  // Offer to install missing packages before running a file or notebook
  "packages.confirmMissingOnRun": true,
  // Show the "N missing packages" badge in the editor action bar
  "packages.warnMissingInEditor": true
}
```

Notes:

- The prompts only offer packages that exist in a reachable registry, so unregistered or GitHub-only packages are never suggested.
- The editor badge needs a **running Julia console session** for the open file — it stays hidden until a session is started. It also hides itself when the editor action bar is too narrow to fit it.

## Extension Settings

Contributed by this extension:

| Setting                                         | Default | Description                                                 |
| ----------------------------------------------- | ------- | ----------------------------------------------------------- |
| `positron.julia.executablePath`                 | `""`    | Path to a specific Julia executable                         |
| `positron.julia.languageServer.enabled`         | `true`  | Enable/disable the Julia Language Server                    |
| `positron.julia.languageServer.environmentPath` | `""`    | Path to a Julia project environment for the Language Server |
| `positron.julia.help.importUnimportedPackages`  | `true`  | Allow Help lookups to import installed packages into `Main` |
| `positron.julia.terminal.useConsoleEnvironment` | `true` | New terminals use the Julia console's Julia and project (`JULIA_PROJECT`) |
| `positron.julia.inlineResults.enabled`          | `false` | Mark code run from the editor with `✓` / `✗` ([Inline Results](#inline-results)) |
| `positron.julia.inlineResults.showValue`        | `true`  | Preview the value or error message next to inline result markers |
| `julia.lint.missingrefs`                        | `"all"` | Control missing-reference diagnostics (`all`, `id`, `none`) |


## License

This project is dual-licensed, reflecting its two main sources of code:

- **Elastic License 2.0** — the Positron integration code originating from
  Posit Software, PBC (the Julia runtime, session, language client, completions,
  provider, and the `julia/Positron/` Julia package, plus code written for this
  extension that follows those Positron patterns). See [LICENSE](LICENSE). These
  files carry a `Copyright (C) Posit Software, PBC … Elastic License 2.0` header.

- **MIT License** — the code derived from
  [julia-vscode](https://github.com/julia-vscode/julia-vscode) and
  [Julia.tmbundle](https://github.com/JuliaLang/Julia.tmbundle). See
  [LICENSE-MIT](LICENSE-MIT). These files carry a `Ported/Adapted from
  julia-vscode … MIT License` header. They include:
  - `src/testing/testControllerProtocol.ts`, `src/testing/testLSProtocol.ts`,
    `src/testing/testFeature.ts`
  - `src/debugger/debugFeature.ts`
  - `julia/Positron/src/profile.jl` (the `@profview` profile serializer)
  - `resources/profiler/profile-viewer.js`, the flame graph renderer from
    [jl-profile.js](https://github.com/pfitzseb/jl-profile.js) (MIT); see
    `resources/profiler/NOTICE`
  - `scripts/debugger/run_debugger.jl`,
    `scripts/apps/testitemcontroller_main.jl`, and the bundled
    `scripts/environments/testitemcontroller/` project files
  - `syntaxes/julia_vscode.json`, `syntaxes/juliacodeblock.json`,
    `syntaxes/juliamarkdown.json`, and
    `language-configuration/julia-language-configuration.json` (these are strict
    JSON and so carry no inline header; they are MIT-licensed by virtue of being
    listed here)
