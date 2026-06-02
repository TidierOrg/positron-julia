# ---------------------------------------------------------------------------------------------
# Copyright (C) 2025 Posit Software, PBC. All rights reserved.
# Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
# ---------------------------------------------------------------------------------------------

"""
Profile comm wiring.

The profile comm is kernel-initiated: when the user runs `@profview` (or the
allocation variant), the kernel builds a profile tree and opens a transient
`positron.profile` comm whose payload carries the tree. The extension creates
a webview to show the flame graph and then closes the comm.

This file owns:
- `ProfilerService`, the service that exposes user-facing entry points and
  routes the resulting tree through a new comm.
- `@profview` / `@profview_allocs` macros that mirror julia-vscode.
"""

const PROFILE_COMM_TARGET = "positron.profile"

"""
Service responsible for capturing profile traces and forwarding them to the
Positron extension. Stateless aside from a reference back to the kernel so we
can find the IJulia kernel for comm sends.
"""
mutable struct ProfilerService
    enabled::Bool

    ProfilerService() = new(true)
end

"""
Initialize the profiler service. Nothing to set up eagerly — comms are opened
per-trace.
"""
function init!(::ProfilerService)
    kernel_log_info("ProfilerService initialized")
end

"""
Build a trace dict from the supplied data and send it to the frontend through
a fresh `positron.profile` comm.

`trace_type` becomes the selector label in the flame graph UI (`"Thread"` for
the CPU profiler, `"Allocation"` for the allocation profiler).
"""
function send_profile_trace!(
    service::ProfilerService,
    trace::Dict{String,ProfileFrame},
    trace_type::String,
)
    if !service.enabled
        return
    end

    if isempty(trace)
        kernel_log_warn("Profile trace is empty, nothing to send")
        return
    end

    comm = create_comm(PROFILE_COMM_TARGET)
    # IJulia's JSON encoder (JSONX) does not understand arbitrary structs, so
    # convert ProfileFrame instances to plain Dicts before handing over.
    payload = Dict{String,Any}(
        "trace" => Dict{String,Any}(k => profile_frame_to_dict(v) for (k, v) in trace),
        "type" => trace_type,
    )

    try
        open!(comm; data = payload)
    catch e
        kernel_log_error("Failed to open profile comm: $(sprint(showerror, e))")
        return
    end

    # The trace data is delivered as part of comm_open; we have no follow-up
    # protocol to maintain so close the comm immediately.
    try
        close!(comm)
    catch e
        kernel_log_warn("Error closing profile comm: $(sprint(showerror, e))")
    end
end

"""
Capture the current CPU profile buffer and send it to the frontend.

This is the function the `@profview` macro lowers into. Accepts the same
keyword arguments as julia-vscode's `view_profile`.
"""
function send_cpu_profile!(
    service::ProfilerService,
    data = Profile.fetch();
    C::Bool = false,
    combine::Bool = true,
    recur::Symbol = :off,
)
    if isempty(data)
        try
            Profile.warning_empty()
        catch
        end
        return
    end

    tree = build_profile_tree(data; C = C, combine = combine, recur = recur)
    if tree === nothing
        return
    end

    send_profile_trace!(service, tree, "Thread")
end

"""
Capture the current allocation profile buffer and send it to the frontend.
"""
function send_alloc_profile!(
    service::ProfilerService,
    results = nothing;
    C::Bool = false,
)
    if !isdefined(Profile, :Allocs)
        @error "This version of Julia does not support the allocation profiler."
        return
    end

    tree = build_alloc_profile_tree(results; C = C)
    if tree === nothing
        return
    end

    send_profile_trace!(service, tree, "Allocation")
end

# -----------------------------------------------------------------------------
# User-facing macros (mirroring julia-vscode)
# -----------------------------------------------------------------------------

"""
    @profview f(args...) [C=false]

Clear the Profile buffer, profile `f(args...)`, and display the result in
Positron's profiler pane. `C = true` includes C frames.
"""
macro profview(ex, args...)
    return quote
        Profile.clear()
        Profile.@profile $(esc(ex))
        Positron.send_cpu_profile!(Positron.get_kernel().profiler; $(esc.(args)...))
    end
end

"""
    @profview_allocs f(args...) [sample_rate=0.0001] [C=false]

Clear the allocation profile buffer, profile allocations of `f(args...)`, and
display the result in Positron's profiler pane.
"""
macro profview_allocs(ex, args...)
    sample_rate_expr = :(sample_rate = 0.0001)
    for arg in args
        if Meta.isexpr(arg, :(=)) && length(arg.args) > 0 && arg.args[1] === :sample_rate
            sample_rate_expr = arg
        end
    end
    if isdefined(Profile, :Allocs)
        return quote
            Profile.Allocs.clear()
            Profile.Allocs.@profile $(esc(sample_rate_expr)) $(esc(ex))
            Positron.send_alloc_profile!(Positron.get_kernel().profiler)
        end
    else
        return :(@error "This version of Julia does not support the allocation profiler.")
    end
end
