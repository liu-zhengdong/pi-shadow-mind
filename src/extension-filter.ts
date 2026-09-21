import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_PATH = normalize(resolve(fileURLToPath(import.meta.url)));
const SELF_DIRECTORY = dirname(SELF_PATH);
const SELF_ENTRIES = new Set(["index.ts", "index.js"]);

/** This plugin's own extension entry, which a Shadow session must never load. */
export function isSelfExtension(candidate: string): boolean {
  const normalized = normalize(resolve(candidate));
  if (normalized === SELF_PATH) return true;
  return dirname(normalized) === SELF_DIRECTORY && SELF_ENTRIES.has(basename(normalized));
}

/** Directories to inspect above an extension file when looking for its package root. */
const PACKAGE_LOOKUP_DEPTH = 4;
/** `index.js` and friends name nothing: almost every package entry is called that. */
const GENERIC_ENTRY_FILE = /^index\.[^.]+$/;
const packageNameCache = new Map<string, { name: string; directory: string } | undefined>();

/**
 * Every name an `excluded_extensions` entry may use for one extension.
 *
 * Only the file path is available here: `extensionsOverride` runs before Pi
 * attaches package metadata to the loaded extensions, so `sourceInfo` still
 * holds its "local/temporary" placeholder. The owning package is therefore read
 * from the nearest `package.json` above the file:
 *
 * - packaged extensions: the package name (`pi-experiencev2`, `@scope/name`),
 *   the package directory name and its absolute path;
 * - single-file extensions: the file name with and without suffix
 *   (`herdr-agent-state`, `herdr-agent-state.ts`).
 *
 * The absolute file path always counts. A bare `index.js` / `index.ts` never
 * becomes a name, so one generic entry cannot wipe out every packaged extension.
 */
export function extensionIdentifiers(resolvedPath: string): Set<string> {
  const normalized = normalize(resolve(resolvedPath));
  const identifiers = new Set([normalized]);
  const owner = findPackage(dirname(normalized));
  if (owner) {
    identifiers.add(owner.name);
    identifiers.add(basename(owner.directory));
    identifiers.add(owner.directory);
  }
  const fileName = basename(normalized);
  if (!GENERIC_ENTRY_FILE.test(fileName)) {
    identifiers.add(fileName);
    identifiers.add(fileName.replace(/\.[^.]+$/, ""));
  }
  return identifiers;
}

/**
 * Build the predicate for `excluded_extensions`: true means this extension stays
 * out of the Shadow session. Entries are exact identifiers, not patterns; blank
 * entries and an empty list exclude nothing.
 */
export function createExtensionExcluder(entries: readonly string[]): (resolvedPath: string) => boolean {
  const wanted = new Set<string>();
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    wanted.add(trimmed);
    wanted.add(stripScheme(trimmed));
    wanted.add(normalize(resolve(expandHome(trimmed))));
  }
  if (wanted.size === 0) return () => false;
  return (resolvedPath) => {
    for (const identifier of extensionIdentifiers(resolvedPath)) {
      if (wanted.has(identifier)) return true;
    }
    return false;
  };
}

/**
 * Nearest `package.json` with a name at or above `directory`. The search stays
 * inside the package: it never crosses a `node_modules` directory or the home
 * directory, and gives up after a few levels.
 */
function findPackage(directory: string): { name: string; directory: string } | undefined {
  if (packageNameCache.has(directory)) return packageNameCache.get(directory);
  const home = resolve(homedir());
  let current = directory;
  let found: { name: string; directory: string } | undefined;
  for (let depth = 0; depth < PACKAGE_LOOKUP_DEPTH; depth += 1) {
    if (basename(current) === "node_modules" || current === home) break;
    const name = readPackageName(current);
    if (name) {
      found = { name, directory: current };
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  packageNameCache.set(directory, found);
  return found;
}

function readPackageName(directory: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    const name = (parsed as { name?: unknown }).name;
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

function stripScheme(source: string): string {
  return source.replace(/^[a-z][a-z0-9+.-]+:/i, "");
}

function expandHome(entry: string): string {
  return entry === "~" || entry.startsWith("~/") ? resolve(homedir(), entry.slice(2)) : entry;
}
