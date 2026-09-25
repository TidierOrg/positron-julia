# Adapted from julia-vscode (https://github.com/julia-vscode/julia-vscode),
# scripts/packages/VSCodeServer/src/profiler.jl.
# Copyright (c) 2012-2025 julia-vscode contributors.
# Licensed under the MIT License. See LICENSE-MIT for license information.

"""
CPU profiling for the Positron flame graph viewer (`@profview`).

A profile is serialized into the frame tree julia-vscode's viewer uses and sent
to the extension by opening a one-shot `positron.profile` comm whose open data
is the profile. The extension closes the comm once it has the data.
"""

using Profile

# https://github.com/timholy/FlameGraphs.jl/blob/master/src/graph.jl
const ProfileFrameFlag = (
    RuntimeDispatch = UInt8(2^0),
    GCEvent = UInt8(2^1),
    REPL = UInt8(2^2),
    Compilation = UInt8(2^3),
    TaskEvent = UInt8(2^4),
)

const ALL_THREADS_NAME = "all"

"""
    profile_frame(func, file, path, line, count, flags) -> Dict

One node of the profile tree, in the shape the flame graph viewer reads.
"""
function profile_frame(func::AbstractString, file::AbstractString, path::AbstractString,
                       line::Integer, count::Integer, flags::UInt8)
    return Dict{String,Any}(
        "func" => String(func),
        "file" => String(file),      # human readable file name
        "path" => String(path),      # absolute path, for click-to-source
        "line" => Int(line),         # 1-based
        "count" => Int(count),       # samples in this frame
        "flags" => Int(flags),       # any of ProfileFrameFlag
        "children" => Dict{String,Any}[],
    )
end

"""Absolute path of a profiled file: Base files are recorded relative to `base/`."""
function profile_file_path(file::AbstractString)
    p = isabspath(file) ? String(file) :
        normpath(joinpath(Sys.BINDIR, Base.DATAROOTDIR, "julia", "base", file))
    # Stdlib paths are recorded as they were on the build machine.
    if !ispath(p) && isdefined(Base, :fixup_stdlib_path)
        p = Base.fixup_stdlib_path(p)
    end
    return try
        ispath(p) ? realpath(p) : p
    catch
        p
    end
end

function frame_status(sf::StackTraces.StackFrame)
    st = UInt8(0)
    func = String(sf.func)
    file = String(sf.file)
    if sf.from_c && (sf.func === :jl_invoke || sf.func === :jl_apply_generic || sf.func === :ijl_apply_generic)
        st |= ProfileFrameFlag.RuntimeDispatch
    end
    if sf.from_c && startswith(func, "jl_gc_")
        st |= ProfileFrameFlag.GCEvent
    end
    if !sf.from_c && sf.func === :eval_user_input && endswith(file, "REPL.jl")
        st |= ProfileFrameFlag.REPL
    end
    if !sf.from_c && occursin("./compiler/", file)
        st |= ProfileFrameFlag.Compilation
    end
    if !sf.from_c && occursin("task.jl", file)
        st |= ProfileFrameFlag.TaskEvent
    end
    return st
end

function frame_status(node::Profile.StackFrameTree, C::Bool)
    st = frame_status(node.frame)
    C && return st
    # When C frames are hidden, report what their C children did.
    for child in values(node.down)
        child.frame.from_c || continue
        st |= frame_status(child, C)
    end
    return st
end

function add_child!(graph::Dict{String,Any}, node::Profile.StackFrameTree, C::Bool)
    file = string(node.frame.file)
    func = String(node.frame.func)
    frame = profile_frame(
        isempty(func) ? "unknown" : func,
        basename(file),
        profile_file_path(file),
        node.frame.line,
        node.count,
        frame_status(node, C),
    )
    push!(graph["children"], frame)
    return frame
end

function make_tree!(graph::Dict{String,Any}, node::Profile.StackFrameTree; C::Bool = false)
    for child_node in sort!(collect(values(node.down)); rev = true, by = n -> n.count)
        if C || !child_node.frame.from_c
            child = add_child!(graph, child_node, C)
            make_tree!(child, child_node; C = C)
        else
            # Hidden C frame: attach its children to the nearest Julia frame.
            make_tree!(graph, child_node; C = C)
        end
    end
    return graph
end

function stackframe_tree(data_u64::Vector{UInt64}, lidict; thread = nothing)
    root = Profile.StackFrameTree{StackTraces.StackFrame}()
    root, _ = Profile.tree!(root, data_u64, lidict, true, :off, thread)
    if !isempty(root.down)
        root.count = sum(pr -> pr.second.count, root.down)
    end
    return root
end

"""
    profile_trees(data, lidict; C = false) -> Union{Dict, Nothing}

The profile as one frame tree per thread plus an `"all"` tree, keyed by thread
name, or `nothing` when no samples were collected.
"""
function profile_trees(data = Profile.fetch(), lidict = Profile.getdict(unique(data)); C::Bool = false)
    isempty(data) && return nothing
    data_u64 = convert(Vector{UInt64}, data)

    all_tids = sort([Threads.threadpooltids(:interactive)..., Threads.threadpooltids(:default)...])
    width = length(string(all_tids[end]))  # pad thread ids so they sort numerically

    trees = Dict{String,Any}()
    for thread in Any[nothing, all_tids...]
        graph = stackframe_tree(data_u64, lidict; thread = thread)
        name = thread === nothing ? ALL_THREADS_NAME :
            "$(lpad(string(thread), width)) ($(Threads.threadpool(thread)))"
        root = profile_frame("root", "", "", 0, graph.count, 0x00)
        trees[name] = make_tree!(root, graph; C = C)
    end
    return trees
end

"""
    view_profile(; C = false)

Send the current contents of the profile buffer to Positron's flame graph viewer.
"""
function view_profile(; C::Bool = false)
    trees = profile_trees(; C = C)
    if trees === nothing
        Profile.warning_empty()
        return nothing
    end
    try
        open!(create_comm("positron.profile"); data = Dict{String,Any}("data" => trees, "type" => "Thread"))
    catch e
        @warn "Could not send the profile to Positron" exception = e
    end
    return nothing
end

"""
    @profview f(args...) [C = false]

Clear the profile buffer, profile `f(args...)`, and show the result as a flame
graph in Positron. `C = true` also shows C frames.

The expression runs once, so the profile includes compilation the first time
it runs; run it once beforehand to profile only the run time.
"""
macro profview(ex, args...)
    return quote
        Profile.clear()
        Profile.@profile $(esc(ex))
        view_profile(; $(esc.(args)...))
    end
end
