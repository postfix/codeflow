# Codebase overview

## Purpose

Codeflow is specified as a local, durable TypeScript workflow engine for Codex and Claude Code. A flow keeps ordinary control flow in TypeScript, delegates semantic work to native coding agents, validates structured results, presents evidence before human decisions, and resumes without replaying committed effects. [manual: `README.md`; `SPEC.md:1-31`]

This repository is currently a specification repository, not an implementation: the tracked tree contains the readme, the normative production specification, and the license, but no source, package manifest, lockfile, configuration, or tests. [manual: `git ls-files`; `SPEC.md:5-7`]

## Start here

1. Read `README.md` for the six-line product summary.
2. Treat `SPEC.md` as the normative source: `MUST` and `MUST NOT` are acceptance requirements, while its TypeScript declarations are interfaces to implement rather than existing exports (`SPEC.md:1-7`).
3. Use the required vertical implementation order in `SPEC.md:992-1004`; the first step is the native-host feasibility spike, before building the engine.
4. Use `SPEC.md:1006-1024` as the release bar. Do not claim a provider, platform, or version is supported before that exact combination is qualified.

There is no production entry point to inspect or run yet. [structural: SMTC entry-point analysis found no analyzable source files]

## Shape

The current tracked shape is flat and prose-only: `README.md`, `SPEC.md`, and `LICENSE`. [manual: `git ls-files`]

`SPEC.md:879-902` proposes one future Node package with public surfaces in `sdk.ts` and `host.ts`, a CLI, and small internal modules for build/worker/supervisor, process ownership, journal/artifacts, replay/workspace evidence, human recovery, contracts, provider adapters, installation, and testing. These are planned boundaries, not directories or modules that exist today. [manual]

SMTC cannot provide a repository map, dependency graph, public declarations, or architecture health until analyzable source exists. [structural limitation: zero indexed files/modules]

## Build and test

There are no verified build, test, typecheck, lint, install, or run commands because there is no manifest or implementation. Do not infer ecosystem-standard commands. [manual: tracked-file inventory]

The specification selects Node.js 24 LTS, TypeScript 5.9, Zod 4, esbuild 0.25, `fs-ext` 2.x, Vitest 4, and typescript-eslint (`SPEC.md:33-53`), but exact versions and commands remain future lockfile/package-script decisions. Its required test areas and crash matrix are in `SPEC.md:905-1004`; release qualification is in `SPEC.md:1006-1024`. [manual]

## Conventions

- Normative language in `SPEC.md` controls implementation and acceptance; examples do not certify behavior. [manual: `SPEC.md:1-7`]
- Future TypeScript must be strict ESM/NodeNext with explicit emitted `.js` imports, validated `unknown` at external boundaries, discriminated unions, exhaustive switches, and no casual `any`, non-null assertions, unchecked casts, or silent catches. [manual: `SPEC.md:879-903`]
- Build vertical behavior slices test-first: every slice begins with an observable failing test and ends with it passing. Verify effects from fixture files/process results, not provider prose. [manual: `SPEC.md:905-1004`]
- Reuse the single process manager, journal writer, byte-budget implementation, contract validator, and reply-deduplication path; add abstractions only for demonstrated repetition or an owned invariant. [manual: `SPEC.md:879-903`]

## Invariants

The seven load-bearing requirements are defined at `SPEC.md:18-26`: [manual]

1. Commit and durably persist a primitive outcome before author code receives it.
2. Replay committed outcomes without redispatching their external effects.
3. Treat an unknown outcome as unknown, never as success, failure, or proof of no effect.
4. Start no new effect while ownership, history, workspace freshness, or required consent is unresolved.
5. Recovery preserves original inputs, executable identity, accepted decisions, and cumulative limits.
6. Final success requires validated output, fully consumed history, no pending work, and current workspace evidence.
7. Native permissions and authentication remain authoritative; never extract credentials, fall back to API keys, or bypass restrictions.

Related non-negotiable mechanisms include the stable kernel-backed workspace lock, append-only hash-linked journal, durable artifact-before-event publication, `prepared → registered → authorized → returned → committed` effect protocol, whole-workspace freshness checks, evidence-bound human consent, bounded process groups, and explicit reconciliation of uncertain effects (`SPEC.md:288-575`). [manual]

## Hotspots and landmines

- There is no implemented hotspot yet. The highest-risk planned code is the supervisor/journal commit boundary, process-group ownership and cleanup, replay matching, workspace evidence, consent/reply deduplication, and provider auth/result decoding (`SPEC.md:314-575`, `SPEC.md:694-815`). [manual]
- Do not mistake declaration blocks or the proposed file layout in `SPEC.md` for existing code. [manual: tracked-file inventory]
- A successful schema validation proves shape, not semantic truth; provider prose is not execution evidence (`SPEC.md:27-31`, `SPEC.md:905-946`). [manual]
- A missing outcome after authorization is potentially effectful. It must enter explicit recovery, never automatic retry (`SPEC.md:370-385`, `SPEC.md:556-575`). [manual]
- The target assumes trusted flow code and supported local filesystems; it is not a sandbox, does not cover hostile same-user processes, and excludes native Windows, network/cloud-synced workspaces, cross-machine recovery, parallel external operations, rollback, and history migration (`SPEC.md:27-31`). [manual]

## Unknowns

- The implementation language and stack are selected but not instantiated; package name, scripts, directory layout, exact dependency versions, and lockfile do not yet exist.
- No build, test, typecheck, lint, packaging, installation, provider, crash-recovery, filesystem, or platform command has been run because there is nothing runnable.
- Native Codex/Claude subscription routing, nested execution, structured output, edits, human round-trips, and recovery remain unqualified; the specification explicitly requires the feasibility spike first (`SPEC.md:992-1024`).
- There are no source-derived dependency, caller, entry-point, cycle, layer, or architecture-health findings. Re-run structural onboarding after source is added.

## Evidence freshness

Refreshed 2026-09-11 against Git `6302c9d` on `main`; the pre-edit tracked inventory was exactly `README.md`, `SPEC.md`, and `LICENSE`. [manual: `git status --short --branch`, `git log -5 --oneline --decorate`, `git ls-files`]

SMTC orientation was healthy but partial: the daemon was running and reported full cached analysis families, while the repository snapshot contained zero indexed files. `smtc map` failed with no declarations/call sites; architecture returned zero modules; entry-point analysis was not applicable. Consequently, current repository-shape claims are manual Git/file evidence, and structural claims are limited to the absence of analyzable source. Re-run `smtc orient` after implementation files exist.
