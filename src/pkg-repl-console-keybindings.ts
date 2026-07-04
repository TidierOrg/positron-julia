/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import * as positron from "positron";

import { LOGGER } from "./extension";
import { JuliaRuntimeManager } from "./runtime-manager";
import {
  isJuliaPkgReplModeContext,
  setJuliaPkgReplModeContext,
} from "./pkg-repl-console-state";

const JULIA_REPL_INPUT_PATH = /^\/(?:notebook-)?repl-julia-/;

interface ConsoleInputDocument {
  document: vscode.TextDocument;
  updatedAt: number;
}

class JuliaConsoleInputTracker implements vscode.Disposable {
  private readonly documents = new Map<string, ConsoleInputDocument>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    for (const document of vscode.workspace.textDocuments) {
      this.track(document);
    }

    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((document) => this.track(document)),
      vscode.workspace.onDidChangeTextDocument((event) => this.track(event.document)),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.documents.delete(document.uri.toString());
      }),
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.documents.clear();
  }

  getMostRecentInput(): string | undefined {
    let latest: ConsoleInputDocument | undefined;
    for (const entry of this.documents.values()) {
      if (!latest || entry.updatedAt > latest.updatedAt) {
        latest = entry;
      }
    }
    return latest?.document.getText();
  }

  private track(document: vscode.TextDocument): void {
    if (!isJuliaConsoleInputDocument(document)) {
      return;
    }

    this.documents.set(document.uri.toString(), {
      document,
      updatedAt: Date.now(),
    });
  }
}

export function registerPkgReplConsoleKeybindings(
  context: vscode.ExtensionContext,
  runtimeManager: JuliaRuntimeManager,
): void {
  const tracker = new JuliaConsoleInputTracker();
  context.subscriptions.push(tracker);
  setJuliaPkgReplModeContext(false);

  context.subscriptions.push(
    vscode.commands.registerCommand("julia.enterPkgReplModeFromConsole", async () => {
      const session = await getForegroundJuliaSession(runtimeManager);
      if (!session) {
        await typeText("]");
        return;
      }

      const currentInput = tracker.getMostRecentInput();
      if (currentInput !== "") {
        await typeText("]");
        return;
      }

      if (executePkgReplModeFunction(session, "enter_pkg_repl_mode!(; show_message = false)")) {
        setJuliaPkgReplModeContext(true);
      } else {
        await typeText("]");
      }
    }),
    vscode.commands.registerCommand("julia.exitPkgReplModeFromConsole", async () => {
      const session = await getForegroundJuliaSession(runtimeManager);
      if (!session) {
        await deleteLeft();
        return;
      }

      const currentInput = tracker.getMostRecentInput();
      if (currentInput !== "" || !isJuliaPkgReplModeContext()) {
        await deleteLeft();
        return;
      }

      if (executePkgReplModeFunction(session, "exit_pkg_repl_mode!()")) {
        setJuliaPkgReplModeContext(false);
      } else {
        await deleteLeft();
      }
    }),
  );
}

function isJuliaConsoleInputDocument(document: vscode.TextDocument): boolean {
  return (
    document.uri.scheme === "inmemory" &&
    document.languageId === "julia" &&
    JULIA_REPL_INPUT_PATH.test(document.uri.path)
  );
}

async function getForegroundJuliaSession(
  runtimeManager: JuliaRuntimeManager,
): Promise<positron.BaseLanguageRuntimeSession | undefined> {
  const foregroundSession = await positron.runtime.getForegroundSession();
  if (foregroundSession) {
    return foregroundSession.runtimeMetadata.languageId === "julia"
      ? foregroundSession
      : undefined;
  }

  return runtimeManager.getActiveJuliaSession();
}

function executePkgReplModeFunction(
  session: positron.BaseLanguageRuntimeSession,
  functionCall: string,
): boolean {
  try {
    session.execute(
      `Positron.${functionCall}`,
      `pkg-repl-mode-${Date.now()}`,
      positron.RuntimeCodeExecutionMode.Silent,
      positron.RuntimeErrorBehavior.Continue,
    );
    return true;
  } catch (error) {
    LOGGER.warn(`Failed to dispatch Pkg REPL mode command: ${error}`);
    return false;
  }
}

async function typeText(text: string): Promise<void> {
  await vscode.commands.executeCommand("type", { text });
}

async function deleteLeft(): Promise<void> {
  await vscode.commands.executeCommand("deleteLeft");
}
