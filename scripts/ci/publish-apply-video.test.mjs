import assert from "node:assert/strict";
import { test } from "node:test";
import { replaceApplyVideo } from "./publish-apply-video.mjs";

const url = "https://github.com/user-attachments/assets/558b4f4d-640c-410e-a866-cd9ff97ac84c";
const start = "<!-- apply-video:start -->";
const end = "<!-- apply-video:end -->";

test("refreshes only the demo and preserves surrounding README content", () => {
  const source = `intro\n${start}\nold video\n${end}\nremaining docs\n`;
  const result = replaceApplyVideo(source, url);
  assert.equal(
    result,
    `intro\n${start}\nApply two sample patches and download the result as 7z.\n\n<${url}>\n${end}\nremaining docs\n`,
  );
  assert.equal(replaceApplyVideo(result, url), result);
});

test("rejects absent, duplicate, and reversed markers", () => {
  for (const source of [
    "",
    start,
    end,
    `${end}${start}`,
    `${start}${start}${end}`,
    `${start}${end}${end}`,
  ]) {
    assert.throws(() => replaceApplyVideo(source, url), /marker/);
  }
});

test("rejects invalid upload responses before rewriting README", () => {
  for (const value of [
    undefined,
    "",
    "https://example.com/video.mp4",
    `${url}\nmalicious markdown`,
    `${url}?token=secret`,
  ]) {
    assert.throws(() => replaceApplyVideo(`${start}${end}`, value), /attachment URL/);
  }
});
