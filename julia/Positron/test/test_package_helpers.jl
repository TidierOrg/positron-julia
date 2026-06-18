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
        empty!(_POSITRON_REGISTRY_LATEST_VERSION_BY_NAME)

        json = _capture_package_helper_stdout() do
            _positron_package_metadata(["JSON3"])
        end

        parsed = JSON3.read(json, Dict{String, Any})
        @test haskey(parsed, "json3")
        @test startswith(parsed["json3"]["url"], "https://")
    end

    @testset "Package Metadata Latest Version" begin
        empty!(_POSITRON_REGISTRY_LATEST_VERSION_BY_NAME)

        json = _capture_package_helper_stdout() do
            _positron_package_metadata(["JSON3"])
        end

        parsed = JSON3.read(json, Dict{String, Any})
        @test haskey(parsed, "json3")
        @test haskey(parsed["json3"], "latestVersion")
        lv = parsed["json3"]["latestVersion"]
        @test !isempty(lv)
        @test lv != "0"
        @test occursin(r"^\d+\.\d+", lv)

        # Populated version must be cached now.
        @test haskey(_POSITRON_REGISTRY_LATEST_VERSION_BY_NAME, "json3")
        @test _POSITRON_REGISTRY_LATEST_VERSION_BY_NAME["json3"] == lv

        # Second call hits the cache and returns the same version.
        json2 = _capture_package_helper_stdout() do
            _positron_package_metadata(["JSON3"])
        end
        parsed2 = JSON3.read(json2, Dict{String, Any})
        @test parsed2["json3"]["latestVersion"] == lv
    end

    @testset "Package Metadata Outdated Flag" begin
        empty!(_POSITRON_REGISTRY_LATEST_VERSION_BY_NAME)

        # JSON3 is installed in the test environment, so metadata should carry
        # the installed version and a precomputed boolean `outdated` flag.
        json = _capture_package_helper_stdout() do
            _positron_package_metadata(["JSON3"])
        end

        parsed = JSON3.read(json, Dict{String, Any})
        @test haskey(parsed["json3"], "version")
        @test haskey(parsed["json3"], "outdated")
        # `outdated` must be a real JSON boolean, not the string "true"/"false".
        @test parsed["json3"]["outdated"] isa Bool
    end

    @testset "Version Outdated Comparison" begin
        @test _positron_version_outdated("1.0.0", "1.0.1")
        @test _positron_version_outdated("1.8.1", "1.8.2")
        @test !_positron_version_outdated("1.0.1", "1.0.0")
        @test !_positron_version_outdated("1.0.0", "1.0.0")
        # Empty or unparseable inputs never report outdated.
        @test !_positron_version_outdated("", "1.0.0")
        @test !_positron_version_outdated("1.0.0", "")
        @test !_positron_version_outdated("not-a-version", "1.0.0")
    end

    @testset "Package Metadata Empty Names" begin
        json = _capture_package_helper_stdout() do
            _positron_package_metadata(String[])
        end
        parsed = JSON3.read(json, Dict{String, Any})
        @test isempty(parsed)
    end
end
