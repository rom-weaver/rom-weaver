// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { beforeAll, expect, it } from "vitest";
import { loadCatalog } from "../../src/presentation/localization/catalog.ts";
import { RomWeaverSettingsProvider } from "../../src/public/react/settings-context.tsx";
import { SourceInfoList } from "../../src/public/react/components/ds/source-info-list.tsx";

beforeAll(async () => {
  await loadCatalog("de");
});

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

it("localizes an expected-ROM mismatch without changing checksum row markers", () => {
  const { container } = render(
    <RomWeaverSettingsProvider settings={{ language: "de" }}>
      <SourceInfoList
        bytes={1024}
        checksums={{ crc32: "aaaaaaaa" }}
        defaultOpen
        expected={{ checksums: { crc32: "bbbbbbbb" }, size: 1024 }}
      />
    </RomWeaverSettingsProvider>,
  );

  expect(container.textContent).toContain("Erwartet");
  expect(container.querySelector(".expected-mismatch-info .info-btn")?.getAttribute("aria-label")).toBe(
    "Nicht die erwartete ROM",
  );
  const expectedGroup = container.querySelector("#rom-weaver-rom-expected-checks");
  const checksumRow = (label: string) =>
    [...(expectedGroup?.querySelectorAll<HTMLElement>(".ck") || [])].find(
      (row) => row.querySelector(".ck-k")?.textContent === label,
    );
  const bytesRow = checksumRow("BYTES");
  expect(bytesRow?.classList).toContain("ck-half");
  expect(checksumRow("CRC32")?.querySelector(".ck-mark")?.classList).toContain("bad");
  expect(bytesRow?.querySelector(".ck-mark")?.classList).toContain("ok");
});
