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

const TERMINAL_SELECTION_BACKGROUND = "#3390ff59";

interface TerminalLike {
  options: {
    theme?: { selectionBackground?: string } & Record<string, unknown>;
  };
  getSelection(): string;
  _addonManager?: {
    _addons?: { instance?: { clearTextureAtlas?: unknown; dispose(): void } }[];
  };
}

function readTerminalSelection(xtermRoot: Element): string {
  const textarea = xtermRoot.querySelector("textarea");
  if (!textarea) return "";
  const clipboardData = new DataTransfer();
  textarea.dispatchEvent(
    new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }),
  );
  return clipboardData.getData("text/plain");
}

// The xterm Terminal instance is not exposed on the DOM; the only path to it
// is the ref held by bb's terminal component, reachable through React fiber
// internals. Best-effort: returns null if bb's internals change shape.
function findTerminalInstance(xtermRoot: Element): TerminalLike | null {
  const host = xtermRoot.parentElement;
  if (!host) return null;
  const fiberKey = Object.keys(host).find((key) =>
    key.startsWith("__reactFiber$"),
  );
  if (!fiberKey) return null;
  let fiber = (host as unknown as Record<string, any>)[fiberKey];
  for (let depth = 0; fiber != null && depth < 12; depth += 1) {
    for (let hook = fiber.memoizedState; hook != null; hook = hook.next) {
      const candidate = hook.memoizedState?.current;
      if (
        candidate != null &&
        typeof candidate.getSelection === "function" &&
        typeof candidate.options === "object"
      ) {
        return candidate as TerminalLike;
      }
    }
    fiber = fiber.return;
  }
  return null;
}

// Two fixes are needed before selections are visible: bb's bundled xterm
// WebGL renderer never paints the selection layer, so the WebGL addon (the
// one with clearTextureAtlas) is disposed to fall back to the DOM renderer;
// and bb's theme uses --muted as the selection color, which is nearly
// identical to the terminal background.
function makeSelectionVisible(xtermRoot: Element): void {
  const terminal = findTerminalInstance(xtermRoot);
  if (!terminal) return;
  try {
    const webglAddon = terminal._addonManager?._addons?.find(
      (addon) => typeof addon.instance?.clearTextureAtlas === "function",
    );
    webglAddon?.instance?.dispose();
  } catch {
    // Renderer fallback is best-effort; the recolor below still applies.
  }
  const theme = terminal.options.theme ?? {};
  if (theme.selectionBackground === TERMINAL_SELECTION_BACKGROUND) return;
  terminal.options.theme = {
    ...theme,
    selectionBackground: TERMINAL_SELECTION_BACKGROUND,
  };
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "open-terminal",
    scopes: ["thread"],
    actions: [{ id: "open-terminal", component: OpenTerminalAction }],
  });

  app.contentScripts.register({
    id: "terminal-copy",
    mount({ signal }) {
      const onKeyDown = (event: KeyboardEvent) => {
        if (!event.ctrlKey || event.altKey || event.metaKey) return;
        if (event.key.toLowerCase() !== "c") return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const xtermRoot = target.closest(".xterm");
        if (!xtermRoot) return;
        const selection = readTerminalSelection(xtermRoot);
        if (!selection) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void navigator.clipboard.writeText(selection);
      };
      document.addEventListener("keydown", onKeyDown, {
        capture: true,
        signal,
      });

      const fixTerminalSelections = () => {
        document
          .querySelectorAll(".xterm")
          .forEach((xtermRoot) => makeSelectionVisible(xtermRoot));
      };
      fixTerminalSelections();
      const timer = window.setInterval(fixTerminalSelections, 2000);
      signal.addEventListener("abort", () => window.clearInterval(timer), {
        once: true,
      });
    },
  });
});
