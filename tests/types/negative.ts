import { z, type FlowDefinition } from "../../src/sdk.js";
import { startFlow, type FlowErrorData, type HumanReply, type RunBoundary, type RunOptions } from "../../src/host.js";

type StructuredRun = FlowDefinition<{ message: string }, { ok: boolean }>["run"];
// @ts-expect-error string is not the declared structured output
const wrongRun: StructuredRun = async () => "wrong";
void wrongRun;

// @ts-expect-error Date is outside the public Json contract
type NonJsonInput = FlowDefinition<Date, string>;

const defaultedInput: FlowDefinition<string, string> = {
  name: "defaulted-input",
  description: "Defaults change supplied values.",
  // @ts-expect-error schema input and output types differ
  input: z.string().default("default"),
  output: z.string(),
  async run({ input }) { return input; },
};
void (undefined as unknown as NonJsonInput);
void defaultedInput;

const primitiveFlow: FlowDefinition<null, string> = {
  name: "invalid-primitives",
  description: "Checks primitive argument types.",
  input: z.null(),
  output: z.string(),
  async run(context) {
    // @ts-expect-error agent names are required
    await context.agent({ prompt: "missing name" });
    // @ts-expect-error stdin must be text
    await context.command("true", [], { stdin: 42 });
    return "unreachable";
  },
};
void primitiveFlow;

// @ts-expect-error runtime selection is part of the normative host request
const missingRuntime: RunOptions = { workspace: "/workspace" };
// @ts-expect-error startFlow requires an explicit runtime selection
startFlow(new URL("file:///workspace/flow.ts"), null, { workspace: "/workspace" }).catch(() => undefined);
// @ts-expect-error decision/value is the removed internal reply shape
const internalReply: HumanReply = { requestId: "0".repeat(64), submissionId: "old", decision: "accept", value: null };
// @ts-expect-error reduced boundaries cannot omit the durable summary
const reducedBoundary: RunBoundary = { runId: "run", status: "running" };
// @ts-expect-error internal historical contract codes cannot cross the public boundary
const impossibleError: FlowErrorData = { code: "CONTRACT_INVALID", message: "impossible" };
void [missingRuntime, internalReply, reducedBoundary, impossibleError];
