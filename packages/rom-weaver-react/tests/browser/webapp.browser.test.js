import { beforeEach, expect, test } from "vitest";

beforeEach(() => {
  document.body.innerHTML = '<div id="webapp-root" aria-busy="true"></div>';
});

test("webapp entry mounts a patcher-only screen", async () => {
  await import("../../src/webapp/main.tsx");

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();
  expect(document.getElementById("rom-weaver-input-file-patch")).not.toBeNull();
  expect(document.getElementById("rom-weaver-button-apply")).not.toBeNull();

  expect(document.getElementById("workflow-tabs")).toBeNull();
  expect(document.getElementById("app-update-banner")).toBeNull();
  expect(document.querySelector("footer")).toBeNull();
});
