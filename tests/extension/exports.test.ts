import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import * as ts from "typescript";

import { Kavita } from "../../src/Kavita/main.js";

test("each extension exports an instance named after its Paperback id", () => {
  const srcDir = path.join(process.cwd(), "src");
  const extensionIds = extensionSourceIds(srcDir);

  const missingExports = extensionIds.filter((id) => {
    const mainFile = path.join(srcDir, id, "main.ts");
    return !exportedConstNames(mainFile).has(id);
  });

  assert.deepEqual(
    missingExports,
    [],
    "Paperback loads extension instances by the id from info.json, which the toolchain derives from the source folder name.",
  );
});

test("extension icons use Paperback-compatible raster PNG assets", () => {
  const srcDir = path.join(process.cwd(), "src");
  const invalidIcons = extensionSourceIds(srcDir).flatMap((id) => {
    const configFile = path.join(srcDir, id, "pbconfig.ts");
    const config = readFileSync(configFile, "utf8");
    const iconPath = /icon:\s*["']([^"']+)["']/u.exec(config)?.[1];
    if (!iconPath) return [`${id}: missing icon`];
    if (!iconPath.endsWith(".png")) return [`${id}: ${iconPath}`];
    if (!existsSync(path.join(srcDir, id, "static", iconPath))) {
      return [`${id}: missing static/${iconPath}`];
    }
    return [];
  });

  assert.deepEqual(invalidIcons, []);
});

test("Kavita exported runtime object exposes progress-provider methods", () => {
  assert.equal(typeof Kavita.getMangaProgressManagementForm, "function");
  assert.equal(typeof Kavita.getMangaProgress, "function");
  assert.equal(typeof Kavita.processChapterReadActionQueue, "function");
});

test("generated Kavita bundle keeps progress methods on the exported runtime object", () => {
  const bundle = readFileSync(path.join(process.cwd(), "bundles", "Kavita", "index.js"), "utf8");

  assert.match(bundle, /getMangaProgressManagementForm/u);
  assert.match(bundle, /getMangaProgress/u);
  assert.match(bundle, /processChapterReadActionQueue/u);
  assert.match(bundle, /Kavita=/u);
});

test("generated versioning keeps Progress Bridge as the tracker and Kavita content-only", () => {
  const versioning = JSON.parse(
    readFileSync(path.join(process.cwd(), "bundles", "versioning.json"), "utf8"),
  ) as { sources: Array<{ id: string; capabilities: number[] }> };
  const kavita = versioning.sources.find((source) => source.id === "Kavita");
  const progressBridge = versioning.sources.find((source) => source.id === "ProgressBridge");

  assert.ok(kavita);
  assert.ok(progressBridge);
  assert.equal(kavita.capabilities.includes(2), false);
  assert.ok(progressBridge.capabilities.includes(2));
  assert.equal(progressBridge.capabilities.filter((capability) => capability === 2).length, 1);
  assert.equal(kavita.capabilities.includes(103), false);
  assert.equal(progressBridge.capabilities.includes(103), false);
});

function extensionSourceIds(srcDir: string): string[] {
  return readdirSync(srcDir).filter((entry) => {
    const entryPath = path.join(srcDir, entry);
    return (
      existsSync(path.join(entryPath, "pbconfig.ts")) && existsSync(path.join(entryPath, "main.ts"))
    );
  });
}

function exportedConstNames(filePath: string): Set<string> {
  const sourceFile = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
      continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
    }
  }

  return names;
}
