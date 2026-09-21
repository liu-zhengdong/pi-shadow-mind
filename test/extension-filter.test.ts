import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createExtensionExcluder, isSelfExtension } from "../src/extension-filter.js";

/**
 * A real directory tree: the filter reads `package.json` from disk, because
 * `extensionsOverride` only receives file paths — Pi attaches package metadata
 * to the loaded extensions after the override has run.
 */
const root = mkdtempSync(join(tmpdir(), "shadow-ext-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function extensionFile(relativePath: string): string {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "export default {};\n");
  return file;
}

function packageManifest(relativeDirectory: string, name: string): string {
  const directory = join(root, relativeDirectory);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name }));
  return directory;
}

const NPM = "agent/npm/node_modules";
const GIT = "agent/git/github.com/liu-zhengdong";

packageManifest(`${NPM}/pi-experiencev2`, "pi-experiencev2");
packageManifest(`${NPM}/@ian-pascoe/pi-lsp`, "@ian-pascoe/pi-lsp");
packageManifest(`${NPM}/pi-timing`, "pi-timing");
const atriumDirectory = packageManifest(`${GIT}/pi-atrium`, "@liuser/pi-atrium");
packageManifest(`${GIT}/pi-atrium/notes`, "@liuser/pi-notes");

const archiver = extensionFile(`${NPM}/pi-experiencev2/dist/index.js`);
const lsp = extensionFile(`${NPM}/@ian-pascoe/pi-lsp/src/index.ts`);
const timing = extensionFile(`${NPM}/pi-timing/extensions/timing/index.ts`);
const atriumAdapter = extensionFile(`${GIT}/pi-atrium/adapter/index.ts`);
const atriumNotes = extensionFile(`${GIT}/pi-atrium/notes/src/index.ts`);
const localFile = extensionFile("agent/extensions/herdr-agent-state.ts");
const looseFile = extensionFile(`${NPM}/loose-extension.js`);
const everything = [archiver, lsp, timing, atriumAdapter, atriumNotes, localFile, looseFile];

describe("createExtensionExcluder", () => {
  it("matches a package by name, with or without an install scheme", () => {
    expect(createExtensionExcluder(["pi-experiencev2"])(archiver)).toBe(true);
    expect(createExtensionExcluder(["npm:pi-experiencev2"])(archiver)).toBe(true);
  });

  it("matches a scoped package by full name or by directory name", () => {
    expect(createExtensionExcluder(["@ian-pascoe/pi-lsp"])(lsp)).toBe(true);
    expect(createExtensionExcluder(["pi-lsp"])(lsp)).toBe(true);
  });

  it("finds the package several directories above the entry file", () => {
    expect(createExtensionExcluder(["pi-timing"])(timing)).toBe(true);
  });

  it("gives a nested package its own identity", () => {
    const outer = createExtensionExcluder(["@liuser/pi-atrium"]);
    expect(outer(atriumAdapter)).toBe(true);
    expect(outer(atriumNotes)).toBe(false);
    expect(createExtensionExcluder(["@liuser/pi-notes"])(atriumNotes)).toBe(true);
    expect(createExtensionExcluder(["pi-atrium"])(atriumAdapter)).toBe(true);
  });

  it("matches an absolute path to the entry file or to the package directory", () => {
    expect(createExtensionExcluder([archiver])(archiver)).toBe(true);
    expect(createExtensionExcluder([atriumDirectory])(atriumAdapter)).toBe(true);
    expect(createExtensionExcluder([`${atriumDirectory}/./`])(atriumAdapter)).toBe(true);
  });

  it("matches a single-file extension by file name, with or without suffix", () => {
    expect(createExtensionExcluder(["herdr-agent-state"])(localFile)).toBe(true);
    expect(createExtensionExcluder(["herdr-agent-state.ts"])(localFile)).toBe(true);
    expect(createExtensionExcluder([localFile])(localFile)).toBe(true);
  });

  it("stops at node_modules instead of adopting an unrelated package name", () => {
    expect(createExtensionExcluder(["loose-extension"])(looseFile)).toBe(true);
    expect(createExtensionExcluder(["node_modules"])(looseFile)).toBe(false);
  });

  it("never matches a packaged extension by its generic entry file name", () => {
    const generic = createExtensionExcluder(["index", "index.js", "index.ts", "dist", "src"]);
    expect(everything.filter(generic)).toEqual([]);
  });

  it("excludes nothing for an empty, blank or non-matching list", () => {
    for (const entries of [[], ["", "   "], ["*", "pi-experience", "experiencev2", "npm:"]]) {
      expect(everything.filter(createExtensionExcluder(entries))).toEqual([]);
    }
  });

  it("keeps every other extension while excluding the named ones", () => {
    const excluded = createExtensionExcluder(["pi-experiencev2", "herdr-agent-state"]);
    expect(everything.filter((path) => !excluded(path))).toEqual([
      lsp,
      timing,
      atriumAdapter,
      atriumNotes,
      looseFile,
    ]);
  });
});

describe("isSelfExtension", () => {
  const sourceDirectory = resolve(import.meta.dirname, "../src");

  it("matches this plugin's own module and entry points", () => {
    expect(isSelfExtension(resolve(sourceDirectory, "extension-filter.ts"))).toBe(true);
    expect(isSelfExtension(resolve(sourceDirectory, "index.ts"))).toBe(true);
    expect(isSelfExtension(resolve(sourceDirectory, "index.js"))).toBe(true);
    expect(isSelfExtension(resolve(sourceDirectory, "./nested/../index.js"))).toBe(true);
  });

  it("does not match other extensions", () => {
    expect(isSelfExtension(archiver)).toBe(false);
    expect(isSelfExtension(localFile)).toBe(false);
    expect(isSelfExtension(resolve(sourceDirectory, "runtime.ts"))).toBe(false);
  });
});
