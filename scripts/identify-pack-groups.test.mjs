import assert from "node:assert/strict";
import test from "node:test";
import { resolveIdentifyPackGroups } from "./identify-pack-groups.mjs";

test("keeps only declared default groups in the default set", () => {
  const index = {
    groups: [
      { default: true, id: "core", label: "Core", systems: ["nes"] },
      { default: false, id: "computers", label: "Computers", systems: ["c64"] },
    ],
    systems: [{ slug: "c64" }, { slug: "nes" }],
  };
  const result = resolveIdentifyPackGroups(index);
  assert.deepEqual(
    result.defaultSystems.map(({ slug }) => slug),
    ["nes"],
  );
  assert.equal(result.assignments.get("c64"), "computers");
});

test("treats an ungrouped legacy index as one default group", () => {
  const result = resolveIdentifyPackGroups({ systems: [{ slug: "gba" }] });
  assert.deepEqual(
    result.defaultSystems.map(({ slug }) => slug),
    ["gba"],
  );
  assert.equal(result.groups[0].default, true);
});
