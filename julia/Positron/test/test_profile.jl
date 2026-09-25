# ---------------------------------------------------------------------------------------------
# Copyright (C) 2026 Posit Software, PBC. All rights reserved.
# Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
# ---------------------------------------------------------------------------------------------

using Test
using JSON3
using Profile

profile_workload(n) = sum(sqrt(i) for i in 1:n)

# The result is kept so the compiler cannot drop the work as dead code, which
# would leave the profiler with no samples.
const PROFILE_SINK = Ref(0.0)
function profile_loop(iterations)
    for _ in 1:iterations
        PROFILE_SINK[] += profile_workload(10^6)
    end
end

"""Sum of the leaf counts under `node`."""
leaf_count(node) = isempty(node["children"]) ? node["count"] : sum(leaf_count, node["children"])

function each_frame(f, node)
    f(node)
    foreach(child -> each_frame(f, child), node["children"])
end

@testset "Profiler" begin
    profile_loop(1)  # compile outside the profile
    Profile.clear()
    @profile profile_loop(400)
    trees = Positron.profile_trees()

    @testset "one tree per thread plus all threads" begin
        @test trees !== nothing
        @test haskey(trees, Positron.ALL_THREADS_NAME)
        @test length(trees) == 1 + Threads.nthreads(:interactive) + Threads.nthreads(:default)
    end

    all_threads = trees[Positron.ALL_THREADS_NAME]

    @testset "frames have the viewer's fields" begin
        each_frame(all_threads) do frame
            @test Set(keys(frame)) == Set(["func", "file", "path", "line", "count", "flags", "children"])
            @test frame["count"] >= 0
        end
        @test all_threads["func"] == "root"
        @test all_threads["count"] > 0
    end

    @testset "counts are consistent" begin
        # Every sample ends in a leaf, so leaves never exceed the root.
        @test 0 < leaf_count(all_threads) <= all_threads["count"]
        each_frame(all_threads) do frame
            isempty(frame["children"]) || @test sum(c -> c["count"], frame["children"]) <= frame["count"]
        end
    end

    @testset "the profiled function appears, with its source file" begin
        found = Ref(false)
        each_frame(all_threads) do frame
            if frame["func"] == "profile_workload"
                found[] = true
                @test isabspath(frame["path"])
                @test endswith(frame["path"], "test_profile.jl")
            end
        end
        @test found[]
    end

    @testset "C frames are hidden unless requested" begin
        has_c(tree) = (c = Ref(false); each_frame(n -> c[] |= endswith(n["file"], ".c"), tree); c[])
        @test !has_c(all_threads)
        with_c = Positron.profile_trees(; C = true)[Positron.ALL_THREADS_NAME]
        @test with_c["count"] == all_threads["count"]
    end

    @testset "serializes to JSON" begin
        payload = Dict("data" => trees, "type" => "Thread")
        @test JSON3.read(JSON3.write(payload))["type"] == "Thread"
    end

    @testset "an empty buffer yields nothing" begin
        @test Positron.profile_trees(UInt64[], Dict()) === nothing
    end

    @testset "@profview is exported, accepts C, and reports a failed send" begin
        @test Symbol("@profview") in names(Positron)
        # Outside a Positron kernel there is no frontend to send to: the
        # profile is still collected (and `C` accepted), then a warning.
        @test_logs (:warn, r"Could not send the profile to Positron") match_mode = :any begin
            Positron.@profview profile_loop(400) C = true
        end
        @test !isempty(Profile.fetch())
    end
end
