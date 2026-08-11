import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

export const rpcContract = defineRpcContract({
  openTerminal: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ terminalId: z.string() }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    async openTerminal({ threadId }) {
      const session = await bb.sdk.terminals.create({
        scope: { kind: "thread", threadId },
        cols: 80,
        rows: 24,
      });
      return { terminalId: session.id };
    },
  });
}
