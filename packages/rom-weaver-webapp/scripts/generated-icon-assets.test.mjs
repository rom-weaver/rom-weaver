import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  generatedChannelAssetPath,
  generatedIconAssetsDir,
  generatedSocialPreviewPath,
} from "./generated-icon-assets.mjs";

test("uses the generated production icon for prod and dev", () => {
  assert.equal(
    generatedChannelAssetPath("prod", "favicon.ico"),
    path.join(generatedIconAssetsDir, "production", "favicon.ico"),
  );
  assert.equal(
    generatedChannelAssetPath("dev", "favicon.ico"),
    path.join(generatedIconAssetsDir, "production", "favicon.ico"),
  );
});

test("does not fall back to production when a channel icon is missing", () => {
  const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-icons-"));
  try {
    fs.mkdirSync(path.join(assetDir, "production"));
    fs.writeFileSync(path.join(assetDir, "production", "favicon.ico"), "production");
    assert.throws(() => generatedChannelAssetPath("beta", "favicon.ico", assetDir), /Generated beta icon is missing/);
  } finally {
    fs.rmSync(assetDir, { force: true, recursive: true });
  }
});

test("resolves the social card from the generated assets root", () => {
  const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-social-"));
  try {
    fs.writeFileSync(path.join(assetDir, "social-preview.png"), "card");
    assert.equal(generatedSocialPreviewPath("social-preview.png", assetDir), path.join(assetDir, "social-preview.png"));
    assert.throws(
      () => generatedSocialPreviewPath("social-preview.avif", assetDir),
      /Generated social preview is missing/,
    );
  } finally {
    fs.rmSync(assetDir, { force: true, recursive: true });
  }
});
