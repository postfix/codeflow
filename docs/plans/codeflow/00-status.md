# Status: Codeflow

- Gate 1 — Product: APPROVED 2026-09-11
- Gate 2 — Architecture: APPROVED 2026-09-11
- Gate 3 — Program Design: APPROVED 2026-09-11
- Gate 4 — Slice plan: APPROVED 2026-09-15

## Factory settings

- presentation: auto

## Loop signal

{"generation":14,"boundary":{"kind":"slice","number":6},"reopened":false,"history":[{"from":"code-review","reason":"complete","to":"security"},{"from":"security","reason":"complete","to":"qa"},{"from":"hand","reason":"rework","to":"red-team"},{"from":"hand","reason":"complete","to":"hand"},{"from":"hand","reason":"start","to":"engineering"},{"from":"engineering","reason":"complete","to":"direct-witness"},{"from":"direct-witness","reason":"complete","to":"qa"},{"from":"qa","reason":"retry","to":"qa"},{"from":"qa","reason":"failed","to":"engineering"},{"from":"engineering","reason":"rework","to":"direct-witness"},{"from":"direct-witness","reason":"retry","to":"qa"},{"from":"qa","reason":"complete","to":"code-review"},{"from":"code-review","reason":"retry","to":"code-review"},{"from":"code-review","reason":"retry","to":"code-review"},{"from":"code-review","reason":"complete","to":"qa"},{"from":"qa","reason":"complete","to":"qa"},{"from":"qa","reason":"unknown","to":"direct-witness"},{"from":"direct-witness","reason":"failed","to":"sf-impact"},{"from":"sf-impact","to":"engineering","reason":"complete"},{"from":"engineering","to":"direct-witness","reason":"complete"},{"from":"direct-witness","to":"qa","reason":"complete"},{"from":"qa","to":"engineering","reason":"failed"},{"from":"engineering","to":"direct-witness","reason":"complete"},{"from":"direct-witness","to":"qa","reason":"complete"},{"from":"qa","to":"code-review","reason":"complete"},{"from":"code-review","to":"sf-protocol-check","reason":"complete"},{"from":"sf-protocol-check","to":"engineering","reason":"failed"},{"from":"engineering","to":"direct-witness","reason":"complete"},{"from":"direct-witness","to":"sf-protocol-check","reason":"complete"},{"from":"sf-protocol-check","to":"qa","reason":"complete"},{"from":"qa","to":"engineering","reason":"failed"},{"from":"engineering","to":"direct-witness","reason":"complete"},{"from":"direct-witness","to":"qa","reason":"complete"},{"from":"qa","to":"code-review","reason":"complete"},{"from":"code-review","to":"sf-protocol-check","reason":"complete"},{"from":"sf-protocol-check","to":"hand","reason":"complete"}]}

## Slices

- [x] Slice 1 — native Codex subscription feasibility
  - proof: native Codex CLI 0.154.0 reported ChatGPT login and completed a nested structured turn through chatgpt-subscription with no API fallback -> feasibility confirmed; reviews: adversarial=not-applicable-user-removed-synthetic-tracer, code-review=not-applicable-user-removed-synthetic-tracer, security=not-applicable-user-removed-synthetic-tracer, qa=not-applicable-user-removed-synthetic-tracer
- [x] Slice 2 — minimal durable pure-flow success
  - proof: Node v24.19.0 `npm run typecheck` and `npm test -- --run tests/execution-replay.test.ts -t "minimal durable pure flow"` -> exit 0; full source suite 10/10; durable startup, detached lock ownership, fresh-handle verified output, corruption rejection, path confinement, and artifact integrity verified; reviews: adversarial=PASS-after-fix, code-review=CLEAN-after-fix, security=UNKNOWN-no-current-defect-tooling-limited, qa=VERIFIED
- [x] Slice 3 — initialization-resume and public contracts
  - proof: Node v24.19.0 `npm run typecheck` and `npm test -- --run tests/contracts.test.ts tests/execution-replay.test.ts -t "initialization and contract"` -> exit 0, 6 selected tests; full suite 21/21; public positive/negative types, pre-author contract rejection, pinned fresh-process resume, cumulative charges, legal journal replay, and partial-failure integrity verified; reviews: adversarial=PASS-after-fixes, code-review=CLEAN-after-fixes, security=UNKNOWN-no-current-defect-tooling-limited, qa=VERIFIED
- [x] Slice 4 — durable evidence and workspace freshness
  - proof: witness -> PASS; artifact-before-event analyzer unsafe=1 safe=0 product=0 with non-vacuous complete traces; Node v24.19.0 typecheck and focused storage/workspace 23/23; full suite 48/48; prompt collision/bounds and linear 50k/100k/200k NUL scaling verified; lock mode 0600 and no-follow symlink rejection verified; reviews: adversarial=PASS-after-fixes, code-review=SHIP-after-fixes, security=UNKNOWN-no-current-defect-tooling-and-worker-cap-limited, qa=VERIFIED-self-review-worker-cap
- [x] Slice 5 — owned command effect
  - proof: witness -> PASS; authorization-before-execution and cleanup-before-commit analyzers unsafe=1 safe=0 product=0 with complete non-vacuous traces; Node v24.19.0 typecheck, focused ownership/process 22/22, full suite 70/70; real production startFlow command effect exactly once with literal argv, durable claim/authorization/outcome, bounded writer-free evidence, and group absence; live-wait and retained/discarded-command races verified; reviews: adversarial=PASS-after-fixes, code-review=SHIP-after-fixes, security=CLEAR-local-process-authority-after-fixes, qa=VERIFIED
- [ ] Slice 6 — per-target foundation qualification
- [ ] Slice 7 — replay frontier and cumulative admission
- [ ] Slice 8 — complete author primitives
- [ ] Slice 9 — human consent and unknown-effect recovery
- [ ] Slice 10 — native adapters and lifecycle CLI
- [ ] Slice 11 — live both-host acceptance
- [ ] Slice 12 — final qualification and publication

## Notes for a fresh session

The user asked to implement the product defined by `SPEC.md`. Repository onboarding is recorded in `docs/codebase-overview.md`. Gates 1–4 are approved; Gate 4 was re-approved on 2026-09-15 with WSL2 on its Linux filesystem included in the Linux runtime class and macOS qualification assigned to GitHub Actions.

Slices 1–5 are complete. Slice 6 is active and intentionally unchecked.

Current QA-clean Slice 6 macOS correction subject: `src/artifacts.ts=3f367ed5a82d602e7416d1802c696e46516feed7c856c5722f394473ee2e5c05`, `src/process.ts=93c0a848e49bf986ae666b96d20f4e172132cb1be8270b604dee391c8cecc8f3`, `src/testing.ts=f9f4721e236462cfce03e9af58861d3f353026d310be3350ff7acdc165ca79ae`, `tests/storage.test.ts=f6d7f6cde776cacb096aa92f4fd6da9445688abb24b805be4099195f44b0d3ea`, `tests/qualification.test.ts=e0da4ff355b691b6ea1b85e15161a7ece6ed7afbcdcdc921b2a1a9328216157d`, `.github/workflows/macos-foundation.yml=02621920d7d5d277d16aecfb53c90bdce8a3f3ed64ebb545ab769659c4b45964`. Node v24.19.0 typecheck PASS; focused suite 46/46; full suite 87/87. Fresh adversarial functional QA PASS after closing the fallback hard-kill bypass; Code Review SHIP; local functional process-authority review CLEAR. No cybersecurity review is part of this Slice 6 correction.

The previously recorded Linux process-interrupt and prepared reboot evidence bind an older foundation hash and are no longer valid after these source/workflow changes. Do not resume or claim those records. Regenerate both Linux witnesses on the exact current subject; the old files may be preserved under `/tmp` for diagnosis.

Next operational steps: commit and push the exact QA-clean subject; obtain a passing `macos-foundation` GitHub Actions artifact for that commit; regenerate and pass the Linux process-interrupt witness; prepare the Linux reboot witness, reboot this authorized disposable Linux machine, then resume and verify. Do not mark Slice 6 complete or start Slice 7 until both platform witnesses and final QA verification pass.
