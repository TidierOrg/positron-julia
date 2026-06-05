# Ported from julia-vscode (https://github.com/julia-vscode/julia-vscode).
# Copyright (c) 2012-2025 julia-vscode contributors.
# Licensed under the MIT License. See LICENSE-MIT for license information.

# ENV["JULIA_DEBUG"] = "all"

pushfirst!(LOAD_PATH, joinpath(@__DIR__, "..", "packages"))
try
    import VSCodeDebugger
finally
    popfirst!(LOAD_PATH)
end

Base.load_julia_startup()

VSCodeDebugger.startdebugger()
