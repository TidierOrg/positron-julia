# ---------------------------------------------------------------------------------------------
# Copyright (C) 2025 Posit Software, PBC. All rights reserved.
# Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
# ---------------------------------------------------------------------------------------------

using Test
using Positron
using Profile
using IJulia

@testset "ProfileFrame" begin
    frame = Positron.ProfileFrame()
    @test frame.func == "root"
    @test frame.count == 0
    @test frame.children == Positron.ProfileFrame[]
end

@testset "profile_frame_to_dict" begin
    child = Positron.ProfileFrame("inner", "f.jl", "/abs/f.jl", 7, 3, "3 samples", 0x2, nothing, Positron.ProfileFrame[])
    parent = Positron.ProfileFrame("root", "", "", 0, 3, nothing, 0x0, nothing, [child])
    d = Positron.profile_frame_to_dict(parent)
    @test d["func"] == "root"
    @test d["count"] == 3
    @test length(d["children"]) == 1
    @test d["children"][1]["func"] == "inner"
    @test d["children"][1]["countLabel"] == "3 samples"
    @test d["children"][1]["flags"] == 2
end

@testset "build_profile_tree empty data" begin
    @test Positron.build_profile_tree(UInt64[]) === nothing
end

@testset "build_profile_tree on real samples" begin
    Profile.init(n = 10^6, delay = 0.0001)
    Profile.clear()
    @profile for i = 1:200_000
        sin(i)
    end

    data = Profile.fetch()
    if isempty(data)
        @info "Skipping build_profile_tree test, profile returned no samples"
        return
    end

    tree = Positron.build_profile_tree(data)
    @test tree !== nothing
    @test haskey(tree, Positron.PROFILE_ALL_THREADS_NAME)
    root = tree[Positron.PROFILE_ALL_THREADS_NAME]
    @test root isa Positron.ProfileFrame
    @test root.count >= 0

    # Roundtrip through IJulia's JSON encoder to ensure no struct sneaks through.
    payload = Dict{String,Any}(
        "trace" => Dict{String,Any}(k => Positron.profile_frame_to_dict(v) for (k, v) in tree),
        "type" => "Thread",
    )
    encoded = IJulia.JSONX.json(payload)
    @test encoded isa String
    @test length(encoded) > 0
end

@testset "ProfilerService init" begin
    kernel = Positron.get_kernel()
    @test kernel.profiler isa Positron.ProfilerService
    # init! should not throw for a fresh service.
    Positron.init!(kernel.profiler)
    @test kernel.profiler.enabled
end
