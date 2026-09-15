import { flow, z, type Flow } from "../../src/sdk.js";

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
