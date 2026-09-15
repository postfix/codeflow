import { z, type FlowDefinition } from "../../src/sdk.js";

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
