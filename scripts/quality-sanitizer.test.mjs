import assert from "node:assert/strict";
import test from "node:test";
import {
  instrumentedArchive,
  sanitizerEnvironment,
  sanitizerArgs,
  selectedSanitizerTests,
} from "./quality-sanitizer.mjs";
test("sanitizer lane instruments C/C++ and Rust in an isolated build directory", () => {
  const env = sanitizerEnvironment("/scratch", {
    CARGO_TARGET_DIR: "/ordinary",
    RUSTFLAGS: "wrong",
    CARGO_ENCODED_RUSTFLAGS: "wrong",
    KEEP: "yes",
  });
  assert.equal(env.CARGO_TARGET_DIR, "/scratch/target");
  assert.equal(env.CC, "clang-18");
  assert.equal(env.CXX, "clang++-18");
  assert.match(env.CFLAGS, /address,undefined/);
  assert.match(env.RUSTFLAGS, /-Zsanitizer=address/);
  assert.equal(env.KEEP, "yes");
  assert.ok(!("CARGO_ENCODED_RUSTFLAGS" in env));
});
test("native instrumentation is checked rather than inferred from flags", () => {
  assert.deepEqual(
    instrumentedArchive("U __asan_report_load8\nU __ubsan_handle_type_mismatch_v1"),
    { address: true, undefined: true },
  );
  assert.throws(() => instrumentedArchive("U malloc"), /missing/);
  assert.throws(() => instrumentedArchive("U __asan_report_load8"), /missing/);
});

test("sanitizer discovery selects the actual Rust module, not its filename", () => {
  const args = sanitizerArgs();
  assert.ok(args.includes("libarchive::"));
  assert.ok(!args.includes("libarchive_entries"));
  assert.ok(args.includes("--lib"));
});

test("native boundary discovery cannot silently omit the SDK or entries suite", () => {
  const entries = "libarchive::entries::tests::bounded_handles: test";
  const sdk = "libarchive::tests::seven_zip_write_then_low_level_read_round_trips_payload: test";
  const codec = "handlers_tests::tests::seven_z_short_period_matches_round_trip: test";
  assert.equal(selectedSanitizerTests(`${entries}\n${sdk}\n${codec}\n`).length, 3);
  assert.throws(() => selectedSanitizerTests(""), /no tests/);
  assert.throws(
    () => selectedSanitizerTests(`${entries}\n${sdk}`),
    /omitted required native boundary/,
  );
  assert.throws(() => selectedSanitizerTests(sdk), /omitted required native boundary/);
  assert.throws(
    () => selectedSanitizerTests(`${entries}\n${sdk.replace(": test", ": benchmark")}`),
    /omitted/,
  );
});
