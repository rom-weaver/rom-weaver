import assert from "node:assert/strict";
import test from "node:test";

import { removeWorktree } from "./remove-worktree.mjs";

test("requires a worktree path", () => assert.throws(() => removeWorktree(undefined), /usage:/));

// Silently ignoring a second path is how you remove one worktree while
// believing you removed two.
test("refuses more than one worktree", () => assert.throws(() => removeWorktree("/tmp/a", ["/tmp/b"]), /usage:/));

test("rejects a path that is not a directory", () => assert.throws(() => removeWorktree("/tmp/definitely-not-here-9f3d"), /not a directory/));
