/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";

export const JULIA_PKG_REPL_MODE_CONTEXT = "positronJuliaPkgReplMode";

let pkgReplModeContext = false;

export function isPkgReplPrompt(inputPrompt: unknown): boolean {
  return typeof inputPrompt === "string" && inputPrompt.trimEnd().endsWith("pkg>");
}

export function isJuliaPkgReplModeContext(): boolean {
  return pkgReplModeContext;
}

export function setJuliaPkgReplModeContext(enabled: boolean): void {
  if (pkgReplModeContext === enabled) {
    return;
  }

  pkgReplModeContext = enabled;
  void vscode.commands.executeCommand(
    "setContext",
    JULIA_PKG_REPL_MODE_CONTEXT,
    enabled,
  );
}
