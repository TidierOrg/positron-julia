/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
 *  Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';

import { JuliaInstallation } from './julia-installation';
import { JupyterKernelSpec } from './positron-supervisor';
import { LOGGER } from './extension';

/**
 * Creates a Jupyter kernel spec for launching Julia with IJulia.
 *
 * @param installation The Julia installation to create a kernel spec for.
 * @param userProjectPath Optional path to the user's Julia project to activate after bootstrapping.
 * @param explicitProject The user picked `userProjectPath` explicitly: activate it
 *   even if it has no Project.toml yet.
 * @returns A JupyterKernelSpec for the Julia installation.
 */
export function createJuliaKernelSpec(
	installation: JuliaInstallation,
	userProjectPath?: string,
	explicitProject = false,
): JupyterKernelSpec {
	// Get the log level from configuration
	const kernelConfig = vscode.workspace.getConfiguration('positron.julia.kernel');
	const logLevel = kernelConfig.get<string>('logLevel', 'warn');

	// Get Julia-specific user settings
	const juliaConfig = vscode.workspace.getConfiguration('julia');
	const positronJuliaConfig = vscode.workspace.getConfiguration('positron.julia');
	const numThreadsSetting = juliaConfig.get<number | string | null>('NumThreads', null);
	const numThreads = numThreadsSetting !== null && numThreadsSetting !== undefined
		? String(numThreadsSetting)
		: (process.env.JULIA_NUM_THREADS || 'auto');
	const additionalArgs = juliaConfig.get<string[]>('additionalArgs', []);
	const packageServer = juliaConfig.get<string>('packageServer', '').trim();
	const importUnimportedHelpPackages = positronJuliaConfig.get<boolean>('help.importUnimportedPackages', true);

	// Build the kernel arguments
	// The {connection_file} and {log_file} placeholders are replaced by the supervisor
	// Note: We use --logfile so the supervisor can find it on restore/reconnect
	const argv = [
		installation.binpath,
		'-i',  // Interactive mode
		'--color=yes',
		...additionalArgs,
		'-e',
		getKernelStartupCode(),
		'{connection_file}',
		'--logfile',
		'{log_file}',  // Log file path for kernel output
	];

	// Build environment variables
	const env: NodeJS.ProcessEnv = {
		// Julia-specific environment variables
		JULIA_NUM_THREADS: numThreads,
		JULIA_COLORS: 'yes',

		// Positron-specific environment variables
		POSITRON: '1',
		POSITRON_VERSION: vscode.version,
		POSITRON_MODE: 'console',
		POSITRON_JULIA_HELP_IMPORT_UNIMPORTED_PACKAGES: importUnimportedHelpPackages ? '1' : '0',

		// Log level for debugging
		JULIA_DEBUG: logLevel === 'trace' || logLevel === 'debug' ? 'all' : '',
	};

	if (packageServer) {
		env['JULIA_PKG_SERVER'] = packageServer;
	}

	if (userProjectPath) {
		env['POSITRON_USER_PROJECT'] = userProjectPath;
		if (explicitProject) {
			env['POSITRON_USER_PROJECT_EXPLICIT'] = '1';
		}
	}

	// Add any user-configured environment variables
	const userEnv = kernelConfig.get<Record<string, string>>('env', {});
	Object.assign(env, userEnv);

	LOGGER.debug(`Creating kernel spec for Julia ${installation.version}`);
	LOGGER.debug(`  argv: ${argv.join(' ')}`);

	return {
		argv,
		display_name: `Julia ${installation.version}`,
		language: 'julia',
		interrupt_mode: 'signal',
		env,
		kernel_protocol_version: '5.3',  // IJulia supports Jupyter protocol 5.3
	};
}

/**
 * Returns the Julia code that starts the IJulia kernel.
 *
 * This code:
 * 1. Activates the bundled Positron.jl project
 * 2. Ensures project dependencies are available (instantiates on first run,
 *    and explicitly builds IJulia if its build never completed)
 * 3. Loads IJulia and Positron.jl services
 * 4. Starts the kernel with IJulia.run_kernel()
 *
 * The connection file is passed as a command line argument and is
 * automatically read by IJulia.run_kernel().
 *
 */
function getKernelStartupCode(): string {
	const positronPath = path.join(
		__dirname,
		'..',
		'julia',
		'Positron'
	).replace(/\\/g, '/');  // Use forward slashes for Julia

	// Command line args are: connection_file, --logfile, log_file_path
	// We need to set POSITRON_KERNEL_LOG before loading Positron so logging works
	return `
		for i in 1:length(ARGS)-1
			if ARGS[i] == "--logfile"
				ENV["POSITRON_KERNEL_LOG"] = ARGS[i+1];
				break;
			end;
		end;
		using Pkg;
		Pkg.activate("${positronPath}");
		# Keep the Positron project reachable as a LOAD_PATH fallback even
		# after we later Pkg.activate() the user's project below. IJulia's
		# own run_kernel() does an internal "using IJulia", which Julia
		# resolves against whichever project is active *at that moment* -
		# not against modules already loaded in memory. Without this, that
		# internal import fails with "Package IJulia not found in current
		# path" once we've switched the active project away from here.
		push!(LOAD_PATH, "${positronPath}");

		function __positron_bootstrap__()
			local has_ijulia = false
			local has_positron = false

			try
				@eval import IJulia
				has_ijulia = true
			catch e
				println("Julia: IJulia not ready, running bootstrap...");
			end

			try
				@eval using Positron
				has_positron = true
			catch e
				# Positron depends on JSON3/StructTypes/etc from this project.
				# If any are missing, instantiate and retry.
			end

			if !has_ijulia || !has_positron
				println("Julia: Installing Positron kernel dependencies (one-time setup)...");
				try
					# IJULIA_NODEFAULTKERNEL skips IJulia's installkernel step,
					# which writes a kernelspec into the user's global Jupyter
					# data directory. Positron launches the kernel itself via
					# its own kernel spec, so that global kernelspec is unused
					# here. This wraps Pkg.instantiate() too, since a fresh
					# depot downloads and builds IJulia right there, not only
					# in the repair branch below.
					withenv("IJULIA_NODEFAULTKERNEL" => "1") do
						Pkg.instantiate();

						if !has_ijulia
							# Pkg.instantiate() only runs build scripts for
							# packages it downloads in this same call. A depot
							# that already has an IJulia source tree but never
							# finished building it (e.g. an earlier build that
							# failed partway) is therefore never repaired by
							# instantiate alone, and "import IJulia" keeps
							# failing with "IJulia not properly installed" on
							# every restart. Build it explicitly so the kernel
							# self-heals.
							# Mirrored by the "IJulia unbuilt-state recovery"
							# CI step in .github/workflows/ci.yml — keep both
							# in sync.
							Pkg.build("IJulia");
						end

						Pkg.precompile();
					end

					if !has_ijulia
						@eval import IJulia
					end
					if !has_positron
						@eval using Positron
					end
				catch e
					println(stderr, "Julia: Positron kernel setup failed.");
					println(stderr, "Try running this in a Julia terminal, then restart the session:");
					println(stderr, "  julia --project=\\"${positronPath}\\" -e 'using Pkg; Pkg.instantiate(); Pkg.build(\\"IJulia\\")'");
					rethrow(e)
				end
			end
		end

		__positron_bootstrap__();

		try
			using Positron;
			Positron.start_services!();
		catch e
			@warn "Failed to load Positron.jl services" exception=e;
		end;
		let user_project = get(ENV, "POSITRON_USER_PROJECT", "")
			if !isempty(user_project) && (
				isfile(joinpath(user_project, "Project.toml")) ||
				isfile(joinpath(user_project, "JuliaProject.toml")) ||
				# Picked explicitly as a new project: Pkg creates Project.toml
				# on the first add.
				get(ENV, "POSITRON_USER_PROJECT_EXPLICIT", "") == "1"
			)
				Pkg.activate(user_project)
			else
				# No valid workspace project: activate() with no arguments
				# toggles back to whatever was active before the bundled
				# Positron.jl activation above (the user's default global
				# environment, e.g. @v1.12). Without this, the console and
				# Pkg REPL mode would stay pinned to the extension's own
				# internal project forever.
				Pkg.activate()
			end
		end;
		IJulia.run_kernel();
		exit()
		`.trim();
}
