# ---------------------------------------------------------------------------------------------
# Copyright (C) 2026 Posit Software, PBC. All rights reserved.
# Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
# ---------------------------------------------------------------------------------------------

using JSON3
using Test

include(normpath(joinpath(@__DIR__, "..", "..", "..", "scripts", "packages", "packages.jl")))

function _capture_package_helper_stdout(callback)::String
    path = tempname()
    try
        open(path, "w") do io
            redirect_stdout(io) do
                callback()
            end
        end
        return read(path, String)
    finally
        rm(path; force=true)
    end
end

@testset "Package Helper Script" begin
    @testset "Project Metadata URL" begin
        empty!(_POSITRON_PROJECT_METADATA_BY_PATH)

        mktempdir() do package_dir
            write(
                joinpath(package_dir, "Project.toml"),
                """
                name = "Example"
                uuid = "11111111-1111-1111-1111-111111111111"
                version = "1.0.0"
                description = "Example package"
                license = "MIT"
                homepage = "https://example.com/home"
                repository = "https://example.com/repo.git"
                """,
            )

            description, license, url = _positron_read_project_metadata(package_dir)
            @test description == "Example package"
            @test license == "MIT"
            @test url == "https://example.com/home"
        end
    end

    @testset "Registry URL Fallback" begin
        url = _positron_registry_package_url("JSON3")
        @test startswith(url, "https://")
        @test occursin("JSON3", url)
    end

    @testset "Package List JSON URL" begin
        packages = _PositronPackage[(
            id = "Example-1.0.0",
            name = "Example",
            displayName = "Example",
            version = "1.0.0",
            attached = false,
            description = "",
            url = "https://example.com/home",
        )]

        json = _capture_package_helper_stdout() do
            _positron_print_json_packages(packages)
        end

        parsed = JSON3.read(json, Vector{Dict{String, Any}})
        @test parsed[1]["url"] == "https://example.com/home"
    end

    @testset "Package Metadata URL" begin
        json = _capture_package_helper_stdout() do
            _positron_package_metadata(["JSON3"])
        end

        parsed = JSON3.read(json, Dict{String, Any})
        @test haskey(parsed, "json3")
        @test startswith(parsed["json3"]["url"], "https://")
    end
end
