import { Type } from "typebox";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ShadowConfig, ShadowTrigger } from "./types.js";
import { parseConfig } from "./config.js";
import { describeShadow, type EntityStore } from "./entity-store.js";

const ID = Type.String({ pattern: "^[a-z0-9][a-z0-9_-]*$" });
const THINKING = Type.Union([
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
const TRIGGER = Type.Union([
  Type.Literal("heartbeat"),
  Type.Literal("final_response"),
]);
const SHADOW_FIELDS = {
  name: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  debug: Type.Optional(Type.Boolean()),
  activation_probability: Type.Optional(
    Type.Number({ minimum: 0, maximum: 1 }),
  ),
  trigger: Type.Optional(Type.Array(TRIGGER)),
  active_for_models: Type.Optional(Type.Array(Type.String())),
  run_with_model: Type.Optional(Type.String()),
  thinking_level: Type.Optional(THINKING),
  timeout_seconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  activation_tools: Type.Optional(Type.Array(Type.String())),
  tools: Type.Optional(Type.Array(Type.String())),
  prompt: Type.Optional(Type.String()),
};

export function registerManagementTools(
  pi: ExtensionAPI,
  store: EntityStore,
  getConfig: () => ShadowConfig,
): void {
  pi.registerTool(listTool(store));
  pi.registerTool(createTool(store));
  pi.registerTool(updateTool(store));
  pi.registerTool(toggleTool(store, true));
  pi.registerTool(toggleTool(store, false));
  pi.registerTool(deleteTool(store));
  pi.registerTool(configReadTool(store));
  pi.registerTool(configWriteTool(store, getConfig));
}

function listTool(store: EntityStore): ToolDefinition {
  return tool(
    "list_shadows",
    "List Shadows",
    "List all valid globally configured Shadow Minds.",
    Type.Object({}),
    async () => {
      const shadows = await store.list();
      return textResult(
        shadows.length
          ? shadows.map(describeShadow).join("\n")
          : "No Shadow Minds configured.",
      );
    },
  );
}

function createTool(store: EntityStore): ToolDefinition {
  return tool(
    "create_shadow",
    "Create Shadow",
    "Create a global Shadow Mind definition after user confirmation.",
    Type.Object({ id: ID, ...SHADOW_FIELDS, prompt: Type.String() }),
    async (_id, params, _signal, _update, ctx) => {
      const raw = params as Record<string, unknown>;
      if (
        !(await confirm(
          ctx,
          "Create Shadow Mind",
          `Create ${String(raw.id)} in the global registry?`,
        ))
      )
        return textResult("Cancelled.");
      const shadow = await store.create(toDraft(raw));
      return textResult(`Created ${describeShadow(shadow)}`);
    },
  );
}

function updateTool(store: EntityStore): ToolDefinition {
  return tool(
    "update_shadow",
    "Update Shadow",
    "Update a global Shadow Mind definition after user confirmation. The id is immutable.",
    Type.Object({ id: ID, ...SHADOW_FIELDS }),
    async (_id, params, _signal, _update, ctx) => {
      const raw = params as Record<string, unknown>;
      if (
        !(await confirm(
          ctx,
          "Update Shadow Mind",
          `Apply changes to ${String(raw.id)}?`,
        ))
      )
        return textResult("Cancelled.");
      const shadow = await store.update(String(raw.id), toPatch(raw));
      return textResult(`Updated ${describeShadow(shadow)}`);
    },
  );
}

function toggleTool(store: EntityStore, enabled: boolean): ToolDefinition {
  const action = enabled ? "enable" : "disable";
  return tool(
    `${action}_shadow`,
    `${enabled ? "Enable" : "Disable"} Shadow`,
    `${enabled ? "Enable" : "Disable"} a global Shadow Mind after user confirmation.`,
    Type.Object({ id: ID }),
    async (_id, params, _signal, _update, ctx) => {
      const id = String((params as { id: string }).id);
      if (
        !(await confirm(
          ctx,
          `${enabled ? "Enable" : "Disable"} Shadow Mind`,
          `${action} ${id}?`,
        ))
      )
        return textResult("Cancelled.");
      return textResult(describeShadow(await store.setEnabled(id, enabled)));
    },
  );
}

function deleteTool(store: EntityStore): ToolDefinition {
  return tool(
    "delete_shadow",
    "Delete Shadow",
    "Delete a Shadow Mind definition after user confirmation. Debug logs are retained.",
    Type.Object({ id: ID }),
    async (_id, params, _signal, _update, ctx) => {
      const id = String((params as { id: string }).id);
      if (
        !(await confirm(
          ctx,
          "Delete Shadow Mind",
          `Delete ${id}? Its debug logs will be kept.`,
        ))
      )
        return textResult("Cancelled.");
      await store.delete(id);
      return textResult(`Deleted ${id}; logs were retained.`);
    },
  );
}

function configReadTool(store: EntityStore): ToolDefinition {
  return tool(
    "get_shadow_config",
    "Get Shadow Config",
    "Read the global Shadow Mind runtime configuration.",
    Type.Object({}),
    async () => textResult(await store.readConfig()),
  );
}

function configWriteTool(
  store: EntityStore,
  getConfig: () => ShadowConfig,
): ToolDefinition {
  return tool(
    "update_shadow_config",
    "Update Shadow Config",
    "Update global Shadow Mind runtime configuration after user confirmation.",
    Type.Object({
      heartbeat_probability: Type.Optional(
        Type.Number({ minimum: 0, maximum: 1 }),
      ),
      heartbeat_tools: Type.Optional(Type.Array(Type.String())),
      max_parallel_shadows: Type.Optional(Type.Integer({ minimum: 1 })),
      default_shadow_timeout_seconds: Type.Optional(
        Type.Number({ exclusiveMinimum: 0 }),
      ),
      headless_drain_timeout_seconds: Type.Optional(
        Type.Number({ exclusiveMinimum: 0 }),
      ),
      result_batch_window_ms: Type.Optional(Type.Integer({ minimum: 0 })),
      default_shadow_model: Type.Optional(Type.String()),
      default_thinking_level: Type.Optional(THINKING),
      random_seed: Type.Optional(
        Type.Integer({ minimum: 0, maximum: 0xffff_ffff }),
      ),
    }),
    async (_id, params, _signal, _update, ctx) => {
      const current = getConfig();
      const raw = params as Record<string, unknown>;
      const next = parseConfig({
        heartbeat_probability:
          raw.heartbeat_probability ?? current.heartbeatProbability,
        heartbeat_tools: raw.heartbeat_tools ?? current.heartbeatTools,
        max_parallel_shadows:
          raw.max_parallel_shadows ?? current.maxParallelShadows,
        default_shadow_timeout_seconds:
          raw.default_shadow_timeout_seconds ??
          current.defaultShadowTimeoutSeconds,
        headless_drain_timeout_seconds:
          raw.headless_drain_timeout_seconds ??
          current.headlessDrainTimeoutSeconds,
        result_batch_window_ms:
          raw.result_batch_window_ms ?? current.resultBatchWindowMs,
        default_shadow_model:
          raw.default_shadow_model ?? current.defaultShadowModel,
        default_thinking_level:
          raw.default_thinking_level ?? current.defaultThinkingLevel,
        random_seed: raw.random_seed ?? current.randomSeed,
      });
      if (
        !(await confirm(
          ctx,
          "Update Shadow Config",
          `Apply this config?\n${JSON.stringify(next, null, 2)}`,
        ))
      )
        return textResult("Cancelled.");
      await store.writeConfig(next);
      return textResult("Shadow Mind config updated.");
    },
  );
}

function tool(
  name: string,
  label: string,
  description: string,
  parameters: any,
  execute: ToolDefinition["execute"],
): ToolDefinition {
  return { name, label, description, parameters, execute };
}

async function confirm(
  ctx: Parameters<ToolDefinition["execute"]>[4],
  title: string,
  message: string,
): Promise<boolean> {
  if (!ctx.hasUI)
    throw new Error(
      "This write requires a UI confirmation, but no dialog-capable UI is available.",
    );
  return ctx.ui.confirm(title, message);
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function toDraft(raw: Record<string, unknown>) {
  return { id: String(raw.id), ...toPatch(raw) };
}

function toPatch(raw: Record<string, unknown>) {
  return {
    name: raw.name as string | undefined,
    enabled: raw.enabled as boolean | undefined,
    debug: raw.debug as boolean | undefined,
    activationProbability: raw.activation_probability as number | undefined,
    trigger: raw.trigger as ShadowTrigger[] | undefined,
    activeForModels: raw.active_for_models as string[] | undefined,
    runWithModel: raw.run_with_model as string | undefined,
    thinkingLevel: raw.thinking_level as any,
    timeoutSeconds: raw.timeout_seconds as number | undefined,
    activationTools: raw.activation_tools as string[] | undefined,
    tools: raw.tools as string[] | undefined,
    prompt: raw.prompt as string | undefined,
  };
}
