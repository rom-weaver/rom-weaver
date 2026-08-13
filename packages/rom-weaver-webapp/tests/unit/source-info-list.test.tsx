// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { SourceInfoList } from "../../src/public/react/components/ds/source-info-list.tsx";

it("keeps the ROM name out of the Checks drawer", () => {
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
    />,
  );

  const expected = container.querySelector("#rom-weaver-rom-expected-checks");
  expect(expected?.querySelector('[aria-label="Copy NAME"]')).toBeNull();
  expect(expected?.querySelector('[aria-label="Copy CRC32"] .ck-mark')?.classList).toContain("ok");
  expect(expected?.querySelector('[aria-label="Copy BYTES"] .ck-mark')?.classList).toContain("ok");
});
