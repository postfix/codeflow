import { flow, z, type CommandResult, type Flow } from "../../src/sdk.js";
import type { ErrorCode, FlowErrorData, HumanReply, RunBoundary, RunOptions } from "../../src/host.js";

const inferred = flow({
  name: "typed-flow",
  description: "Infers public input and output.",
  input: z.strictObject({ message: z.string() }),
  output: z.strictObject({ length: z.number().int() }),
  async run({ input }) {
    const message: string = input.message;
    return { length: message.length };
  },
});

const checked: Flow<{ message: string }, { length: number }> = inferred;
void checked;

flow({
  name: "typed-primitives",
  description: "Infers agent and command results.",
  input: z.null(),
  output: z.strictObject({ verdict: z.string(), exitCode: z.number().int() }),
  async run(context) {
    const review = await context.agent({
      name: "reviewer",
      prompt: "review",
      output: z.strictObject({ verdict: z.string() }),
    });
    const command: CommandResult = await context.command("true", [], { cwd: ".", stdin: "", timeoutMs: 1_000 });
    return { verdict: review.verdict, exitCode: command.exitCode };
  },
});

const hostOptions: RunOptions = { workspace: "/workspace", runtime: { provider: "codex" } };
const humanReply: HumanReply = {
  submissionId: "submission-1", requestId: "0".repeat(64), revision: "1".repeat(64),
  presentationHash: "2".repeat(64), answer: { decision: "approve", reason: "" },
};
declare const boundary: RunBoundary;
const attempt: number = boundary.attempt;
const inputError: FlowErrorData = { code: "INVALID_INPUT", message: "input" };
const outputCode: ErrorCode = "INVALID_OUTPUT";
void [hostOptions, humanReply, attempt, inputError, outputCode];
