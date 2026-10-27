import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { chromium } from "playwright";
import { syntheticNfs } from "../fixtures/synthetic-nfs.mjs";

const packageDir = fileURLToPath(new URL("../..", import.meta.url));
const expectedSize = 1459978240;
const expectedSha256 = "9767fa2424d10cda1fe3ff950d08dfd4cbfc9aa5dd04f3c72ebd7f647731dcb4";

const storedZip = async (files) => {
  const local = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const bytes = Buffer.from(await file.arrayBuffer());
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, bytes);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    header.copy(directory, 16, 14, 26);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
};

const pickerFile = async (file) => ({
  name: file.name,
  mimeType: "application/octet-stream",
  buffer: Buffer.from(await file.arrayBuffer()),
});

test("production Apply preserves supplied NFS keys and native output parity", { timeout: 480000 }, async (t) => {
  const scratchRoot =
    process.env.ROM_WEAVER_NFS_E2E_ARTIFACT_DIR ||
    path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "agents/scratch");
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(path.join(scratchRoot, "nfs-apply-"));
  t.diagnostic(`artifacts: ${scratch}`);
  const listener = net.createServer();
  listener.listen(0, "0.0.0.0");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  const server = spawn(process.execPath, ["scripts/dev-server.mjs", "preview", "--port", String(port)], {
    cwd: packageDir,
    env: { ...process.env, ROM_WEAVER_CHANNEL: "prod" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  let context;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`preview startup timeout: ${serverOutput}`)), 30000);
      const consume = (chunk) => {
        serverOutput += chunk;
        if (serverOutput.includes(`https://localhost:${port}`)) {
          clearTimeout(timer);
          resolve();
        }
      };
      server.stdout.on("data", consume);
      server.stderr.on("data", consume);
      server.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      server.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`preview exited ${code}: ${serverOutput}`));
      });
    });
    context = await chromium.launchPersistentContext(path.join(scratch, "profile"), {
      headless: true,
      args: ["--unlimited-storage"],
      acceptDownloads: true,
      ignoreHTTPSErrors: true,
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    for (const archived of [false, true]) {
      await t.test(archived ? "selected ZIP NFS" : "loose NFS", { timeout: 210000 }, async () => {
        const label = archived ? "zip" : "loose";
        const page = await context.newPage();
        page.setDefaultTimeout(60000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.goto(`https://localhost:${port}/apply`, { waitUntil: "domcontentloaded" });
          const picker = page.locator("#rom-weaver-input-file-unified");
          await picker.waitFor({ state: "attached" });
          await page
            .locator(".shell-head-tools .settings-tool:visible, .topbar-tools .settings-tool:visible")
            .first()
            .click();
          await page.locator("#settings-default-compression").selectOption("none");
          const advanced = page.getByRole("switch", { name: /^Advanced/ });
          if ((await advanced.getAttribute("aria-checked")) === "false") await advanced.click();
          await page.locator("#settings-worker-threads").fill("2");
          await page.locator(".settings-actions .btn.primary:visible").click();
          const { source, key } = await syntheticNfs();
          if (archived) {
            const zip = await storedZip([source, key, new File(["other"], "other.nes")]);
            await picker.setInputFiles({ name: "nfs-with-key.zip", mimeType: "application/zip", buffer: zip });
            const selection = page.locator(".rw-modal.select-modal .seltree");
            await selection.getByRole("button").filter({ hasText: "hif_000000.nfs" }).click();
          } else {
            await picker.setInputFiles([await pickerFile(key), await pickerFile(source)]);
          }
          await page.getByText("hif_000000.iso", { exact: true }).first().waitFor();
          await page.screenshot({ path: path.join(scratch, `${label}-staged.png`) });
          await picker.setInputFiles({
            name: "change.ips",
            mimeType: "application/octet-stream",
            buffer: Buffer.from([0x50, 0x41, 0x54, 0x43, 0x48, 0, 0, 100, 0, 1, 255, 0x45, 0x4f, 0x46]),
          });
          const apply = page.locator("#rom-weaver-button-apply");
          await page.waitForFunction(() => {
            const button = document.getElementById("rom-weaver-button-apply");
            return button instanceof HTMLButtonElement && !button.disabled && /apply/i.test(button.textContent);
          });
          const [download] = await Promise.all([page.waitForEvent("download", { timeout: 180000 }), apply.click()]);
          assert.match(download.suggestedFilename(), /\.iso$/i);
          const outputPath = path.join(scratch, `${label}-patched.iso`);
          await download.saveAs(outputPath);
          const hash = createHash("sha256");
          let bytes = 0;
          for await (const chunk of createReadStream(outputPath, { highWaterMark: 64 * 1024 })) {
            hash.update(chunk);
            bytes += chunk.length;
          }
          assert.equal(bytes, expectedSize);
          assert.equal(hash.digest("hex"), expectedSha256);
          assert.deepEqual(errors, []);
          await page.screenshot({ path: path.join(scratch, `${label}-success.png`) });
          await rm(outputPath);
        } catch (error) {
          await page.screenshot({ path: path.join(scratch, `${label}-failure.png`) });
          t.diagnostic((await page.locator("body").innerText()).slice(-12000));
          throw error;
        } finally {
          await page.close();
        }
      });
    }
  } finally {
    await context?.close();
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      const forceStop = setTimeout(() => server.kill("SIGKILL"), 5000);
      server.kill("SIGTERM");
      try {
        await exited;
      } finally {
        clearTimeout(forceStop);
      }
    }
    await rm(path.join(scratch, "profile"), { recursive: true, force: true });
  }
});
