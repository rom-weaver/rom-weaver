import assert from "node:assert/strict";
import test from "node:test";

import { planLegs } from "./docker-matrix.mjs";

const legNames = (env) => planLegs(env).map(({ name, arch }) => `${name}/${arch}`);

test("an unselected image contributes no leg", () => {
  assert.deepEqual(planLegs({}), []);
  assert.deepEqual(legNames({ CLI_SELECTED: "true", CLI_ARM64: "true" }), [
    "CLI/amd64",
    "CLI/arm64",
  ]);
  assert.deepEqual(legNames({ WEBAPP_SELECTED: "true", WEBAPP_ARM64: "true" }), [
    "webapp/amd64",
    "webapp/arm64",
  ]);
});

// The arm64 half is another full compile on another runner, so it is selected
// separately - see `classify-changes.mjs`.
test("an image without its arm64 flag builds amd64 alone", () => {
  assert.deepEqual(legNames({ CLI_SELECTED: "true" }), ["CLI/amd64"]);
  assert.deepEqual(legNames({ CLI_SELECTED: "true", CLI_ARM64: "false" }), ["CLI/amd64"]);
  assert.deepEqual(legNames({ WEBAPP_SELECTED: "true", WEBAPP_ARM64: "" }), ["webapp/amd64"]);
});

test("the arm64 flags are per image", () =>
  assert.deepEqual(
    legNames({
      CLI_SELECTED: "true",
      CLI_ARM64: "false",
      WEBAPP_SELECTED: "true",
      WEBAPP_ARM64: "true",
    }),
    ["CLI/amd64", "webapp/amd64", "webapp/arm64"],
  ));

// An arm64 flag on its own must not conjure a leg: the image's own selector is
// what decides whether it is built at all.
test("an arm64 flag alone selects nothing", () =>
  assert.deepEqual(planLegs({ CLI_ARM64: "true", WEBAPP_ARM64: "true" }), []));

test("each leg carries the runner and Dockerfile the job needs", () => {
  const [cli] = planLegs({ CLI_SELECTED: "true" });
  assert.deepEqual(cli, {
    name: "CLI",
    image: "rom-weaver-cli",
    file: "Dockerfile",
    arch: "amd64",
    runner: "ubuntu-24.04",
  });
  const [, webappArm] = planLegs({ WEBAPP_SELECTED: "true", WEBAPP_ARM64: "true" });
  assert.deepEqual(webappArm, {
    name: "webapp",
    image: "rom-weaver-webapp",
    file: "packages/rom-weaver-webapp/Dockerfile",
    arch: "arm64",
    runner: "ubuntu-24.04-arm",
  });
});
