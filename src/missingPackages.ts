/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import * as positron from "positron";

/** Modules that are always available and never installable packages. */
const BUILTIN_MODULES = new Set(["Base", "Core", "Main"]);

/**
 * Matches a `using`/`import` keyword at the start of a statement, capturing
 * the clause list that follows.
 */
const IMPORT_STATEMENT_REGEX = /^\s*(?:using|import)\s+(.+)$/;

/** Matches a valid Julia module identifier. */
const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_!]*$/;

/**
 * Extracts the set of top-level package names referenced by `using` and
 * `import` statements in the given Julia source.
 *
 * Line-based, like the R analyzer: handles comma-separated clause lists
 * (`using A, B`), selection lists (`using A: x, y` -> A), submodule paths
 * (`import A.B` -> A), renames (`import A as B` -> A), and multiple
 * statements per line (`using A; using B`). Relative imports (`import .Foo`)
 * and Base/Core/Main are skipped. Macro-generated imports (`@eval using X`),
 * multi-line clause lists, and `#= =#` block comments are not handled; a
 * missed reference just means no prompt, and a false positive is dropped by
 * the installed/installable filter downstream.
 */
export function parseJuliaPackageReferences(code: string): string[] {
  const packages = new Set<string>();

  for (const rawLine of code.split(/\r\n|\r|\n/)) {
    // Strip line comments (best-effort: does not track '#' inside strings).
    const line = rawLine.replace(/#.*$/, "");

    for (const statement of line.split(";")) {
      const match = IMPORT_STATEMENT_REGEX.exec(statement);
      if (!match) {
        continue;
      }

      // A selection list (`using A: x, y`) allows only a single module
      // before the ':'; everything after it is selected names, not
      // modules, so truncate there before splitting the comma list.
      const clauseList = match[1].split(":")[0];

      for (const rawClause of clauseList.split(",")) {
        const clause = rawClause.trim();
        if (clause.length === 0 || clause.startsWith(".")) {
          continue;
        }

        // Drop a rename (` as B`), then take the module path's top-level
        // segment (`A.B.C` -> `A`).
        const modulePath = clause.split(/\s+as\s+/)[0].trim();
        const topLevel = modulePath.split(".")[0].trim();

        if (!IDENTIFIER_REGEX.test(topLevel)) {
          continue;
        }
        if (BUILTIN_MODULES.has(topLevel)) {
          continue;
        }

        packages.add(topLevel);
      }
    }
  }

  return [...packages];
}

/** Julia: `ArgumentError: Package Foo not found in current path.` */
const JULIA_MISSING_PACKAGE_REGEX =
  /ArgumentError: Package (\S+) not found in current path/;

/**
 * Build a probe snippet (`using Foo`) from a Julia missing-package error, or
 * undefined when the message is not a missing-package error.
 */
export function juliaMissingPackageProbe(
  errorMessage: string,
): string | undefined {
  const name = JULIA_MISSING_PACKAGE_REGEX.exec(errorMessage)?.[1];
  return name ? `using ${name}` : undefined;
}

/**
 * The subset of JuliaPackageManager that the missing-packages analyzer
 * needs: a single kernel round-trip that filters candidate names down to
 * the ones that are not loadable but exist in a reachable registry.
 */
export interface MissingPackagesQuerier {
  missingPackages(
    names: string[],
    token?: vscode.CancellationToken,
  ): Promise<string[]>;
}

/**
 * Analyzes Julia code and returns the packages it references that are not
 * installed AND that are available in a reachable registry.
 *
 * The filtering happens in one Julia call: `Base.identify_package` drops
 * anything loadable (stdlibs and active-project dependencies), and an exact
 * registry name match keeps only what `Pkg.add` could actually install.
 * This is what excludes the unpublished/GitHub-only case: a package that is
 * not in a reachable registry is never offered.
 */
export async function listMissingJuliaPackages(
  packageManager: MissingPackagesQuerier,
  target: positron.RuntimeMissingPackagesTarget,
  token?: vscode.CancellationToken,
): Promise<positron.RuntimeMissingPackage[]> {
  const code = await resolveCode(target);
  if (!code) {
    return [];
  }

  const references = parseJuliaPackageReferences(code);
  if (references.length === 0) {
    return [];
  }

  const missing = await packageManager.missingPackages(references, token);
  return missing.map((name) => ({ name }));
}

/** Reads the code to analyze from the target's inline code or file URI. */
async function resolveCode(
  target: positron.RuntimeMissingPackagesTarget,
): Promise<string | undefined> {
  if (target.code !== undefined) {
    return target.code;
  }
  if (target.uri) {
    try {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.parse(target.uri),
      );
      return document.getText();
    } catch {
      return undefined;
    }
  }
  return undefined;
}
