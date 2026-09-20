import { flow, z } from "../../src/sdk.js";

export default flow({
  name: "minimal-durable-flow",
  description: "A pure host-flow fixture with one observable body effect.",
  input: z.union([
    z.object({ message: z.string(), delayMs: z.number().int().nonnegative(), acceptance: z.literal(true) }).strict(),
    z.object({ message: z.string(), delayMs: z.number().int().nonnegative() }).strict(),
  ]),
  output: z.object({ echoed: z.string() }),
  async run({ input, command, check, agent, human }) {
    await new Promise((resolve) => setTimeout(resolve, input.delayMs));
    if ("acceptance" in input) {
      const structured = await agent({
        name: "acceptance-read", access: "read", prompt: `Return exactly this JSON object: ${JSON.stringify({ echoed: input.message })}`,
        output: z.object({ echoed: z.string() }),
      });
      check(structured.echoed === input.message, "Unexpected structured provider output");
      try {
        await human.approve({ title: "Reject revision 1", presentation: { title: "Revision 1", markdown: "Reject this request so the revised proposal can be reviewed." }, action: { revision: 1 } },
          async () => { throw new Error("Acceptance requires a real rejection of revision 1"); });
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "APPROVAL_DENIED") throw error;
      }
      await human.approve({ title: "Approve revision 2", presentation: { title: "Revision 2", markdown: "Write acceptance-effect.txt once with the displayed message." }, action: { revision: 2, message: input.message } },
        async (action) => {
          const written = await command(process.execPath, ["--input-type=module", "--eval",
            "import { writeFile } from 'node:fs/promises'; await writeFile('acceptance-effect.txt', process.argv[1] + '\\n', 'utf8')", action.message]);
          check(written.exitCode === 0, written.stderr);
        });
      await human.ask({ question: "Reconnect or interrupt/resume this run, then answer continue.",
        presentation: { title: "Durable checkpoint", markdown: "The approved effect is committed. Reconnect to this same run; do not start a replacement." },
        output: z.literal("continue") });
      return structured;
    }
    const result = await command(process.execPath, [
      "--input-type=module",
      "--eval",
      "import { appendFile } from 'node:fs/promises'; await appendFile('body-effects.txt', process.argv[1] + '\\n', 'utf8')",
      input.message,
    ]);
    check(result.exitCode === 0, result.stderr);
    return { echoed: input.message };
  },
});
