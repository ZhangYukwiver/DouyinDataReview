#!/usr/bin/env node

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { extractFile as extractArchiveFile, listPackage, statFile as statArchiveFile } from "@electron/asar";
import { DIRECT_SIGNER_FILES, verifyDirectSigner } from "../collector/directHistory.mjs";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateNames = /^(?:\.local-data(?:-.*)?|browser-profile|profile|profiles|records(?:\.json)?|direct-history-template\.json|cookies?(?:\.sqlite|\.db|\.json)?(?:-journal|-wal|-shm)?|login data(?:-journal|-wal|-shm)?|local state|web data(?:-journal|-wal|-shm)?|\.env(?:\..*)?|\.git|\.ssh)$/i;
const extractFile = (archive, relative) => extractArchiveFile(archive, path.normalize(relative));
const statFile = (archive, relative) => statArchiveFile(archive, path.normalize(relative));

export function assertPublicPackagePath(value) {
  const parts = value.replaceAll("\\", "/").split("/").filter(Boolean);
  assert(parts.every((part) => part !== ".." && !privateNames.test(part)), `Private data path in package: ${value}`);
}

export function assertPublicUpdateMetadata(value, packageName) {
  const metadata = Object.fromEntries(value.trim().split(/\r?\n/u).map((line) => {
    const match = /^([A-Za-z]+): ([A-Za-z0-9_.-]+)$/u.exec(line);
    assert(match, "Unexpected updater metadata value");
    return [match[1], match[2]];
  }));
  assert.deepEqual(Object.keys(metadata).sort(), ["owner", "provider", "repo", "updaterCacheDirName"]);
  assert.equal(metadata.provider, "github");
  assert.equal(metadata.updaterCacheDirName, `${packageName}-updater`);
  if (process.env.GITHUB_REPOSITORY) {
    assert.equal(`${metadata.owner}/${metadata.repo}`, process.env.GITHUB_REPOSITORY);
  }
}

async function filesUnder(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert(!entry.isSymbolicLink(), `Unexpected symlink: ${relative}`);
    if (entry.isDirectory()) files.push(...await filesUnder(path.join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files;
}

export async function verifyReleasePackage(resourcesDirectory, { sourceDirectory = projectDirectory, tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined } = {}) {
  const resources = path.resolve(resourcesDirectory);
  const archive = path.join(resources, "app.asar");
  const sourcePackage = JSON.parse(await readFile(path.join(sourceDirectory, "package.json"), "utf8"));
  const packedPackage = JSON.parse(extractFile(archive, "package.json").toString("utf8"));
  assert.equal(packedPackage.version, sourcePackage.version, "Packaged version differs from source");
  assert.equal(packedPackage.main, "desktop/main.mjs");
  if (tag) assert.equal(tag, `v${sourcePackage.version}`, "Tag differs from packaged version");

  const entries = listPackage(archive).map((entry) => entry.replaceAll("\\", "/").replace(/^\//, ""));
  for (const entry of entries) {
    assertPublicPackagePath(entry);
    assert(/^(?:desktop|collector|dist|build|node_modules)(?:\/|$)|^package\.json$/.test(entry), `Unexpected archive path: ${entry}`);
    assert(!entry.startsWith("collector/fixtures/") && !entry.endsWith(".test.mjs"), `Test fixture in package: ${entry}`);
    if (entry.startsWith("node_modules/")) {
      assert(entry === "node_modules/playwright-core" || entry.startsWith("node_modules/playwright-core/"), `Unexpected runtime dependency: ${entry}`);
    }
  }

  for (const relative of ["collector/directHistory.mjs", "collector/douyinCollector.mjs", "desktop/main.mjs"]) {
    assert.deepEqual(extractFile(archive, relative), await readFile(path.join(sourceDirectory, relative)), `Outdated packaged source: ${relative}`);
  }

  const distFiles = await filesUnder(path.join(sourceDirectory, "dist"));
  assert(distFiles.includes("index.html"), "Web build is missing index.html");
  const packedDist = entries.filter((entry) => entry.startsWith("dist/") && !("files" in statFile(archive, entry)));
  assert.deepEqual(packedDist.sort(), distFiles.map((entry) => `dist/${entry}`).sort(), "Packaged web file list differs from current build");
  let recoveryBundled = false;
  for (const relative of distFiles) {
    const contents = extractFile(archive, `dist/${relative}`);
    assert.deepEqual(contents, await readFile(path.join(sourceDirectory, "dist", relative)), `Outdated packaged web asset: ${relative}`);
    if (relative.endsWith(".js")) {
      const source = contents.toString("utf8");
      recoveryBundled ||= source.includes("takeFallback") && /newSet\(\["login_required","template_missing","template_invalid","template_mismatch","session_incomplete"\]\)/.test(source.replace(/\s+/g, ""));
    }
  }
  assert(recoveryBundled, "Web bundle is missing the sync recovery state machine");

  const runner = "collector/directSignerRunner.cjs";
  assert.equal(statFile(archive, runner).unpacked, true, "Signer runner must be unpacked");
  assert.deepEqual(await readFile(path.join(resources, "app.asar.unpacked", runner)), await readFile(path.join(sourceDirectory, runner)));
  for (const relative of ["node_modules/playwright-core/package.json", "node_modules/playwright-core/index.js"]) {
    assert.equal(statFile(archive, relative).unpacked, true, "Playwright must be unpacked");
    assert.deepEqual(await readFile(path.join(resources, "app.asar.unpacked", relative)), await readFile(path.join(sourceDirectory, relative)));
  }
  const signerDirectory = path.join(resources, "direct-signer");
  assert.deepEqual((await filesUnder(signerDirectory)).sort(), Object.keys(DIRECT_SIGNER_FILES).sort(), "Unexpected file in bundled signer");
  await verifyDirectSigner(signerDirectory);

  for (const relative of await filesUnder(resources)) {
    assertPublicPackagePath(relative);
    assert(relative === "app.asar" || relative === "app-update.yml" || relative === "default_app.asar" || relative === "elevate.exe" || relative === "icon.icns" || /^[^/]+\.lproj\/(?:locale\.pak|InfoPlist\.strings)$/.test(relative) || relative.startsWith("app.asar.unpacked/") || relative.startsWith("direct-signer/"), `Unexpected resource: ${relative}`);
    if (relative === "app-update.yml") {
      assertPublicUpdateMetadata(await readFile(path.join(resources, relative), "utf8"), sourcePackage.name);
    }
    if (relative === "default_app.asar") {
      const electronResources = process.platform === "darwin" ? "Electron.app/Contents/Resources" : "resources";
      assert.deepEqual(await readFile(path.join(resources, relative)), await readFile(path.join(sourceDirectory, "node_modules/electron/dist", electronResources, relative)), "Unexpected Electron default archive");
    }
    if (relative.startsWith("app.asar.unpacked/")) {
      const archiveRelative = relative.slice("app.asar.unpacked/".length);
      assert.equal(statFile(archive, archiveRelative).unpacked, true, `Untracked unpacked resource: ${relative}`);
    }
  }
  return { version: packedPackage.version, webFiles: distFiles.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/verify-release-package.mjs <packaged resources directory>");
  const result = await verifyReleasePackage(process.argv[2]);
  console.log(`Verified release ${result.version}: current collector, ${result.webFiles} web assets, recovery flow, signer and no private data paths.`);
}
