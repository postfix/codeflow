import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { flow, z } from "../../src/sdk.js";

export default flow({
  name: "minimal-durable-flow",
  description: "A pure host-flow fixture with one observable body effect.",
  input: z.object({ message: z.string(), delayMs: z.number().int().nonnegative() }),
  output: z.object({ echoed: z.string() }),
  async run({ input, workspace }) {
    await new Promise((resolve) => setTimeout(resolve, input.delayMs));
    await appendFile(join(workspace, "body-effects.txt"), `${input.message}\n`, "utf8");
    return { echoed: input.message };
  },
});
