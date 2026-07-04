# ---------------------------------------------------------------------------------------------
# Copyright (C) 2024-2026 Posit Software, PBC. All rights reserved.
# Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
# ---------------------------------------------------------------------------------------------

# Scaffolds a new Julia package with PkgTemplates. Run as a subprocess by the
# "Julia: Create New Package" command with a dedicated `--project` environment
# so PkgTemplates is never installed into the user's own projects:
#
#   julia --project=<helper-env> create_package.jl <name> <parent_dir> <github_user> <plugins>
#
# <plugins> is a comma-separated subset of: git, license, ci, docs.
# <github_user> may be empty; PkgTemplates requires it for the git/ci/docs
# plugins (remote URLs and badges), and the extension prompts for it when any
# of those is selected.
#
# Prints `CREATED <path>` on success (`CREATED-FALLBACK <path>` when PkgTemplates
# was unavailable and the package was scaffolded with Pkg.generate instead).

import Pkg

length(ARGS) >= 4 ||
    error("usage: create_package.jl <name> <parent_dir> <github_user> <plugins>")

const PKG_NAME = ARGS[1]
const PARENT_DIR = ARGS[2]
const GITHUB_USER = ARGS[3]
const SELECTED = Set(String.(split(ARGS[4], ','; keepempty = true)))
const TARGET = joinpath(PARENT_DIR, PKG_NAME)

isdir(TARGET) && error("Target directory already exists: $TARGET")

function ensure_pkgtemplates()::Bool
    if Base.find_package("PkgTemplates") === nothing
        @info "Installing PkgTemplates into the helper environment (first run only)"
        try
            Pkg.add("PkgTemplates")
        catch err
            @warn "Could not install PkgTemplates" exception = err
            return false
        end
    end
    return true
end

# Local-first plugin set built on top of the PkgTemplates defaults. Registry
# automation (CompatHelper, TagBot) is left out: it only makes sense for
# registered packages and can be added by hand later. Referenced lazily so
# this file loads even without PkgTemplates.
function build_plugins()
    plugins = Any[!PkgTemplates.CompatHelper, !PkgTemplates.TagBot]

    "git" in SELECTED || push!(plugins, !PkgTemplates.Git)

    if "license" in SELECTED
        push!(plugins, PkgTemplates.License(name = "MIT"))
    else
        push!(plugins, !PkgTemplates.License)
    end

    if "ci" in SELECTED
        push!(plugins, PkgTemplates.GitHubActions())
    else
        # Both are defaults in recent PkgTemplates versions; Dependabot only
        # manages the CI workflow versions, so it goes with the ci option.
        push!(plugins, !PkgTemplates.GitHubActions)
        if isdefined(PkgTemplates, :Dependabot)
            push!(plugins, !PkgTemplates.Dependabot)
        end
    end

    if "docs" in SELECTED
        if "ci" in SELECTED
            push!(plugins, PkgTemplates.Documenter{PkgTemplates.GitHubActions}())
        else
            push!(plugins, PkgTemplates.Documenter())
        end
    end

    return plugins
end

function generate_with_pkgtemplates()
    kwargs = Dict{Symbol, Any}(:dir => PARENT_DIR, :plugins => build_plugins())
    isempty(GITHUB_USER) || (kwargs[:user] = GITHUB_USER)
    template = PkgTemplates.Template(; kwargs...)
    template(PKG_NAME)
    println("CREATED ", TARGET)
end

function generate_fallback()
    @warn "Falling back to Pkg.generate (PkgTemplates unavailable)"
    Pkg.generate(TARGET)
    println("CREATED-FALLBACK ", TARGET)
end

# Each of the following runs as its own top-level statement so the world age
# advances in between: code executed after the conditional import sees the
# PkgTemplates bindings without any invokelatest juggling.
const HAVE_PKGTEMPLATES = ensure_pkgtemplates()

HAVE_PKGTEMPLATES && @eval(import PkgTemplates)

if HAVE_PKGTEMPLATES
    generate_with_pkgtemplates()
else
    generate_fallback()
end
