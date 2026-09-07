import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigStore, DEFAULT_CONFIG } from "../src/config.js";
import { EntityStore } from "../src/entity-store.js";
import { ShadowRegistry } from "../src/registry.js";
import { ShadowMindRuntime } from "../src/runtime.js";
import type { ShadowConfig } from "../src/types.js";

const dirs: string[] = [];
type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void>;
interface Internals {
  configStore: ConfigStore;
  registry: ShadowRegistry;
  random: () => number;
  updateStatus: () => void;
  registerEvents: () => void;
  recentEvents: Array<{ kind: string; data?: Record<string, unknown> }>;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function harness(heartbeatTools: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "runtime-heartbeat-"));
  dirs.push(dir);
  const configStore = new ConfigStore(dir);
  await configStore.initialize();
  const registry = new ShadowRegistry(dir);
  await registry.initialize();
  const store = new EntityStore(registry, configStore.configPath);
  const save = (patch: Partial<ShadowConfig>) => store.writeConfig({
    ...DEFAULT_CONFIG, heartbeatTools, heartbeatProbability: 1, ...patch,
  });
  await save({});
  await configStore.reload();

  const handlers = new Map<string, Handler>();
  const runtime = new ShadowMindRuntime({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
  } as unknown as ExtensionAPI);
  const internals = runtime as unknown as Internals;
  internals.configStore = configStore;
  internals.registry = registry;
  const random = vi.fn(() => 0.1);
  internals.random = random;
  internals.updateStatus = vi.fn();
  internals.registerEvents();
  const reload = vi.spyOn(configStore, "reload");
  const ctx = { model: { provider: "openai", id: "test" } } as ExtensionContext;
  const turn = (tools: string[]) => handlers.get("turn_end")!({ toolResults: tools.map((toolName) => ({ toolName })) }, ctx);
  return { configStore, internals, reload, random, save, turn };
}

describe("heartbeat configuration refresh", () => {
  it.each([
    { oldTools: ["write"], newTools: ["read"], expectedKind: "heartbeat", rolls: 1 },
    { oldTools: [], newTools: ["write"], expectedKind: "heartbeat-skipped", rolls: 0 },
    { oldTools: ["write"], newTools: [], expectedKind: "heartbeat", rolls: 1 },
    { oldTools: ["write"], newTools: ["write"], expectedKind: "heartbeat-skipped", rolls: 0 },
  ])("uses freshly saved heartbeat_tools: $oldTools -> $newTools", async ({ oldTools, newTools, expectedKind, rolls }) => {
    const h = await harness(oldTools);
    // Same write path as update_shadow_config; the in-memory snapshot is still old.
    await h.save({ heartbeatTools: newTools });
    await h.turn(["read"]);
    expect(h.internals.recentEvents.at(-1)?.kind).toBe(expectedKind);
    expect(h.configStore.current.heartbeatTools).toEqual(newTools);
    expect(h.reload).toHaveBeenCalledOnce();
    expect(h.random).toHaveBeenCalledTimes(rolls);
    if (rolls === 0) expect(h.internals.recentEvents.at(-1)?.data?.reason).toBe("tool-filtered");
  });

  it("does not get stuck behind a rejecting filter across consecutive turns", async () => {
    const h = await harness(["write"]);
    await h.turn(["read"]);
    expect(h.random).not.toHaveBeenCalled();
    await h.save({ heartbeatTools: ["read"] });
    await h.turn(["read"]);
    expect(h.internals.recentEvents.at(-1)?.kind).toBe("heartbeat");
    expect(h.reload).toHaveBeenCalledTimes(2);
    expect(h.random).toHaveBeenCalledOnce();
  });

  it("uses probability and the tool filter from the same refreshed config", async () => {
    const h = await harness(["write"]);
    await h.save({ heartbeatTools: ["read"], heartbeatProbability: 0 });
    await h.turn(["read"]);
    const event = h.internals.recentEvents.at(-1);
    expect(event?.kind).toBe("heartbeat");
    expect(event?.data?.activated).toEqual([]);
    expect(h.configStore.current.heartbeatProbability).toBe(0);
    expect(h.reload).toHaveBeenCalledOnce();
    expect(h.random).toHaveBeenCalledOnce();
  });

  it("keeps text-only turns free of config reads and random draws", async () => {
    const h = await harness(["write"]);
    await h.turn([]);
    expect(h.internals.recentEvents.at(-1)?.data?.reason).toBe("no-tool-activity");
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.random).not.toHaveBeenCalled();
  });

  it("retains the last valid filter when the config file is malformed", async () => {
    const h = await harness(["write"]);
    await writeFile(h.configStore.configPath, "not json{");
    await h.turn(["read"]);
    expect(h.configStore.error).toBeDefined();
    expect(h.internals.recentEvents.at(-1)?.data?.reason).toBe("tool-filtered");
    expect(h.random).not.toHaveBeenCalled();
  });
});
