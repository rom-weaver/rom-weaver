import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";

export const makeJourneyInputs = () => {
  const original = Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 17 + 11) % 256));
  const modified = Buffer.concat([original, Buffer.from("release roundtrip suffix")]);
  modified[3] = 0xaa;
  modified[2048] = 0xbb;
  return { original, modified };
};

const makeTrimJourneyInput = () => {
  const bytes = Buffer.alloc(0x5000);
  bytes.write("RW-TRIM-TEST");
  bytes.writeUInt32LE(0x3000, 0x80);
  bytes.writeUInt32LE(0x1000, 0x84);
  bytes.writeUInt32LE(0x3000, 0x210);
  for (let index = 0; index < 156; index++) bytes[0xc0 + index] = (index * 37 + 11) % 251;
  const crc16 = (input) => {
    let crc = 0xffff;
    for (const byte of input) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xa001 : 0);
    }
    return crc;
  };
  bytes.writeUInt16LE(crc16(bytes.subarray(0xc0, 0x15c)), 0x15c);
  bytes.writeUInt16LE(crc16(bytes.subarray(0, 0x15e)), 0x15e);
  for (let index = 0x1000; index < bytes.length; index++) bytes[index] = (index * 13 + 5) % 251;
  return bytes;
};

const makeSaveJourneyInput = () => {
  const bytes = Buffer.alloc(0x8000);
  bytes.set([0x80, 0x81, 0x82, 0x50], 0x2598);
  bytes.set([0x86, 0x80, 0x93, 0x50], 0x25f6);
  bytes.set([0x01, 0x23, 0x45], 0x25f3);
  bytes.set([0x06, 0x78], 0x2850);
  bytes[0x2601] = 3;
  bytes[0x25ca] = 0xff;
  bytes[0x27e7] = 0xff;
  bytes[0x7000] = 0xa5;
  bytes[0x3523] = ~bytes.subarray(0x2598, 0x3523).reduce((sum, byte) => sum + byte, 0) & 0xff;
  return bytes;
};

export const assertJourneyBytes = (actual, expected, label) => {
  requireJourney(Buffer.from(actual).equals(Buffer.from(expected)), label + ": downloaded bytes differ from input");
};

const requireJourney = (condition, message) => {
  if (!condition) throw new Error(message);
};

const requireEqual = (actual, expected, message) =>
  requireJourney(actual === expected, message || `Expected ${expected}, received ${actual}`);

const digest = (algorithm, bytes) => crypto.createHash(algorithm).update(bytes).digest("hex");
const inputFile = (name, buffer) => ({ name, buffer, mimeType: "application/octet-stream" });

const enableBetaTools = (context) =>
  context.addInitScript(() => {
    if (!/^https?:$/.test(location.protocol)) return;
    localStorage.setItem("rom-weaver-settings", JSON.stringify({ version: 5, common: { betaToolsEnabled: true } }));
  });

const downloadedBytes = async (page, action) => {
  let download;
  try {
    [download] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), action()]);
  } catch (cause) {
    const visibleState = (await page.locator("body").innerText()).slice(-8000);
    throw new Error(`Download did not start. Visible state:\n${visibleState}`, { cause });
  }
  let downloadPath;
  try {
    downloadPath = await download.path();
  } catch (cause) {
    throw new Error(`Download ${download.suggestedFilename()} failed: ${String(await download.failure())}`, { cause });
  }
  requireJourney(downloadPath, `Download ${download.suggestedFilename()} has no saved path`);
  return { bytes: fs.readFileSync(downloadPath), name: download.suggestedFilename() };
};

const waitForEnabled = async (page, id) => {
  try {
    await page.waitForFunction((controlId) => {
      const control = document.getElementById(controlId);
      return control instanceof HTMLButtonElement && !control.disabled;
    }, id);
  } catch (cause) {
    const visibleState = (await page.locator("body").innerText()).slice(-8000);
    throw new Error(`${id} never became enabled. Visible state:\n${visibleState}`, { cause });
  }
};

const openWorkflow = async (page, baseUrl, route, pickerId) => {
  await page.goto(new URL(route, baseUrl).href, { waitUntil: "domcontentloaded" });
  await page.waitForFunction((id) => document.getElementById(id) instanceof HTMLInputElement, pickerId);
  const controls = await page.locator("input, select, button").evaluateAll((elements) =>
    elements.map((element) => ({
      id: element.id,
      name: element.getAttribute("aria-label") || element.textContent?.trim(),
      type: element.getAttribute("type"),
    })),
  );
  requireJourney(
    controls.some((control) => control.id === pickerId && control.type === "file"),
    `${route}: missing file picker`,
  );
  return page.locator(`#${pickerId}`);
};

const requireCollapsedOutputJobs = async (page, ids, label) => {
  for (const id of ids) {
    const toggle = page.locator(`#${id} > .weave-job > button[aria-expanded]`);
    await toggle.waitFor({ state: "visible" });
    requireEqual(await toggle.getAttribute("aria-expanded"), "false", `${label}: ${id} should start collapsed`);
  }
};

const runCombinedPatchRoundtrips = async (page, baseUrl, configureUncompressedOutput) => {
  const { original } = makeJourneyInputs();
  const makeIps = (records) =>
    Buffer.concat([
      Buffer.from("PATCH"),
      ...records.map(({ offset, bytes }) => {
        const header = Buffer.alloc(5);
        header.writeUIntBE(offset, 0, 3);
        header.writeUInt16BE(bytes.length, 3);
        return Buffer.concat([header, Buffer.from(bytes)]);
      }),
      Buffer.from("EOF"),
    ]);
  const first = makeIps([
    { offset: 3, bytes: [0xaa] },
    { offset: 2048, bytes: [0xbb] },
  ]);
  const second = makeIps([
    { offset: 3, bytes: [0xcc] },
    { offset: 1024, bytes: [0xdd] },
  ]);
  const expected = Buffer.from(original);
  expected[3] = 0xcc;
  expected[1024] = 0xdd;
  expected[2048] = 0xbb;
  const stackFiles = () => [
    inputFile("original.bin", original),
    inputFile("01-first.ips", first),
    inputFile("02-second.ips", second),
  ];
  const reapplyCombined = async (patch, label) => {
    requireJourney(patch.name.endsWith(".bps"), `${label}: expected BPS, received ${patch.name}`);
    requireEqual(patch.bytes.subarray(0, 4).toString("ascii"), "BPS1", `${label}: missing BPS header`);
    requireEqual(patch.bytes.readUInt32LE(patch.bytes.length - 12), zlib.crc32(original), `${label}: source CRC32`);
    requireEqual(patch.bytes.readUInt32LE(patch.bytes.length - 8), zlib.crc32(expected), `${label}: target CRC32`);
    const picker = await openWorkflow(page, baseUrl, "apply-patches", "rom-weaver-input-file-unified");
    await picker.setInputFiles([inputFile("original.bin", original), inputFile(patch.name, patch.bytes)]);
    await waitForEnabled(page, "rom-weaver-button-apply");
    const rebuilt = await downloadedBytes(page, () => page.locator("#rom-weaver-button-apply").click());
    assertJourneyBytes(rebuilt.bytes, expected, `${label} -> Apply exact combined result`);
  };

  const createPicker = await openWorkflow(page, baseUrl, "create-patch", "patch-builder-input-file-unified");
  await configureUncompressedOutput(page);
  const mode = page.getByRole("group", { name: "Create patch from", exact: true });
  const modifiedMode = mode.getByRole("button", { name: "Modified ROM", exact: true });
  await modifiedMode.waitFor({ state: "visible" });
  requireEqual(await modifiedMode.getAttribute("aria-pressed"), "true", "Create should default to Modified ROM");
  await createPicker.setInputFiles(stackFiles());
  const patchesMode = mode.getByRole("button", { name: "Patches & cheats", exact: true });
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll("fieldset.seg button")).some(
      (button) => button.textContent?.trim() === "Patches & cheats" && button.getAttribute("aria-pressed") === "true",
    ),
  );
  requireEqual(
    await patchesMode.getAttribute("aria-pressed"),
    "true",
    "Create should select Patches & cheats for patch uploads",
  );
  await requireCollapsedOutputJobs(page, ["rom-weaver-apply-job", "rom-weaver-weave-job"], "Create combined outputs");
  const createOutput = page.locator("#rom-weaver-combined-patch-output");
  await createOutput.locator("#rom-weaver-combined-patch-format").selectOption("bps");
  const created = await downloadedBytes(page, () =>
    createOutput.getByRole("button", { name: "Create patch & download", exact: true }).click(),
  );
  await reapplyCombined(created, "Create ordered IPS -> combined BPS");

  for (const [route, pickerId, otherJob] of [
    ["apply-patches", "rom-weaver-input-file-unified", "rom-weaver-weave-job"],
    ["weave-patches", "rom-weaver-input-file-unified-weave", "rom-weaver-apply-job"],
  ]) {
    const picker = await openWorkflow(page, baseUrl, route, pickerId);
    await picker.setInputFiles(stackFiles());
    await requireCollapsedOutputJobs(page, ["rom-weaver-combined-patch-job", otherJob], route);
    const combinedJob = page.locator("#rom-weaver-combined-patch-job");
    await combinedJob.locator(":scope > .weave-job > button[aria-expanded]").click();
    await combinedJob.locator("#rom-weaver-combined-patch-format").selectOption("bps");
    const exported = await downloadedBytes(page, () =>
      combinedJob.getByRole("button", { name: "Create patch & download", exact: true }).click(),
    );
    await reapplyCombined(exported, `${route} optional combined BPS`);
  }
  process.stdout.write(
    "PASS Create auto-mode and Apply/Weave optional combined BPS exports -> exact byte roundtrips\n",
  );
};

export const runCreateApplyRoundtrip = async (createContext, baseUrl, configureUncompressedOutput) => {
  const context = await createContext({ acceptDownloads: true, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  const { original, modified } = makeJourneyInputs();
  try {
    const picker = await openWorkflow(page, baseUrl, "create-patch", "patch-builder-input-file-unified");
    await configureUncompressedOutput(page);
    await picker.setInputFiles([inputFile("original.bin", original), inputFile("modified.bin", modified)]);
    await waitForEnabled(page, "patch-builder-button-create");
    await page.locator("#patch-builder-select-patch-type").selectOption("bps");
    const patch = await downloadedBytes(page, () => page.locator("#patch-builder-button-create").click());
    requireJourney(patch.name.endsWith(".bps"), `Create: expected BPS, received ${patch.name}`);
    requireEqual(patch.bytes.subarray(0, 4).toString("ascii"), "BPS1");
    requireEqual(
      patch.bytes.readUInt32LE(patch.bytes.length - 12),
      zlib.crc32(original),
      "BPS source CRC32 differs from original",
    );
    requireEqual(
      patch.bytes.readUInt32LE(patch.bytes.length - 8),
      zlib.crc32(modified),
      "BPS target CRC32 differs from modified",
    );
    const applyPicker = await openWorkflow(page, baseUrl, "apply-patches", "rom-weaver-input-file-unified");
    await applyPicker.setInputFiles([inputFile("original.bin", original), inputFile(patch.name, patch.bytes)]);
    await waitForEnabled(page, "rom-weaver-button-apply");
    const output = await downloadedBytes(page, () => page.locator("#rom-weaver-button-apply").click());
    assertJourneyBytes(output.bytes, modified, "Create -> Apply BPS roundtrip");
    const weavePicker = await openWorkflow(page, baseUrl, "weave-patches", "rom-weaver-input-file-unified-weave");
    await weavePicker.setInputFiles([inputFile("original.bin", original), inputFile(patch.name, patch.bytes)]);
    await waitForEnabled(page, "rom-weaver-button-export-weave");
    await page.getByRole("button", { name: "Options", exact: true }).click();
    await page.locator("#rom-weaver-weave-export-weave-rom").check();
    await page.locator("#rom-weaver-button-export-weave").click();
    const recipe = await downloadedBytes(page, () =>
      page.locator("#rom-weaver-button-export-weave[data-downloadable]").click(),
    );
    requireJourney(recipe.name.endsWith(".zip"), `Weave: expected ZIP, received ${recipe.name}`);
    const recipePicker = await openWorkflow(page, baseUrl, "apply-patches", "rom-weaver-input-file-unified");
    await recipePicker.setInputFiles(inputFile(recipe.name, recipe.bytes));
    await page.locator("#rom-weaver-list-patch-stack .file").waitFor({ state: "visible" });
    await waitForEnabled(page, "rom-weaver-button-apply");
    const rewoven = await downloadedBytes(page, () => page.locator("#rom-weaver-button-apply").click());
    assertJourneyBytes(rewoven.bytes, modified, "Weave export -> Apply exact roundtrip");
    await runCombinedPatchRoundtrips(page, baseUrl, configureUncompressedOutput);
    requireJourney(failures.length === 0, `Create/Apply uncaught page errors: ${failures.join("; ")}`);
    process.stdout.write(`PASS Create -> Apply BPS roundtrip (${original.length} -> ${output.bytes.length} bytes)\n`);
    process.stdout.write("PASS Weave export with ROM -> Apply exact roundtrip\n");
  } finally {
    await context.close();
  }
};

export const runChecksumJourney = async (createContext, baseUrl) => {
  const context = await createContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const { original } = makeJourneyInputs();
  try {
    const picker = await openWorkflow(page, baseUrl, "checksum", "checksum-input-picker");
    await picker.setInputFiles(inputFile("checksum.bin", original));
    for (const algorithm of ["md5", "sha1"]) {
      await page.locator("#checksum-results").getByText(digest(algorithm, original), { exact: true }).waitFor();
    }
    await page.locator("#checksum-algo-sha256").check();
    await waitForEnabled(page, "checksum-calculate");
    await page.locator("#checksum-calculate").click();
    const expected = digest("sha256", original);
    await page.locator("#checksum-results").getByText(expected, { exact: true }).waitFor();
    const comparison = page.locator("#checksum-compare-input");
    await comparison.fill("0".repeat(64));
    await page
      .locator("#checksum-compare-verdict")
      .getByText(/No computed checksum matches/)
      .waitFor();
    await comparison.fill(expected);
    await page
      .locator("#checksum-compare-verdict")
      .getByText(/Match:/)
      .waitFor();
    process.stdout.write("PASS checksum MD5/SHA-1/SHA-256 and mismatch recovery\n");
  } finally {
    await context.close();
  }
};

export const runCompressExtractRoundtrip = async (createContext, baseUrl) => {
  const context = await createContext({ acceptDownloads: true, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const { original, modified } = makeJourneyInputs();
  try {
    const picker = await openWorkflow(page, baseUrl, "compress", "compress-input-picker");
    await picker.setInputFiles([inputFile("original.bin", original), inputFile("modified.bin", modified)]);
    const container = page.locator("#compress-container");
    await container.getByRole("combobox").first().selectOption("zip");
    await container.getByRole("button", { name: /^Compress$/ }).click();
    const archive = await downloadedBytes(page, () => container.getByRole("button", { name: /^Download/ }).click());
    requireJourney(archive.name.endsWith(".zip"), `Compress: expected ZIP, received ${archive.name}`);
    const extractPicker = await openWorkflow(page, baseUrl, "extract", "extract-input-picker");
    const extraction = page.locator("#extract-container");
    await extractPicker.setInputFiles(inputFile("broken.zip", Buffer.from("not a valid zip archive")));
    await extraction.getByRole("alert").waitFor();
    requireEqual(
      await extraction.getByRole("button", { name: /^Download/ }).count(),
      0,
      "Invalid archive left downloadable output",
    );
    await extractPicker.setInputFiles(inputFile(archive.name, archive.bytes));
    const rows = extraction.locator("label.pick-row");
    await rows.filter({ hasText: "original.bin" }).waitFor();
    await rows.filter({ hasText: "modified.bin" }).waitFor();
    await extraction.getByRole("alert").waitFor({ state: "hidden" });
    for (const [name, expected] of [
      ["original.bin", original],
      ["modified.bin", modified],
    ]) {
      for (const row of await rows.all()) {
        if (await row.getByRole("checkbox").isChecked()) await row.click();
      }
      await rows.filter({ hasText: name }).click();
      const output = await downloadedBytes(page, () =>
        extraction.getByRole("button", { name: "Download 1 file", exact: true }).click(),
      );
      requireEqual(output.name, name);
      assertJourneyBytes(output.bytes, expected, `Compress -> Extract ${String(name)}`);
    }
    process.stdout.write("PASS Compress -> Extract two-file ZIP roundtrip and invalid archive recovery\n");
  } finally {
    await context.close();
  }
};

export const runTrimJourney = async (createContext, baseUrl, configureUncompressedOutput) => {
  const context = await createContext({ acceptDownloads: true, ignoreHTTPSErrors: true });
  await enableBetaTools(context);
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const input = makeTrimJourneyInput();
  try {
    const picker = await openWorkflow(page, baseUrl, "trim-rom", "trim-builder-input-file-unified");
    await configureUncompressedOutput(page);
    await picker.setInputFiles(inputFile("game.nds", input));
    await waitForEnabled(page, "trim-builder-button-run");
    const output = await downloadedBytes(page, async () => {
      await page.locator("#trim-builder-button-run").click();
      await page
        .getByRole("dialog", { name: "Trim this ROM?" })
        .getByRole("button", { name: "Trim ROM", exact: true })
        .click();
    });
    requireEqual(output.name, "game (trimmed).nds");
    assertJourneyBytes(output.bytes, input.subarray(0, 0x3000), "Trim NDS declared extent");
    process.stdout.write(`PASS Trim NDS (${input.length} -> ${output.bytes.length} exact bytes)\n`);
  } finally {
    await context.close();
  }
};

export const runSaveEditorJourney = async (createContext, baseUrl) => {
  const context = await createContext({ acceptDownloads: true, ignoreHTTPSErrors: true });
  await enableBetaTools(context);
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const original = makeSaveJourneyInput();
  const expected = Buffer.from(original);
  expected.set([0x06, 0x54, 0x32], 0x25f3);
  expected[0x3523] = ~expected.subarray(0x2598, 0x3523).reduce((sum, byte) => sum + byte, 0) & 0xff;
  try {
    const picker = await openWorkflow(page, baseUrl, "save-editor", "save-editor-input-picker");
    await picker.setInputFiles(inputFile("red.sav", original));
    const editor = page.locator("#save-editor-container");
    await editor.getByRole("button", { name: "Choose game profile", exact: true }).click();
    await editor.getByRole("combobox", { name: "Game profile" }).selectOption("pokemon-red");
    await editor.getByRole("button", { name: "Open profile", exact: true }).click();
    const money = editor.locator('[id="save-field-trainer.money"]');
    await money.fill("65432");
    const output = await downloadedBytes(page, () =>
      editor.getByRole("button", { name: "Download edited copy", exact: true }).click(),
    );
    assertJourneyBytes(output.bytes, expected, "Save Editor money and repaired checksum");
    await picker.setInputFiles(inputFile(output.name, output.bytes));
    await editor.getByRole("button", { name: "Choose game profile", exact: true }).click();
    await editor.getByRole("combobox", { name: "Game profile" }).selectOption("pokemon-red");
    await editor.getByRole("button", { name: "Open profile", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("save-field-trainer.money")?.value === "65432");
    process.stdout.write("PASS Save Editor money edit, checksum repair, exact preservation and reopen\n");
  } finally {
    await context.close();
  }
};
