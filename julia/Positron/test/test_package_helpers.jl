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
            stdlib = false,
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

    @testset "Project Author Parsing" begin
        empty!(_POSITRON_PROJECT_AUTHOR_BY_PATH)

        mktempdir() do package_dir
            write(
                joinpath(package_dir, "Project.toml"),
                """
                name = "Example"
                uuid = "22222222-2222-2222-2222-222222222222"
                version = "1.0.0"
                authors = ["Jane Doe <jane@example.com>", "contributors: https://example.com/contributors"]
                """,
            )

            @test _positron_read_project_author(package_dir) == "Jane Doe"
        end

        empty!(_POSITRON_PROJECT_AUTHOR_BY_PATH)

        mktempdir() do package_dir
            write(
                joinpath(package_dir, "Project.toml"),
                """
                name = "NoAuthors"
                uuid = "33333333-3333-3333-3333-333333333333"
                version = "1.0.0"
                """,
            )

            @test _positron_read_project_author(package_dir) == ""
        end
    end

    @testset "Package Detail" begin
        json = _capture_package_helper_stdout() do
            _positron_package_detail("JSON3")
        end

        parsed = JSON3.read(json, Dict{String, Any})
        @test parsed["name"] == "JSON3"
        @test haskey(parsed, "version")
        @test occursin(r"^\d+\.\d+", parsed["version"])
        @test parsed["sourceRepository"] == "General"
        # No license in JSON3's Project.toml; detected from its LICENSE.md.
        @test parsed["license"] == "MIT"
        @test occursin("Jacob Quinn", parsed["author"])
        # Direct deps excluding stdlibs (Parsers, PrecompileTools, ...).
        @test parsed["dependencyCount"] isa Number
        @test parsed["dependencyCount"] >= 1
        @test !haskey(parsed, "stdlib")

        missing_json = _capture_package_helper_stdout() do
            _positron_package_detail("ThisPackageDoesNotExist12345")
        end
        @test strip(missing_json) == "null"
    end

    @testset "Package Detail Stdlib" begin
        # Dates is a standard library and a dependency of Positron.jl, so it
        # is visible in Pkg.dependencies() for the test environment.
        json = _capture_package_helper_stdout() do
            _positron_package_detail("Dates")
        end

        parsed = JSON3.read(json, Dict{String, Any})
        @test parsed["name"] == "Dates"
        @test parsed["stdlib"] === true
        @test parsed["license"] == "MIT"
        @test parsed["sourceRepository"] == "Julia standard library"
        @test startswith(parsed["url"], "https://docs.julialang.org/")
        # The one-line title comes from the stdlib's docs/src/index.md.
        @test haskey(parsed, "title")
        @test occursin("Dates", parsed["title"])
    end

    @testset "License Detection" begin
        @test _positron_detect_license_text("MIT License\nCopyright (c)") == "MIT"
        @test _positron_detect_license_text(
            "The X.jl package is licensed under the MIT \"Expat\" License",
        ) == "MIT"
        @test _positron_detect_license_text(
            "Apache License\nVersion 2.0, January 2004",
        ) == "Apache-2.0"
        @test _positron_detect_license_text(
            "GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007",
        ) == "GPL-3.0"
        @test _positron_detect_license_text("Some proprietary text") == ""

        empty!(_POSITRON_LICENSE_BY_PATH)
        mktempdir() do package_dir
            write(
                joinpath(package_dir, "LICENSE.md"),
                "The Example.jl package is licensed under the MIT License.\n",
            )
            @test _positron_read_license_file(package_dir) == "MIT"
        end

        empty!(_POSITRON_LICENSE_BY_PATH)
        mktempdir() do package_dir
            @test _positron_read_license_file(package_dir) == ""
        end
    end

    @testset "Missing Packages Detection" begin
        read_missing = function (names)
            json = _capture_package_helper_stdout() do
                _positron_missing_packages(names)
            end
            return JSON3.read(json, Vector{String})
        end

        # Installed in the test environment -> not missing.
        @test read_missing(["JSON3"]) == String[]

        # Stdlib: loadable without being a project dependency -> not missing.
        @test read_missing(["LinearAlgebra"]) == String[]

        # Not in any registry -> never offered, even though not installed.
        @test read_missing(["ThisPackageDoesNotExist12345"]) == String[]

        # Registered in General but not installed in the test project ->
        # missing and installable. `Example` is the canonical minimal
        # registered package and is not a dependency of Positron.jl.
        @test read_missing(["Example"]) == ["Example"]

        # Mixed list keeps only the missing installable subset.
        @test read_missing([
            "JSON3",
            "LinearAlgebra",
            "Example",
            "ThisPackageDoesNotExist12345",
            "",
        ]) == ["Example"]
    end
end
