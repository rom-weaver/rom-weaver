#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const { values } = parseArgs({
  options: {
    image: { type: "string" },
    kind: { type: "string" },
    docs: { type: "string", default: "docs/hosting/self-hosting.md" },
  },
});
assert.ok(values.image, "--image is required");
assert.ok(["cli", "webapp"].includes(values.kind), "--kind must be cli or webapp");
const scratchRoot = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "agents",
  "scratch",
);
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(join(scratchRoot, "docker-smoke-"));
// The image's non-root UID MUST be able to write synthetic fixture outputs on Linux bind mounts.
await chmod(scratch, 0o777);
process.env.TMPDIR = scratch;
const id = `rom-weaver-smoke-${process.pid}-${Date.now()}`;
const containers = [];
let networkCreated = false;
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  }).trim();
const docker = (...args) => run("docker", args);
const expected = Buffer.concat([Buffer.from([0xaa]), Buffer.alloc(63)]);

async function fixtures() {
  await writeFile(join(scratch, "source.bin"), Buffer.alloc(64));
  await writeFile(join(scratch, "patch.ips"), Buffer.from("50415443480000000001aa454f46", "hex"));
  const recipe = JSON.stringify({
    version: 1,
    patches: [{ path: "patch.ips" }],
    output: { name: "patched.bin" },
  });
  for (const alias of ["weave", "bundle"])
    await writeFile(join(scratch, `rom-weaver-${alias}.json`), recipe);
  run("python3", [
    "-c",
    `import pathlib,sys,zipfile,gzip
p=pathlib.Path(sys.argv[1])
for alias in ['weave','bundle']:
 name='rom-weaver-'+alias+'.json'
 with gzip.open(p/(name+'.gz'),'wb') as f: f.write((p/name).read_bytes())
 with zipfile.ZipFile(p/(alias+'.zip'),'w') as z:
  z.write(p/name,name)
  z.write(p/'patch.ips','patch.ips')`,
    scratch,
  ]);
}

function cli(...args) {
  const output = docker(
    "run",
    "--rm",
    "--mount",
    `type=bind,source=${scratch},target=/work`,
    values.image,
    ...args,
    "--jsonl",
  );
  const events = output.split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).status, "succeeded", output);
  return events.at(-1);
}

async function checkCli() {
  for (const alias of ["weave", "bundle"]) {
    for (const input of [
      "rom-weaver-weave.json",
      "rom-weaver-bundle.json",
      "rom-weaver-weave.json.gz",
      "rom-weaver-bundle.json.gz",
      "weave.zip",
      "bundle.zip",
    ]) {
      const { details } = cli(alias, "parse", "--input", input);
      assert.deepEqual(details.bundle.bundle, details.weave.weave);
      assert.equal(details.bundle.bundle.version, 1);
      console.log(`PASS ${alias} parse ${input}`);
    }
    for (const flag of ["--weave", "--bundle"]) {
      const stem = `${alias}-${flag.slice(2)}`;
      cli(
        alias,
        "create",
        "--input",
        "source.bin",
        "--patch",
        "patch.ips",
        "--output",
        `${stem}.json`,
        flag,
        `${stem}.zip`,
      );
      run("python3", [
        "-c",
        `import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.read('rom-weaver-weave.json') == z.read('rom-weaver-bundle.json')`,
        join(scratch, `${stem}.zip`),
      ]);
      cli(
        "patch",
        "apply",
        "--input",
        "source.bin",
        flag,
        `${stem}.zip`,
        "--output",
        `${stem}.bin`,
        "--no-compress",
      );
      assert.deepEqual(await readFile(join(scratch, `${stem}.bin`)), expected);
      console.log(`PASS ${alias} create / patch apply ${flag}, dual recipes and exact bytes`);
    }
  }
  cli(
    "weave",
    "--input",
    "source.bin",
    "--weave",
    "bundle.zip",
    "--output",
    "legacy-weave.bin",
    "--no-compress",
  );
  assert.deepEqual(await readFile(join(scratch, "legacy-weave.bin")), expected);
  console.log("PASS legacy bare weave invocation");
}

async function start(name, image, extra = []) {
  const container = `${id}-${name}`;
  containers.push(container);
  docker(
    "run",
    "--detach",
    "--name",
    container,
    "--network",
    id,
    "--publish",
    "0.0.0.0::8080",
    ...extra,
    image,
  );
  const port = docker(
    "inspect",
    "--format",
    '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}',
    container,
  );
  return { container, origin: `http://127.0.0.1:${port}` };
}

async function healthy(container) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const state = JSON.parse(docker("inspect", "--format", "{{json .State}}", container));
    if (!state.Running) assert.fail(docker("logs", container));
    if (state.Health?.Status === "healthy") return;
    assert.notEqual(state.Health?.Status, "unhealthy", JSON.stringify(state.Health));
    await delay(1000);
  }
  assert.fail(`healthcheck timed out: ${container}`);
}

const routes = {
  apply: "apply-patches",
  "apply-patch": "apply-patches",
  weave: "weave-patches",
  bundle: "weave-patches",
  "bundle-patches": "weave-patches",
  create: "create-patch",
  identify: "identify-rom",
  test: "test-rom",
  trim: "trim-rom",
};
const queries = [
  "",
  "?patch=a%2Bb&patch=c&weave=https%3A%2F%2Fexample.com%2Fa.json",
  "?bundle=old.json&x=one+two&x=%26",
];
async function redirects(origin, prefix) {
  let count = 0;
  for (const [old, destination] of Object.entries(routes)) {
    for (const suffix of ["", "/", ".html", "/index.html"]) {
      for (const query of queries) {
        const response = await fetch(`${origin}${prefix}/${old}${suffix}${query}`, {
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        assert.equal(response.status, 301, `${prefix}/${old}${suffix}`);
        const location = new URL(response.headers.get("location"), origin);
        assert.equal(location.origin, origin);
        assert.equal(location.pathname + location.search, `${prefix}/${destination}${query}`);
        await response.body?.cancel();
        count++;
      }
    }
  }
  console.log(`PASS ${count} redirects: ${prefix || "root"}`);
}

async function checkBrowser(origins) {
  const require = createRequire(resolve("packages/rom-weaver-webapp/package.json"));
  const { chromium } = require("playwright");
  const browser = await chromium.launch({
    headless: true,
    env: { ...process.env, TMPDIR: scratch },
  });
  try {
    for (const { origin, prefix } of origins) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      for (const alias of ["weave", "bundle", "bundle-patches"]) {
        await page.goto(`${origin}${prefix}/${alias}?check=a%2Bb&check=c`, {
          waitUntil: "domcontentloaded",
        });
        await page
          .locator("#rom-weaver-input-file-unified-weave")
          .waitFor({ state: "attached", timeout: 60_000 });
        assert.equal(new URL(page.url()).pathname, `${prefix}/weave-patches`);
        assert.equal(new URL(page.url()).search, "?check=a%2Bb&check=c");
        assert.equal(await page.evaluate(() => crossOriginIsolated), true);
      }
      await page.goto(`${origin}${prefix}/apply-patches`, { waitUntil: "domcontentloaded" });
      const input = page.locator("#rom-weaver-input-file-unified");
      await input.waitFor({ state: "attached", timeout: 60_000 });
      await input.setInputFiles([join(scratch, "source.bin"), join(scratch, "bundle.zip")]);
      await page
        .locator('#rom-weaver-list-patch-stack [data-file-name="patch.ips"]')
        .waitFor({ state: "visible", timeout: 60_000 });
      let download;
      try {
        [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 90_000 }),
          page
            .getByRole("button", { name: /Apply & download/i })
            .first()
            .click({ timeout: 60_000 }),
        ]);
      } catch (error) {
        console.error(await page.locator("body").innerText(), errors);
        throw error;
      }
      const output = join(scratch, "download.zip");
      await download.saveAs(output);
      run("python3", [
        "-c",
        `import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
 assert any(z.read(name)==bytes([170])+bytes(63) for name in z.namelist())`,
        output,
      ]);
      assert.deepEqual(errors, []);
      console.log(
        `PASS browser aliases, isolation, legacy archive apply and exact download bytes: ${origin}${prefix}`,
      );
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

async function checkWebapp() {
  docker("network", "create", id);
  networkCreated = true;
  const web = await start("web", values.image);
  const tls = await start("tls", values.image, ["--env", "HTTPS_PORT=8443"]);
  await Promise.all([healthy(web.container), healthy(tls.container)]);
  assert.notEqual(docker("exec", web.container, "id", "-u"), "0");
  for (const [vars, code] of [
    [["HTTPS_CERT=/missing"], 64],
    [["HTTPS_CERT=/missing", "HTTPS_KEY=/missing"], 66],
  ]) {
    assert.throws(
      () =>
        docker(
          "run",
          "--rm",
          "--env",
          "HTTPS_PORT=8443",
          ...vars.flatMap((value) => ["--env", value]),
          values.image,
        ),
      (error) => error.status === code,
    );
  }
  const markdown = await readFile(values.docs, "utf8");
  const block = /```nginx\n([\s\S]*?)```/.exec(markdown)?.[1];
  assert.ok(block, "the self-hosting guide must include its Nginx configuration");
  const config = `server { listen 8080; absolute_redirect off;\n${block.replaceAll("127.0.0.1:8080", `${web.container}:8080`)}\n}\n`;
  const configPath = join(scratch, "nginx.conf");
  await writeFile(configPath, config);
  const proxy = await start("proxy", "nginx:alpine", [
    "--mount",
    `type=bind,source=${configPath},target=/etc/nginx/conf.d/default.conf,readonly`,
  ]);
  docker("exec", proxy.container, "nginx", "-t");
  await redirects(web.origin, "");
  await redirects(proxy.origin, "/rom-weaver");
  for (const query of queries) {
    const response = await fetch(`${proxy.origin}/rom-weaver${query}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get("location"), `/rom-weaver/${query}`);
    await response.body?.cancel();
  }
  for (const path of [
    "/",
    "/weave-patches",
    "/rom-weaver-bundle-v1.schema.json",
    "/rom-weaver-bundle-v2.schema.json",
    "/rom-weaver-weave-v1.schema.json",
    "/rom-weaver-weave-v2.schema.json",
    "/openapi.json",
    "/.well-known/api-catalog",
  ]) {
    const response = await fetch(web.origin + path, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
    if (path.endsWith(".json")) await response.json();
    else await response.body?.cancel();
  }
  await checkBrowser([
    { origin: web.origin, prefix: "" },
    { origin: proxy.origin, prefix: "/rom-weaver" },
    { origin: tls.origin.replace("http:", "https:"), prefix: "" },
  ]);
}

try {
  await fixtures();
  if (values.kind === "cli") await checkCli();
  else await checkWebapp();
  console.log(`PASS Docker ${values.kind} smoke: ${values.image}`);
} finally {
  for (const container of containers.reverse()) docker("rm", "--force", container);
  if (networkCreated) docker("network", "rm", id);
  await rm(scratch, { recursive: true, force: true });
}
