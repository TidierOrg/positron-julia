# ---------------------------------------------------------------------------------------------
# Copyright (C) 2024-2025 Posit Software, PBC. All rights reserved.
# Licensed under the Elastic License 2.0. See LICENSE.txt for license information.
# ---------------------------------------------------------------------------------------------

import Pkg
import TOML

const _PositronPackage = NamedTuple{
    (:id, :name, :displayName, :version, :attached, :description, :url),
    Tuple{String, String, String, String, Bool, String, String},
}
"""
Canonical ordered list of metadata fields for JSON serialization.
"""
# Keep deterministic field order in JSON output.
const _POSITRON_METADATA_FIELDS = ("latestVersion", "license", "description", "url")
"""
Map of package name to its metadata field dictionary.
"""
const _MetadataByName = Dict{String, Dict{String, String}}
const _POSITRON_PROJECT_METADATA_BY_PATH = Dict{String, Tuple{String, String, String}}()
const _POSITRON_DESCRIPTION_BY_PATH = Dict{String, String}()
const _POSITRON_REGISTRY_URL_BY_NAME = Dict{String, String}()

function _positron_json_string(value::AbstractString)::String
    return "\"" * escape_string(value) * "\""
end

"""
Safely convert a value to a String, or return an empty string for non-strings.
"""
function _positron_string_or_empty(value)
    return value isa AbstractString ? String(value) : ""
end

function _positron_first_string_field(parsed, keys)::String
    for key in keys
        value = _positron_string_or_empty(get(parsed, key, ""))
        value = strip(value)
        isempty(value) || return value
    end
    return ""
end

function _positron_collapse_whitespace(value::AbstractString)::String
    return strip(replace(value, r"\s+" => " "))
end

function _positron_markdown_text(value::AbstractString)::String
    cleaned = replace(value, r"!\[[^\]]*\]\([^)]+\)" => "")
    cleaned = replace(cleaned, r"\[([^\]]+)\]\([^)]+\)" => s"\1")
    cleaned = replace(cleaned, r"\[([^\]]+)\]\[[^\]]+\]" => s"\1")
    cleaned = replace(cleaned, r"`([^`]+)`" => s"\1")
    return _positron_collapse_whitespace(cleaned)
end

function _positron_skip_readme_line(line::AbstractString)::Bool
    isempty(line) && return true
    startswith(line, "#") && return true
    startswith(line, "[!") && return true
    startswith(line, "![") && return true
    startswith(line, ">") && return true
    startswith(line, "<") && return true
    startswith(line, "|") && return true
    startswith(line, "- ") && return true
    startswith(line, "* ") && return true
    occursin(r"\bDOI\b", line) && return true
    occursin(r"^\[[^\]]+\]:", line) && return true
    occursin(r"^\[[^\]]+\]\([^)]+\)$", line) && return true
    occursin(r"^=+$", line) && return true
    occursin(r"^-+$", line) && return true
    return false
end

function _positron_read_readme_description(package_path::AbstractString, seen::Set{String}=Set{String}())::String
    for filename in ("README.md", "Readme.md", "readme.md", "README", "README.markdown")
        readme_path = joinpath(package_path, filename)
        isfile(readme_path) || continue
        readme_path in seen && continue
        push!(seen, readme_path)

        lines = try
            readlines(readme_path)
        catch
            continue
        end

        paragraph = String[]
        in_fence = false
        for raw in Iterators.take(lines, 160)
            line = strip(raw)
            if startswith(line, "```") || startswith(line, "~~~")
                in_fence = !in_fence
                continue
            end
            in_fence && continue

            if isempty(line)
                isempty(paragraph) || break
                continue
            end

            if isempty(paragraph) && occursin(r"^[A-Za-z0-9_./-]+\.md$", line)
                nested = joinpath(package_path, line)
                if isfile(nested)
                    nested_description = _positron_read_readme_description(dirname(nested), seen)
                    isempty(nested_description) || return nested_description
                end
            end

            if _positron_skip_readme_line(line)
                isempty(paragraph) || break
                continue
            end

            text = _positron_markdown_text(line)
            isempty(text) || push!(paragraph, text)
        end

        description = _positron_collapse_whitespace(join(paragraph, " "))
        isempty(description) || return description
    end
    return ""
end

function _positron_print_json_string_array(values::Vector{String})
    print("[")
    for (index, value) in pairs(values)
        index > 1 && print(",")
        print(_positron_json_string(value))
    end
    print("]")
end

function _positron_print_json_packages(packages)
    print("[")
    for (index, package) in pairs(packages)
        index > 1 && print(",")
        print("{")
        print("\"id\":", _positron_json_string(package.id), ",")
        print("\"name\":", _positron_json_string(package.name), ",")
        print("\"displayName\":", _positron_json_string(package.displayName), ",")
        print("\"version\":", _positron_json_string(package.version), ",")
        print("\"attached\":", package.attached ? "true" : "false")
        if !isempty(package.description)
            print(",\"description\":", _positron_json_string(package.description))
        end
        if !isempty(package.url)
            print(",\"url\":", _positron_json_string(package.url))
        end
        print("}")
    end
    print("]")
end

"""
Read description, license, and URL fields from a package's Project.toml/JuliaProject.toml.
Returns (description, license, url) as strings (empty when unavailable).
"""
function _positron_read_project_metadata(package_path::AbstractString)
    return get!(_POSITRON_PROJECT_METADATA_BY_PATH, String(package_path)) do
        for filename in ("Project.toml", "JuliaProject.toml")
            project_path = joinpath(package_path, filename)
            isfile(project_path) || continue
            parsed = try
                TOML.parsefile(project_path)
            catch err
                @debug "Failed to parse package metadata TOML" path=project_path exception=err
                continue
            end
            description = _positron_string_or_empty(get(parsed, "description", ""))
            license = _positron_string_or_empty(get(parsed, "license", ""))
            url = _positron_first_string_field(parsed, (
                "homepage",
                "home",
                "website",
                "url",
                "repository",
                "repo",
                "source",
                "documentation",
                "docs",
                "doc",
            ))
            return description, license, url
        end
        return "", "", ""
    end
end

function _positron_read_package_description(package_path)
    package_path isa AbstractString || return ""
    isempty(package_path) && return ""
    return get!(_POSITRON_DESCRIPTION_BY_PATH, package_path) do
        description, _, _ = _positron_read_project_metadata(package_path)
        isempty(description) ? _positron_read_readme_description(package_path) : description
    end
end

function _positron_read_project_url(package_path)
    package_path isa AbstractString || return ""
    isempty(package_path) && return ""
    _, _, url = _positron_read_project_metadata(package_path)
    return url
end

function _positron_package_source_path(package_info)::String
    for field in (:path, :source)
        hasproperty(package_info, field) || continue
        value = getproperty(package_info, field)
        if value isa AbstractString && !isempty(value)
            return String(value)
        end
    end
    return ""
end

function _positron_package_source_url(package_info)::String
    hasproperty(package_info, :git_source) || return ""
    value = getproperty(package_info, :git_source)
    return value isa AbstractString ? String(value) : ""
end

function _positron_registry_entry_url(entry)::String
    info = try
        Pkg.Registry.registry_info(entry)
    catch
        return ""
    end
    isdefined(info, :repo) || return ""
    return _positron_string_or_empty(getproperty(info, :repo))
end

function _positron_registry_package_url(package_name::AbstractString)::String
    target = lowercase(strip(String(package_name)))
    isempty(target) && return ""

    return get!(_POSITRON_REGISTRY_URL_BY_NAME, target) do
        for registry in Pkg.Registry.reachable_registries()
            for entry in values(registry.pkgs)
                lowercase(entry.name) == target || continue
                url = _positron_registry_entry_url(entry)
                isempty(url) || return url
            end
        end
        return ""
    end
end

function _positron_package_url(package_info)::String
    package_path = _positron_package_source_path(package_info)
    url = _positron_read_project_url(package_path)
    isempty(url) || return url

    url = _positron_package_source_url(package_info)
    isempty(url) || return url

    return _positron_registry_package_url(package_info.name)
end

function _positron_explicitly_loaded_names()
    # Modules explicitly `using`-ed into Main (excludes transitive deps).
    # Wrapped in try-catch since module_usings is an internal API.
    loaded = try
        Set{String}(
            string(nameof(m))
            for m in Base.module_usings(Main)
            if m !== Base && m !== Core
        )
    catch
        Set{String}()
    end

    # Modules explicitly `import`-ed (bound by name in Main, not via using).
    for sym in names(Main; imported=true)
        isdefined(Main, sym) || continue
        val = try; getfield(Main, sym); catch; continue; end
        val isa Module || continue
        val === Main && continue
        val === Base && continue
        val === Core && continue
        push!(loaded, string(sym))
    end

    return loaded
end

function _positron_list_packages(direct_only::Bool=true)
    explicitly_loaded = _positron_explicitly_loaded_names()
    packages = _PositronPackage[]
    for package_info in values(Pkg.dependencies())
        if direct_only && !package_info.is_direct_dep
            continue
        end
        name = package_info.name
        version = string(package_info.version)
        description = _positron_read_package_description(_positron_package_source_path(package_info))
        url = _positron_package_url(package_info)
        push!(packages, (
            id = "$(name)-$(version)",
            name = name,
            displayName = name,
            version = version,
            attached = name in explicitly_loaded,
            description = description,
            url = url,
        ))
    end
    sort!(packages, by = package -> lowercase(package.name))
    _positron_print_json_packages(packages)
end

function _positron_install_packages(specs::Vector{String})
    package_specs = Pkg.PackageSpec[]
    for spec in specs
        pieces = split(spec, "@"; limit=2)
        name = String(strip(pieces[1]))
        isempty(name) && continue
        if length(pieces) == 2 && !isempty(strip(pieces[2]))
            push!(package_specs, Pkg.PackageSpec(name=name, version=String(strip(pieces[2]))))
        else
            push!(package_specs, Pkg.PackageSpec(name=name))
        end
    end
    isempty(package_specs) || Pkg.add(package_specs)
    return nothing
end

function _positron_uninstall_packages(names::Vector{String})
    cleaned = filter(name -> !isempty(strip(name)), strip.(names))
    isempty(cleaned) || Pkg.rm(cleaned)
    return nothing
end

function _positron_update_packages(names::Vector{String})
    cleaned = filter(name -> !isempty(strip(name)), strip.(names))
    isempty(cleaned) || Pkg.update(cleaned)
    return nothing
end

function _positron_update_all_packages()
    Pkg.update()
    return nothing
end

function _positron_latest_registry_version(entry)
    info = Pkg.Registry.registry_info(entry)
    isempty(info.version_info) && return "0"
    return string(maximum(keys(info.version_info)))
end

function _positron_search_packages(query::String)
    query = lowercase(strip(query))
    if isempty(query)
        _positron_print_json_packages(_PositronPackage[])
        return
    end

    by_name = Dict{String, String}()
    by_url = Dict{String, String}()

    for registry in Pkg.Registry.reachable_registries()
        for entry in values(registry.pkgs)
            package_name = entry.name
            occursin(query, lowercase(package_name)) || continue

            version = try
                _positron_latest_registry_version(entry)
            catch
                "0"
            end

            previous = get(by_name, package_name, nothing)
            if previous === nothing
                by_name[package_name] = version
            elseif previous != version
                try
                    if previous == "0" || VersionNumber(version) > VersionNumber(previous)
                        by_name[package_name] = version
                    end
                catch
                    # Keep the existing version if parsing fails.
                end
            end

            url = get(by_url, package_name, "")
            if isempty(url)
                url = _positron_registry_entry_url(entry)
                if !isempty(url)
                    by_url[package_name] = url
                    _POSITRON_REGISTRY_URL_BY_NAME[lowercase(package_name)] = url
                end
            end
        end
    end

    packages = _PositronPackage[]
    for (name, version) in by_name
        push!(packages, (
            id = "$(name)-$(version)",
            name = name,
            displayName = name,
            version = version,
            attached = false,
            description = "",
            url = get(by_url, name, ""),
        ))
    end
    sort!(packages, by = package -> lowercase(package.name))
    _positron_print_json_packages(packages)
end

function _positron_print_json_metadata(by_name::_MetadataByName)
    print("{")
    first = true
    for (name, fields) in by_name
        first || print(",")
        first = false
        print(_positron_json_string(lowercase(name)), ":{")
        inner_first = true
        for key in _POSITRON_METADATA_FIELDS
            value = get(fields, key, nothing)
            value === nothing && continue
            inner_first || print(",")
            inner_first = false
            print(_positron_json_string(key), ":", _positron_json_string(value))
        end
        print("}")
    end
    print("}")
end

function _positron_package_metadata(names::Vector{String})
    # Match registry entries case-insensitively so callers can pass either
    # canonical (`Revise`) or lower-cased (`revise`) package names.
    targets = Set{String}()
    for raw in names
        cleaned = strip(raw)
        isempty(cleaned) || push!(targets, lowercase(String(cleaned)))
    end
    by_name = _MetadataByName()

    if isempty(targets)
        _positron_print_json_metadata(by_name)
        return
    end

    for registry in Pkg.Registry.reachable_registries()
        for entry in values(registry.pkgs)
            lowercase(entry.name) in targets || continue

            version = try
                _positron_latest_registry_version(entry)
            catch
                "0"
            end

            fields = get!(by_name, entry.name, Dict{String,String}())
            previous = get(fields, "latestVersion", nothing)
            if previous === nothing
                fields["latestVersion"] = version
            elseif previous != version
                try
                    if previous == "0" || VersionNumber(version) > VersionNumber(previous)
                        fields["latestVersion"] = version
                    end
                catch
                    # Keep the existing version if parsing fails.
                end
            end

            url = _positron_registry_entry_url(entry)
            if !isempty(url)
                fields["url"] = url
                _POSITRON_REGISTRY_URL_BY_NAME[lowercase(entry.name)] = url
            end
        end
    end

    for package_info in values(Pkg.dependencies())
        package_name = package_info.name
        lowercase(package_name) in targets || continue
        package_path = _positron_package_source_path(package_info)
        if !isempty(package_path)
            description, license, url = _positron_read_project_metadata(package_path)
            isempty(description) && (description = _positron_read_package_description(package_path))
            isempty(url) && (url = _positron_package_source_url(package_info))
            isempty(url) && (url = _positron_registry_package_url(package_name))
            if !isempty(description) || !isempty(license) || !isempty(url)
                fields = get!(by_name, package_name, Dict{String,String}())
                isempty(description) || (fields["description"] = description)
                isempty(license) || (fields["license"] = license)
                isempty(url) || (fields["url"] = url)
            end
        end
    end

    _positron_print_json_metadata(by_name)
end

function _positron_search_package_versions(name::String)
    target = lowercase(strip(name))
    versions = Set{VersionNumber}()

    if isempty(target)
        _positron_print_json_string_array(String[])
        return
    end

    for registry in Pkg.Registry.reachable_registries()
        for entry in values(registry.pkgs)
            lowercase(entry.name) == target || continue
            info = try
                Pkg.Registry.registry_info(entry)
            catch
                continue
            end
            union!(versions, keys(info.version_info))
        end
    end

    sorted_versions = sort!(collect(versions); rev=true)
    _positron_print_json_string_array(string.(sorted_versions))
end
