/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2026 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { JuliaInstallation } from "./julia-installation";
import { JuliaRuntimeManager } from "./runtime-manager";
import { LOGGER } from "./extension";

/** Template options offered in the multi-select quick pick. */
interface PackageOptionItem extends vscode.QuickPickItem {
  id: "git" | "license" | "ci" | "docs";
}

/**
 * Interactive "create a new Julia package" flow (issue #31): asks for a name,
 * a parent folder, and template options, then scaffolds the package with
 * PkgTemplates in a Julia subprocess. PkgTemplates lives in a dedicated
 * helper environment under the extension's global storage, so the user's own
 * environments are never touched.
 */
export async function createNewPackage(
  context: vscode.ExtensionContext,
  runtimeManager: JuliaRuntimeManager,
): Promise<void> {
  const installation = runtimeManager.getPreferredInstallation();
  if (!installation) {
    vscode.window.showErrorMessage(
      "No Julia installation found. Start a Julia interpreter first.",
    );
    return;
  }

  const name = await promptPackageName();
  if (!name) {
    return;
  }

  const parentDir = await promptParentFolder();
  if (!parentDir) {
    return;
  }

  const targetDir = path.join(parentDir, name);
  if (fs.existsSync(targetDir)) {
    vscode.window.showErrorMessage(
      `Cannot create package: ${targetDir} already exists.`,
    );
    return;
  }

  const hasGitIdentity = await checkGitIdentity();
  const options = await promptTemplateOptions(hasGitIdentity);
  if (!options) {
    return;
  }

  let githubUser = "";
  if (options.has("git") || options.has("ci") || options.has("docs")) {
    // PkgTemplates needs a hosting-service username for these plugins (git
    // remote URLs, CI badges, docs links). Prefer the one configured in git
    // (`git config github.user`), else ask.
    githubUser = (await readGitConfig("github.user")) ?? "";
    if (!githubUser) {
      const input = await vscode.window.showInputBox({
        title: "GitHub Username",
        prompt:
          "Used for the git remote URL and badges (required by the selected options)",
        ignoreFocusOut: true,
        validateInput: (value) =>
          value.trim().length === 0
            ? "A GitHub username is required for the selected options"
            : undefined,
      });
      if (input === undefined) {
        return;
      }
      githubUser = input.trim();
    }
  }

  const scriptPath = path.join(
    context.extensionPath,
    "scripts",
    "packages",
    "create_package.jl",
  );
  const helperEnvDir = path.join(
    context.globalStorageUri.fsPath,
    "pkgtemplates-env",
  );
  fs.mkdirSync(helperEnvDir, { recursive: true });

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Creating Julia package '${name}'...`,
      cancellable: true,
    },
    (progress, token) =>
      runCreatePackageScript(
        installation,
        scriptPath,
        helperEnvDir,
        name,
        parentDir,
        githubUser,
        options,
        progress,
        token,
      ),
  );

  if (result === "cancelled") {
    return;
  }

  if (result === "failed" || !fs.existsSync(targetDir)) {
    vscode.window
      .showErrorMessage(
        `Failed to create Julia package '${name}'. See the output log for details.`,
        "Show Log",
      )
      .then((choice) => {
        if (choice === "Show Log") {
          LOGGER.show();
        }
      });
    return;
  }

  const message =
    result === "fallback"
      ? `Created Julia package '${name}' with Pkg.generate (PkgTemplates was unavailable).`
      : `Created Julia package '${name}'.`;
  const action = await vscode.window.showInformationMessage(
    message,
    "Open in New Window",
    "Add to Workspace",
  );
  const targetUri = vscode.Uri.file(targetDir);
  if (action === "Open in New Window") {
    await vscode.commands.executeCommand("vscode.openFolder", targetUri, {
      forceNewWindow: true,
    });
  } else if (action === "Add to Workspace") {
    vscode.workspace.updateWorkspaceFolders(
      vscode.workspace.workspaceFolders?.length ?? 0,
      0,
      { uri: targetUri },
    );
  }
}

async function promptPackageName(): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({
    title: "New Julia Package",
    prompt: "Package name",
    placeHolder: "MyPackage",
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim().replace(/\.jl$/i, "");
      if (trimmed.length === 0) {
        return "Package name is required";
      }
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(trimmed)) {
        return "Package names must start with a letter and contain only letters, digits, and underscores";
      }
      if (!/^[A-Z]/.test(trimmed)) {
        return {
          message:
            "Julia package names conventionally start with an uppercase letter",
          severity: vscode.InputBoxValidationSeverity.Warning,
        };
      }
      return undefined;
    },
  });

  if (input === undefined) {
    return undefined;
  }
  // Accept "MyPackage.jl" as a convenience; the directory and module are
  // always the bare name.
  return input.trim().replace(/\.jl$/i, "");
}

async function promptParentFolder(): Promise<string | undefined> {
  const defaultUri =
    vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
  const folders = await vscode.window.showOpenDialog({
    title: "Select the folder to create the package in",
    openLabel: "Create Package Here",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri,
  });
  return folders?.[0]?.fsPath;
}

async function promptTemplateOptions(
  hasGitIdentity: boolean,
): Promise<Set<string> | undefined> {
  const items: PackageOptionItem[] = [
    {
      id: "git",
      label: "Git repository",
      description: hasGitIdentity
        ? "Initialize a git repository with an initial commit"
        : "Requires git user.name and user.email to be configured",
      picked: hasGitIdentity,
    },
    {
      id: "license",
      label: "MIT license",
      description: "Add an MIT LICENSE file",
      picked: true,
    },
    {
      id: "ci",
      label: "GitHub Actions CI",
      description: "Add a workflow that runs the package tests",
      picked: false,
    },
    {
      id: "docs",
      label: "Documenter.jl docs",
      description: "Scaffold a docs/ site built with Documenter.jl",
      picked: false,
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: "Package Template Options",
    placeHolder: "Select what to include (tests and README are always included)",
    canPickMany: true,
    ignoreFocusOut: true,
  });

  if (picked === undefined) {
    return undefined;
  }
  return new Set(picked.map((item) => item.id));
}

function runCreatePackageScript(
  installation: JuliaInstallation,
  scriptPath: string,
  helperEnvDir: string,
  name: string,
  parentDir: string,
  githubUser: string,
  options: Set<string>,
  progress: vscode.Progress<{ message?: string }>,
  token: vscode.CancellationToken,
): Promise<"created" | "fallback" | "failed" | "cancelled"> {
  return new Promise((resolve) => {
    const args = [
      "--startup-file=no",
      "--history-file=no",
      "--color=no",
      `--project=${helperEnvDir}`,
      scriptPath,
      name,
      parentDir,
      githubUser,
      Array.from(options).join(","),
    ];

    LOGGER.info(
      `Creating Julia package: ${installation.binpath} ${args.join(" ")}`,
    );
    progress.report({
      message: "This may take a few minutes on first run",
    });

    const proc = cp.spawn(installation.binpath, args);
    let sawFallback = false;
    let stderrTail = "";

    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      if (text.includes("CREATED-FALLBACK")) {
        sawFallback = true;
      }
      LOGGER.info(`[Create Package] ${text.trim()}`);
    });

    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      LOGGER.info(`[Create Package] ${text.trim()}`);
      // PkgTemplates logs progress to stderr; surface the latest line in
      // the notification so long installs don't look stuck.
      const lastLine = text.trim().split("\n").pop();
      if (lastLine) {
        progress.report({ message: lastLine.slice(0, 80) });
      }
    });

    token.onCancellationRequested(() => {
      proc.kill();
      resolve("cancelled");
    });

    proc.on("error", (error) => {
      LOGGER.error(`Failed to spawn Julia for package creation: ${error}`);
      resolve("failed");
    });

    proc.on("close", (code) => {
      if (token.isCancellationRequested) {
        resolve("cancelled");
        return;
      }
      if (code === 0) {
        resolve(sawFallback ? "fallback" : "created");
      } else {
        LOGGER.error(
          `Package creation exited with code ${code}: ${stderrTail}`,
        );
        resolve("failed");
      }
    });
  });
}

/** Whether git has user.name and user.email configured (needed by the Git plugin). */
async function checkGitIdentity(): Promise<boolean> {
  const name = await readGitConfig("user.name");
  const email = await readGitConfig("user.email");
  return Boolean(name && email);
}

function readGitConfig(key: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    cp.execFile("git", ["config", "--get", key], (error, stdout) => {
      resolve(error ? undefined : stdout.trim() || undefined);
    });
  });
}
