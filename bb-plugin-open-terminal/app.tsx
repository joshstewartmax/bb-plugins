import { useState } from "react";
import { definePluginApp, useComposer, useRpc } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

function OpenTerminalAction() {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const [isOpening, setIsOpening] = useState(false);

  if (composer.scope.kind !== "thread") return null;
  const { threadId } = composer.scope;

  async function openTerminal() {
    setIsOpening(true);
    try {
      await rpc.call("openTerminal", { threadId });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to open terminal",
      );
    } finally {
      setIsOpening(false);
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7 text-muted-foreground"
      aria-label="Open terminal"
      disabled={isOpening}
      onClick={() => void openTerminal()}
    >
      <Icon name="Terminal" className="size-4" aria-hidden />
    </Button>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "open-terminal",
    scopes: ["thread"],
    actions: [{ id: "open-terminal", component: OpenTerminalAction }],
  });
});
