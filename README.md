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
- **Run Multiline Statements** — Press `Ctrl+Enter` / `Cmd+Enter` to send the full multiline statement at the cursor (functions, loops, blocks) to the console. Handles `function…end`, `if…end`, unclosed brackets, pipe chains, and more.
- **Semantic Highlighting** — Enhanced syntax highlighting with semantic information from the Language Server for accurate color coding of functions, types, modules, and other language constructs.
- **Data Explorer** — Open DataFrames, matrices, and other tabular data in Positron's interactive Data Explorer with sorting, filtering, and summary statistics. Convert the current state of the Data Explorer into to Code
- **Variables Pane** — Browse all session variables with type and value summaries.
- **Help Integration** — View Julia documentation inline via Positron's Help pane.
- **Plots** — Julia plots are captured and displayed in Positron's Plots pane.
- **Package Pane** — Browse and manage Julia packages directly within Positron.
- **Pkg REPL Mode** — Type `]` at an empty console prompt to switch to `pkg>`, run Pkg commands like `status` or `add DataFrames`, and press Backspace at an empty `pkg>` prompt to return to `julia>`. One-shot commands (`] add DataFrames`) work too.
- **Create New Package** — Scaffold a new package with [PkgTemplates.jl](https://github.com/JuliaCI/PkgTemplates.jl) via `Julia: Create New Package` in the command palette: tests and README always included, plus optional git repository, MIT license, GitHub Actions CI, and Documenter docs.
- **TestItem Compatible** - Uses the same testing system as `julia-vscode`
- **Debugger** - Use breakpoints, inspect local and global variables, etc.
- **Formatting** — Format Document (Shift+Alt+F) and Format Selection (Ctrl+K Ctrl+F) via [JuliaFormatter.jl](https://github.com/domluna/JuliaFormatter.jl), powered by the language server. Configurable through a `.JuliaFormatter.toml` file at the workspace root.
- **Missing Package Prompts** — Detects packages your code references but that aren't installed, and offers to install them from the console, before running a file, and in the editor. See [Missing Package Prompts](#missing-package-prompts) — these rely on Positron preview settings.

## Requirements

- [Positron IDE](https://github.com/posit-dev/positron) 
- [Julia](https://julialang.org/downloads/) 
- [IJulia](https://github.com/JuliaLang/IJulia.jl) installed in your global package environment (e.g. "1.12") 

## Getting Started

1. Install Julia from [julialang.org](https://julialang.org/downloads/) or via [juliaup](https://github.com/JuliaLang/juliaup).
2. Install this extension in Positron (Extensions view → Install from VSIX, or from the marketplace).
3. Open a `.jl` file or start a Julia console session from the interpreter picker.

On first launch, the extension automatically installs required Julia packages (`IJulia`, `LanguageServer.jl`, and supporting dependencies). This one-time setup may take a few minutes.

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
  - `scripts/debugger/run_debugger.jl`,
    `scripts/apps/testitemcontroller_main.jl`, and the bundled
    `scripts/environments/testitemcontroller/` project files
  - `syntaxes/julia_vscode.json`, `syntaxes/juliacodeblock.json`,
    `syntaxes/juliamarkdown.json`, and
    `language-configuration/julia-language-configuration.json` (these are strict
    JSON and so carry no inline header; they are MIT-licensed by virtue of being
    listed here)
