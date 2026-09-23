# ---------------------------------------------------------------------------------------------
# Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
# Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
# ---------------------------------------------------------------------------------------------

# Install LanguageServer.jl and dependencies into the extension's depot
#
# This script is run once to set up the language server packages.
# It installs into a dedicated depot to avoid polluting the user's environment.

using Pkg

@info "Installing Julia Language Server packages..."

# Install the required packages.
#
# Auto-precompile-on-add is disabled here so we can patch a known Julia 1.13
# incompatibility in SymbolServer.jl (see below) before its first precompile
# attempt. SymbolServer's own module-load-time load_core() call crashes on
# 1.13 whether or not precompilation "succeeds" - a failed .ji cache just
# falls back to interpreting the buggy source on every LS startup instead of
# failing once at install time.
withenv("JULIA_PKG_PRECOMPILE_AUTO" => "0") do
	# main.jl passes runserver() a depot_path argument, which LanguageServer.jl
	# 5.x accepts and 6.0 removed. Keep this range in sync with
	# SUPPORTED_LS_VERSIONS in src/lsp.ts.
	packages = [
		Pkg.PackageSpec(name="LanguageServer", version="5"),
		Pkg.PackageSpec(name="SymbolServer"),
	]
	for pkg in packages
		@info "Installing $(pkg.name)..."
		try
			Pkg.add(pkg)
		catch e
			@error "Failed to install $(pkg.name)" exception=(e, catch_backtrace())
			exit(1)
		end
	end
	# Record the bound in the environment so any later resolve keeps it.
	Pkg.compat("LanguageServer", "5")
end

# SymbolServer.jl re-declares the `jl_module_names` ccall itself instead of
# calling Base.unsorted_names(), hardcoding its C signature per Julia version.
# Julia 1.13 added a 5th `world::UInt` argument that no registered
# SymbolServer.jl release accounts for (as of 2026-09, days after 1.13
# shipped). The mismatched ccall doesn't error - it reads garbage off the
# stack for the missing argument, silently truncating the Base/Core symbol
# crawl. That surfaces far downstream as
# `MethodError: no method matching haskey(::SymbolServer.VarRef, ::Symbol)`
# inside load_core(), which runs at SymbolServer's own module-load time, so a
# monkeypatch after `using SymbolServer` would already be too late - it patches
# the installed source directly instead, before SymbolServer is ever loaded.
# Upstream fixed the same bug the same way in their vendored fork:
# https://github.com/julia-vscode/JuliaWorkspaces.jl/commit/584fef3f2da4327bef79f6dc903ab5d5bb18c045
let
	symbolserver_uuid = Base.UUID("cf896787-08d5-524d-9de7-132aaa0cb996")
	entry = get(Pkg.dependencies(), symbolserver_uuid, nothing)
	if entry !== nothing
		utils_file = joinpath(entry.source, "src", "utils.jl")
		if isfile(utils_file)
			buggy = """
			@static if VERSION < v"1.12-"
			    unsorted_names(m::Module; all::Bool=false, imported::Bool=false, usings=false) =
			        ccall(:jl_module_names, Array{Symbol,1}, (Any, Cint, Cint), m, all, imported)
			else
			    unsorted_names(m::Module; all::Bool=false, imported::Bool=false, usings=false) =
			         ccall(:jl_module_names, Array{Symbol,1}, (Any, Cint, Cint, Cint), m, all, imported, usings)
			end"""
			fixed = """
			@static if VERSION < v"1.12-"
			    unsorted_names(m::Module; all::Bool=false, imported::Bool=false, usings=false) =
			        Base.unsorted_names(m; all, imported)
			else
			    unsorted_names(m::Module; all::Bool=false, imported::Bool=false, usings=false) =
			        Base.unsorted_names(m; all, imported, usings)
			end"""
			content = read(utils_file, String)
			if occursin(buggy, content)
				@info "Patching SymbolServer.jl unsorted_names() for Julia $(VERSION) compatibility"
				chmod(utils_file, 0o644)
				write(utils_file, replace(content, buggy => fixed))
				chmod(utils_file, 0o444)
			elseif !occursin("Base.unsorted_names", content)
				@warn "SymbolServer.jl's unsorted_names() has changed shape; the Julia 1.13 compatibility patch did not apply. Language server features may fail to start."
			end
		end
	end
end

# Precompile to speed up first start
@info "Precompiling packages..."
try
	Pkg.precompile()
catch e
	@warn "Precompilation had issues" exception=(e, catch_backtrace())
end

@info "Language Server installation complete!"
