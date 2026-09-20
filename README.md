# codeflow

A local TypeScript workflow engine for Codex and Claude Code. Flow logic stays in ordinary TypeScript; provider calls use the official native CLIs and the user's existing subscription login. Codeflow does not accept API keys or copy provider credentials.

## Setup

Use Node 24, install dependencies, and build from source. `fs-ext` needs the platform's native build prerequisites when a prebuilt artifact is unavailable; Codeflow never downloads or builds native code at runtime. Sign in with each provider's official command, then verify the exact supported CLI and subscription route:

```sh
npm ci
npm run build
codex login
claude auth login
node dist/src/cli.js doctor --provider codex
node dist/src/cli.js doctor --provider claude
```

An unavailable addon, binary, qualified version, explicit model, or recognized subscription route is a setup failure. There is no API-key, account, model, or billing fallback.

## Run a flow

```sh
node dist/src/cli.js run ./review.ts --provider codex --model gpt-5.6-codex --input input.json
node dist/src/cli.js list
node dist/src/cli.js status RUN_ID --wait-ms 30000
node dist/src/cli.js resume RUN_ID
node dist/src/cli.js respond RUN_ID --input reply.json
```

Use `--allow-edits` only when the flow's agents need native write tools. Commands remain trusted author code with normal OS permissions. All CLI output is one JSON document; diagnostics use stderr. Add `.coding-flow/` to Git ignores because it contains private local prompts, outputs, journals, and recovery evidence.

`status` and `list` reconnect without starting work. Use `resume` only for the intended interrupted run. A waiting request must be displayed with its evidence and answered by the person; never infer approval. For unknown effects, use `recovery` and only an offered action. Never repeat the flow to simulate recovery.

Native model evidence is pinned to Codex 0.154.0's `exec --json` thread plus its matching, newly created local session record, or Claude 2.1.274's `stream-json --verbose` root assistant records. Codeflow retains bounded native output and a minimal Codex session projection as private, immutable run artifacts and verifies them again on recovery. Missing, ambiguous, or changed evidence leaves the effect unresolved; it never substitutes the requested model or reads native session history during replay. Native authentication and permission settings are unchanged.

## Skill wrappers

```sh
node dist/src/cli.js install ./review.ts --host codex
node dist/src/cli.js install ./review.ts --host claude
```

Installation creates a thin project-local `SKILL.md` and `launch.mjs`, refuses collisions, and leaves the flow and ignore files unchanged. Both wrappers call the same lifecycle CLI; they do not copy workflow logic.

## Support boundary

Supported targets are Linux, macOS, and WSL2 workspaces on qualified local filesystems. WSL workspaces must live on the Linux filesystem. Native Windows, network or cloud-synchronized filesystems, cross-machine recovery, parallel external operations, automatic rollback, and provider conversation restoration are outside v2. Native host restrictions remain authoritative; a host that refuses nested execution is unsupported rather than bypassed.

Terminal runs are retained until explicitly selected with `node dist/src/cli.js prune RUN_ID...`. Active, interrupted, blocked, or waiting runs cannot be pruned. Back up only a quiescent complete run; copied live state is not valid recovery evidence.

## Linux host acceptance

Use Node **24.19.0**, Codex **0.154.0**, and the explicit Claude **2.1.274** binary. A newer default Claude binary is not interchangeable. Run the fixture in a disposable Linux-native workspace through each installed host wrapper. Native subscription authentication, host nesting restrictions, and real human answers remain required. If an inherited API-key selector conflicts, stop and choose an explicitly subscription-only launch environment; never retry silently with another account or route.

Copy `tests/fixtures/host-flow.ts` into the disposable workspace, replacing only its SDK import with the absolute built `dist/src/sdk.js` path. Install that copy for each host with the built CLI. Use input `{"message":"acceptance","delayMs":0,"acceptance":true}` and an explicit model whose identity the native provider structurally reports. The fixture preserves its earlier pure-flow mode when `acceptance` is absent.

1. Invoke the installed `launch.mjs` in the signed-in native host. Display revision 1 and wait for the person to reject it. Display revision 2 and wait for the person to approve it. The fixture writes `acceptance-effect.txt` exactly once and then asks for `"continue"`.
2. For the happy-path run, retain a journal receipt before closing the host context and another after reconnecting through the same wrapper. Each receipt is `RUN_ID:SEQUENCE:EVENT_HASH` naming a real event in that run; the later sequence must be greater. Context closure itself remains explicitly operator-asserted. Answer the checkpoint with the person's `"continue"` reply.
3. Start a distinct interrupted-recovery run with the same input and limits. Perform the person's rejection and approval again. At its final checkpoint, interrupt only its supervisor process, reconnect, explicitly resume that same run through the wrapper, then answer `"continue"`. No machine restart is involved.
4. Start a third run with `delayMs:60000` and cancel it through the wrapper. Wait for terminal cancellation.
5. Obtain the current fixture hashes from `liveAcceptanceSubject()` in `dist/src/testing.js`. Save a local JSON manifest under the disposable workspace's `.coding-flow-qualification/`:

```json
{
  "version": 1,
  "target": "linux-local",
  "provider": "claude",
  "fixtureSha256": "CURRENT_FIXTURE_HASH",
  "fixtureSetSha256": "CURRENT_FIXTURE_SET_HASH",
  "runs": {
    "happyPath": "HAPPY_RUN_ID",
    "interruptedRecovery": "RECOVERY_RUN_ID",
    "cancellation": "CANCELLED_RUN_ID"
  },
  "hostSteps": {
    "provenance": "operator-asserted",
    "firstInvocationReceipt": "RUN_ID:SEQUENCE:EVENT_HASH",
    "reconnectedInvocationReceipt": "RUN_ID:LATER_SEQUENCE:LATER_EVENT_HASH",
    "contextClosedAndReopened": true
  }
}
```

From the repository root, verify each provider separately:

```sh
npm run test:host-acceptance -- --target linux-local --provider claude --workspace /absolute/disposable/workspace --manifest .coding-flow-qualification/input.json --result .coding-flow-qualification/claude-live.json
```

Use `--provider codex` and its own workspace, run IDs, and manifest for Codex. Verification rejects missing, mismatched, stale, duplicate, cross-attempt, uncommitted, or conflicting evidence and never replaces an existing result. Keep these private local run stores and manifests until qualification review finishes. Raw provider output can contain private account/session data; observation records retain only sanitized identity fields and a domain-separated session digest.

The result labels structural auth/permission cases as fixture evidence. Codex post-authorization failures and Claude auth/quota failures remain conservative unknown outcomes; message wording cannot identify them. A live result alone makes no filesystem support claim: join it to freshly verified foundation evidence for the final source subject. The macOS workflow runs adapter/install fixtures on the exact commit, with no interactive native-login claim.
