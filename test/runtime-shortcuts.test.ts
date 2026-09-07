import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ShadowMindRuntime } from "../src/runtime.js";

type Shortcut = Parameters<ExtensionAPI["registerShortcut"]>[1];

interface RuntimeInternals {
  registerUi: () => void;
  paused: boolean;
  latestContext?: ExtensionContext;
  abortAll: (reason: string) => void;
  updateStatus: (ctx: ExtensionContext) => void;
}

describe("Shadow Mind shortcuts", () => {
  it.each(["f6", "alt+s"])("%s pauses and resumes the session", async (key) => {
    const shortcuts = new Map<string, Shortcut>();
    const runtime = new ShadowMindRuntime({
      registerCommand: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerShortcut: (shortcut: string, options: Shortcut) => {
        shortcuts.set(shortcut, options);
      },
    } as unknown as ExtensionAPI);
    const internals = runtime as unknown as RuntimeInternals;
    const abort = vi.spyOn(internals, "abortAll").mockImplementation(() => {});
    const status = vi
      .spyOn(internals, "updateStatus")
      .mockImplementation(() => {});
    const notify = vi.fn();
    const ctx = { ui: { notify } } as unknown as ExtensionContext;
    internals.registerUi();

    expect([...shortcuts.keys()]).toEqual(["f6", "alt+s"]);
    const shortcut = shortcuts.get(key)!;
    expect(internals.paused).toBe(false);

    await shortcut.handler(ctx);
    expect(internals.paused).toBe(true);
    expect(internals.latestContext).toBe(ctx);
    expect(abort).toHaveBeenCalledExactlyOnceWith("paused");
    expect(notify).toHaveBeenLastCalledWith("Shadow Mind paused", "info");
    expect(status).toHaveBeenLastCalledWith(ctx);

    await shortcut.handler(ctx);
    expect(internals.paused).toBe(false);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith("Shadow Mind resumed", "info");
    expect(status).toHaveBeenCalledTimes(2);
  });
});
