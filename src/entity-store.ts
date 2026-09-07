import { readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import YAML from "yaml";
import { serializeConfig } from "./config.js";
import { parseShadowMarkdown, ShadowRegistry } from "./registry.js";
import type { ShadowConfig, ShadowDefinition } from "./types.js";

export type ShadowDraft = Partial<Omit<ShadowDefinition, "filePath">> & {
  id: string;
  prompt?: string;
};

export class EntityStore {
  constructor(
    readonly registry: ShadowRegistry,
    private readonly configPath: string,
  ) {}

  async list(): Promise<ShadowDefinition[]> {
    return (await this.registry.load()).shadows;
  }

  async get(id: string): Promise<ShadowDefinition> {
    const shadow = (await this.list()).find((candidate) => candidate.id === id);
    if (!shadow) throw new Error(`shadow not found: ${id}`);
    return shadow;
  }

  async create(draft: ShadowDraft): Promise<ShadowDefinition> {
    if ((await this.list()).some((shadow) => shadow.id === draft.id))
      throw new Error(`shadow already exists: ${draft.id}`);
    return this.writeParsed(
      join(this.registry.directory, `${draft.id}.md`),
      draft,
      { overwrite: false },
    );
  }

  async update(
    id: string,
    patch: Partial<Omit<ShadowDraft, "id">>,
  ): Promise<ShadowDefinition> {
    const current = await this.get(id);
    return this.writeParsed(
      current.filePath,
      {
        ...current,
        ...definedOnly(patch),
        id,
        prompt: patch.prompt ?? current.prompt,
      },
      { overwrite: true },
    );
  }

  private async writeParsed(
    filePath: string,
    draft: ShadowDraft,
    options: { overwrite: boolean },
  ): Promise<ShadowDefinition> {
    const source = serializeShadow({
      ...draft,
      prompt: draft.prompt ?? "Describe this Shadow Mind's responsibility.",
    });
    const parsed = parseShadowMarkdown(source, filePath);
    await writeFile(filePath, source, {
      encoding: "utf8",
      ...(options.overwrite ? {} : { flag: "wx" }),
    });
    return parsed;
  }

  async setEnabled(id: string, enabled: boolean): Promise<ShadowDefinition> {
    return this.update(id, { enabled });
  }

  async delete(id: string): Promise<void> {
    await unlink((await this.get(id)).filePath);
  }

  async readConfig(): Promise<string> {
    return readFile(this.configPath, "utf8");
  }

  async writeConfig(config: ShadowConfig): Promise<void> {
    await writeFile(this.configPath, serializeConfig(config), "utf8");
  }
}

export function serializeShadow(shadow: ShadowDraft): string {
  const frontmatter: Record<string, unknown> = {
    id: shadow.id,
    ...(shadow.name !== undefined ? { name: shadow.name } : {}),
    enabled: shadow.enabled ?? true,
    debug: shadow.debug ?? false,
    activation_probability: shadow.activationProbability ?? 0.3,
    trigger: shadow.trigger ?? ["heartbeat"],
    active_for_models: shadow.activeForModels ?? ["*"],
    ...(shadow.runWithModel ? { run_with_model: shadow.runWithModel } : {}),
    ...(shadow.thinkingLevel ? { thinking_level: shadow.thinkingLevel } : {}),
    ...(shadow.timeoutSeconds !== undefined
      ? { timeout_seconds: shadow.timeoutSeconds }
      : {}),
    ...(shadow.activationTools && shadow.activationTools.length
      ? { activation_tools: shadow.activationTools }
      : {}),
    tools: shadow.tools ?? [],
  };
  return `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n\n${(shadow.prompt ?? "").trim()}\n`;
}

export function describeShadow(shadow: ShadowDefinition): string {
  const actTools = shadow.activationTools.length
    ? ` act_tools=${shadow.activationTools.join(",")}`
    : "";
  return `${shadow.enabled ? "enabled" : "disabled"} ${shadow.id} (${shadow.name}) p=${shadow.activationProbability} trigger=${shadow.trigger.join(",")} models=${shadow.activeForModels.join(",")}${actTools} tools=${shadow.tools.join(",") || "default"} file=${basename(shadow.filePath)}`;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}
