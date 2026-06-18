# Package URL Support From Upstream 14142

## Context

- Upstream Positron PR #14142 adds `LanguageRuntimePackage.url?: string`.
- Positron core owns the Packages pane external-link button and http/https validation.
- This extension owns Julia package discovery, parsing, and local Positron typings.

## Plan

1. Surface URL metadata from `scripts/packages/packages.jl`.
2. Prefer package-local project metadata, then tracked git source, then Julia registry repo.
3. Include URLs in installed package lists, search results, and metadata fetches.
4. Parse `url` in `src/packages.ts`.
5. Add `url?: string` to `typings/positron.d.ts`.
6. Add focused Julia tests for project metadata, registry fallback, and JSON serialization.
7. Run TypeScript compile and Julia package tests.

## Acceptance Criteria

- `getPackages()` may return `url` for installed packages with Julia-known package URLs.
- `searchPackages()` may return `url` for registry-backed package search results.
- `getPackageMetadata()` may return `url` alongside existing fields.
- TypeScript compiles.
- Julia test suite passes.

## Risks

- Julia packages do not consistently publish homepage metadata in `Project.toml`.
- Registry repos are usually source repositories, not homepages, but upstream ranking treats repository URLs as a valid fallback.

## Unresolved Questions

None.
