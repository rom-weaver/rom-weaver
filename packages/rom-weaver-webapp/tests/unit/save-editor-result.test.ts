import { describe, expect, it } from "vitest";
import { parseSaveEditorResult } from "../../src/lib/runtime/save-editor-result.ts";

const unsupported = { candidates: [], outcome: { unsupported: { reasons: [] } }, reasons: [] };

describe("parseSaveEditorResult", () => {
  it("reads the save size, the container, and the potential format", () => {
    const parsed = parseSaveEditorResult({
      save_editor: {
        container: { kind: "desmume_dsv", name: "DeSmuME save (.dsv)" },
        file_size: 65_658,
        potential_format: "Flash 64 KiB (Game Boy Advance)",
        potential_formats: [{ id: "gba_flash_64k" }],
        recognition: unsupported,
        save_size: 65_536,
      },
    });
    expect(parsed.saveSize).toBe(65_536);
    expect(parsed.containerName).toBe("DeSmuME save (.dsv)");
    expect(parsed.potentialFormat).toBe("Flash 64 KiB (Game Boy Advance)");
  });

  it("leaves the container out for a raw save", () => {
    const parsed = parseSaveEditorResult({
      save_editor: { container: null, recognition: unsupported, save_size: 512 },
    });
    expect(parsed.containerName).toBeUndefined();
    expect(parsed.potentialFormat).toBeUndefined();
  });
});
