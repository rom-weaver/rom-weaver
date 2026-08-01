// @vitest-environment happy-dom
import { render } from "@testing-library/preact";
import { expect, it } from "vitest";
import { SourceInfoList } from "../../src/public/react/components/ds/source-info-list.tsx";

it("keeps the advisory ROM name separate from strict checksum variant matching", () => {
  const { container } = render(
    <SourceInfoList
      bytes={1024}
      checksums={{ crc32: "aaaaaaaa" }}
      checksumVariants={[
        {
          checksums: { crc32: "bbbbbbbb" },
          id: "remove-header",
          label: "Headerless",
          transforms: { removeHeader: { strippedBytes: 512 } },
        },
      ]}
      defaultOpen
      expected={{ checksums: { crc32: "bbbbbbbb" }, name: "expected.sfc", size: 512 }}
      fileName="renamed.smc"
    />,
  );

  const expected = container.querySelector("#rom-weaver-rom-expected-checks");
  expect(expected?.querySelector('[aria-label="Copy NAME"] .ck-mark')?.classList).toContain("bad");
  expect(expected?.querySelector('[aria-label="Copy CRC32"] .ck-mark')?.classList).toContain("ok");
  expect(expected?.querySelector('[aria-label="Copy BYTES"] .ck-mark')?.classList).toContain("ok");
  expect(container.querySelector(".expected-mismatch-info")).not.toBeNull();
});
