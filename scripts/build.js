#!/usr/bin/env node
// ProtoConsent browser extension - service worker entry point
// Copyright (C) 2026 ProtoConsent contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Simple build script to copy extension source to build/ and apply target-specific manifest overrides. No bundling or transpilation.
// Usage: node scripts/build.js
// Output: build/chrome/ and build/firefox/ directories ready for loading as unpacked extensions.
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const EXT = resolve(ROOT, "extension");
const BUILD = resolve(ROOT, "build");

const TARGETS = {
  chrome: {},
  firefox: {
    background: { scripts: ["background.js"], type: "module" },
    browser_specific_settings: {
      gecko: { id: "protoconsent@protoconsent.org", strict_min_version: "133.0" },
    },
  },
};

function buildTarget(name, overrides) {
  const out = resolve(BUILD, name);
  rmSync(out, { recursive: true, force: true });
  cpSync(EXT, out, {
    recursive: true,
    filter: (src) => !src.includes("_metadata"),
  });

  const manifestPath = resolve(out, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

  if (overrides.background) {
    delete manifest.background.service_worker;
    manifest.background = overrides.background;
  }

  if (overrides.browser_specific_settings) {
    manifest.browser_specific_settings = overrides.browser_specific_settings;
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`  ${name}/ -> ${out}`);
}

console.log("ProtoConsent build");
console.log(`  source: ${EXT}`);
console.log(`  output: ${BUILD}/\n`);

mkdirSync(BUILD, { recursive: true });

for (const [name, overrides] of Object.entries(TARGETS)) {
  buildTarget(name, overrides);
}

console.log("\nDone. Load from build/chrome or build/firefox.");
