# ---------------------------------------------------------------------------------------------
# Copyright (C) 2025 Posit Software, PBC. All rights reserved.
# Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
# ---------------------------------------------------------------------------------------------

"""
Profiler service for Positron.

Captures Julia profile data via `Profile.fetch()` (and `Profile.Allocs.fetch()`
when available) and converts it into the tree structure consumed by the
flame graph renderer that ships with the Positron Julia extension. The tree
format mirrors the one produced by julia-vscode so the standalone
`profile-viewer.js` renderer can be reused unchanged.
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

const PROFILE_ALL_THREADS_NAME = "all"

"""
A single frame in the profile tree. Matches the JSON structure expected by
the flame graph renderer.
"""
mutable struct ProfileFrame
    func::String
    file::String          # human readable file name
    path::String          # absolute path
    line::Int             # 1-based line number
    count::Int            # number of samples in this frame
    countLabel::Union{Nothing,String} # defaults to `$count samples` on the frontend
    flags::UInt8          # any or all of ProfileFrameFlag
    taskId::Union{Nothing,UInt}
    children::Vector{ProfileFrame}
end

ProfileFrame() = ProfileFrame("root", "", "", 0, 0, nothing, 0x0, nothing, ProfileFrame[])

StructTypes.StructType(::Type{ProfileFrame}) = StructTypes.Struct()

"""
Convert a `ProfileFrame` tree into nested `Dict`s and `Vector`s so it can be
serialized by IJulia's bundled JSON encoder, which does not understand
arbitrary Julia structs.
"""
function profile_frame_to_dict(frame::ProfileFrame)
    return Dict{String,Any}(
        "func" => frame.func,
        "file" => frame.file,
        "path" => frame.path,
        "line" => frame.line,
        "count" => frame.count,
        "countLabel" => frame.countLabel,
        "flags" => Int(frame.flags),
        "taskId" => frame.taskId,
        "children" => Any[profile_frame_to_dict(c) for c in frame.children],
    )
end

"""
Resolve `path` into an absolute path, mirroring julia-vscode's `fullpath`
helper. Falls back to the input when the path can't be resolved.
"""
function profile_fullpath(path::AbstractString)::String
    p = String(path)
    isempty(p) && return p
    try
        resolved = if isabspath(p)
            p
        else
            base_candidate =
                normpath(joinpath(Sys.BINDIR, Base.DATAROOTDIR, "julia", "base", p))
            isfile(base_candidate) ? base_candidate : p
        end
        return normpath(ispath(resolved) ? realpath(resolved) : resolved)
    catch
        return p
    end
end

"""
Build the profile tree for the current `Profile.fetch()` data and return a
dict keyed by thread label. The structure is suitable for serialization to
the frontend.
"""
function build_profile_tree(
    data::Vector{<:Union{UInt64,UInt}} = Profile.fetch();
    C::Bool = false,
    combine::Bool = true,
    recur::Symbol = :off,
)::Union{Dict{String,ProfileFrame},Nothing}
    if isempty(data)
        return nothing
    end

    threads = if VERSION >= v"1.8.0-DEV.460"
        sorted_tids = sort([
            Threads.threadpooltids(:interactive)...,
            Threads.threadpooltids(:default)...,
        ])
        Any[nothing, sorted_tids...]
    else
        Any[nothing]
    end

    lidict = Profile.getdict(unique(data))
    data_u64 = convert(Vector{UInt64}, data)

    result = Dict{String,ProfileFrame}()
    for thread in threads
        graph = profile_stackframe_tree(
            data_u64,
            lidict;
            thread = thread,
            combine = combine,
            recur = recur,
        )
        thread_name = if thread === nothing
            PROFILE_ALL_THREADS_NAME
        else
            "$(thread) ($(Threads.threadpool(thread)))"
        end

        root = ProfileFrame()
        root.count = graph.count
        make_profile_tree!(root, graph; C = C)
        result[thread_name] = root
    end

    return result
end

function profile_stackframe_tree(
    data_u64::Vector{UInt64},
    lidict;
    thread = nothing,
    combine::Bool = true,
    recur::Symbol = :off,
)
    root = combine ? Profile.StackFrameTree{StackTraces.StackFrame}() :
                     Profile.StackFrameTree{UInt64}()
    if VERSION >= v"1.8.0-DEV.460"
        root, _ = Profile.tree!(root, data_u64, lidict, true, recur, thread)
    else
        root = Profile.tree!(root, data_u64, lidict, true, recur)
    end
    if !isempty(root.down)
        root.count = sum(pr -> pr.second.count, root.down)
    end
    return root
end

function frame_status(sf::StackTraces.StackFrame)
    st = UInt8(0)
    if sf.from_c &&
       (sf.func === :jl_invoke || sf.func === :jl_apply_generic ||
        sf.func === :ijl_apply_generic)
        st |= ProfileFrameFlag.RuntimeDispatch
    end
    if sf.from_c && startswith(String(sf.func), "jl_gc_")
        st |= ProfileFrameFlag.GCEvent
    end
    if !sf.from_c && sf.func === :eval_user_input && endswith(String(sf.file), "REPL.jl")
        st |= ProfileFrameFlag.REPL
    end
    if !sf.from_c && occursin("./compiler/", String(sf.file))
        st |= ProfileFrameFlag.Compilation
    end
    if !sf.from_c && occursin("task.jl", String(sf.file))
        st |= ProfileFrameFlag.TaskEvent
    end
    return st
end

function frame_status(node::Profile.StackFrameTree, C::Bool)
    st = frame_status(node.frame)
    C && return st
    for child in values(node.down)
        child.frame.from_c || continue
        st |= frame_status(child, C)
    end
    return st
end

function add_profile_child!(graph::ProfileFrame, node::Profile.StackFrameTree, C::Bool)
    name = string(node.frame.file)
    func = String(node.frame.func)
    if isempty(func)
        func = "unknown"
    end

    frame = ProfileFrame(
        func,
        basename(name),
        profile_fullpath(name),
        node.frame.line,
        node.count,
        nothing,
        frame_status(node, C),
        nothing,
        ProfileFrame[],
    )

    push!(graph.children, frame)
    return frame
end

function make_profile_tree!(graph::ProfileFrame, node::Profile.StackFrameTree; C::Bool = false)
    sorted = sort!(collect(values(node.down)); rev = true, by = n -> n.count)
    for child_node in sorted
        if C || !child_node.frame.from_c
            child = add_profile_child!(graph, child_node, C)
            make_profile_tree!(child, child_node; C = C)
        else
            make_profile_tree!(graph, child_node; C = C)
        end
    end
    return graph
end

# -----------------------------------------------------------------------------
# Allocation profiling
# -----------------------------------------------------------------------------

const PROFILE_ALLOC_PREFIXES = ["bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"]

function profile_memory_size(size::Real)::String
    i = 1
    while size > 1000 && i + 1 < length(PROFILE_ALLOC_PREFIXES)
        size /= 1000
        i += 1
    end
    return string(round(Int, size), " ", PROFILE_ALLOC_PREFIXES[i])
end

"""
Build the allocation-profile tree from `Profile.Allocs.fetch()` output. Returns
a `Dict` with two roots, `"size"` and `"count"`, suitable for the flame graph
selector. Returns `nothing` if the runtime does not support `Profile.Allocs`.
"""
function build_alloc_profile_tree(
    results = nothing;
    C::Bool = false,
)::Union{Dict{String,ProfileFrame},Nothing}
    isdefined(Profile, :Allocs) || return nothing

    fetched = results === nothing ? Profile.Allocs.fetch() : results
    allocs = fetched.allocs

    allocs_root = ProfileFrame()
    counts_root = ProfileFrame()

    for alloc in allocs
        this_allocs = allocs_root
        this_counts = counts_root

        for sf in Iterators.reverse(alloc.stacktrace)
            if !C && sf.from_c
                continue
            end
            file = string(sf.file)
            template = ProfileFrame(
                string(sf.func),
                basename(file),
                profile_fullpath(file),
                sf.line,
                0,
                nothing,
                0x0,
                nothing,
                ProfileFrame[],
            )

            ind = findfirst(
                c -> c.func == template.func && c.path == template.path && c.line == template.line,
                this_allocs.children,
            )

            this_counts, this_allocs = if ind === nothing
                push!(this_counts.children, template)
                allocs_clone = deepcopy(template)
                push!(this_allocs.children, allocs_clone)
                (template, allocs_clone)
            else
                (this_counts.children[ind], this_allocs.children[ind])
            end

            this_allocs.count += alloc.size
            this_allocs.countLabel = profile_memory_size(this_allocs.count)
            this_counts.count += 1
        end

        alloc_type = replace(string(alloc.type), "Profile.Allocs." => "")
        ind = findfirst(c -> c.func == alloc_type, this_allocs.children)
        if ind === nothing
            push!(
                this_allocs.children,
                ProfileFrame(
                    alloc_type,
                    "",
                    "",
                    0,
                    this_allocs.count,
                    profile_memory_size(this_allocs.count),
                    ProfileFrameFlag.GCEvent,
                    nothing,
                    ProfileFrame[],
                ),
            )
            push!(
                this_counts.children,
                ProfileFrame(
                    alloc_type,
                    "",
                    "",
                    0,
                    1,
                    nothing,
                    ProfileFrameFlag.GCEvent,
                    nothing,
                    ProfileFrame[],
                ),
            )
        else
            this_counts.children[ind].count += 1
            this_allocs.children[ind].count += alloc.size
            this_allocs.children[ind].countLabel =
                profile_memory_size(this_allocs.children[ind].count)
        end

        counts_root.count += 1
        allocs_root.count += alloc.size
        allocs_root.countLabel = profile_memory_size(allocs_root.count)
    end

    return Dict{String,ProfileFrame}("size" => allocs_root, "count" => counts_root)
end
