// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RomWeaverSettingsProvider } from "../../../src/public/react/settings-context.tsx";
import { ChecksumForm } from "../../../src/webapp/components/checksum-form.tsx";

const CRC32 = "a1b2c3d4";
const SHA256 = "5".repeat(64);

const readyInput = (checksums: Record<string, string>) => ({
  candidates: [],
  fileName: "game.sfc",
  files: [{ checksums, fileName: "game.sfc", id: "rom", size: 16 }],
  id: "input-1",
  parentCompressions: [],
  selectedCandidateId: "a",
  size: 16,
  status: "ready",
  warnings: [],
});

const workflow = vi.hoisted(() => ({
  calculate: vi.fn(),
  instances: [] as unknown[],
  setInput: vi.fn(),
}));

vi.mock("../../../src/public/react/workflow-loader.ts", () => {
  class ChecksumWorkflow {
    input: unknown = null;
    constructor() {
      workflow.instances.push(this);
    }
    abort = vi.fn();
    calculate = (algorithms: string[]) => workflow.calculate(algorithms);
    dispose = vi.fn(async () => undefined);
    getInput = () => this.input;
    off = vi.fn();
    on = vi.fn();
    setInput = async (source: File) => {
      this.input = await workflow.setInput(source);
    };
  }
  return { loadBrowserApi: async () => ({ ChecksumWorkflow }) };
});

const addRom = () =>
  fireEvent.change(screen.getByLabelText("Drop a ROM to checksum it"), {
    target: { files: [new File(["rom"], "game.sfc")] },
  });

describe("ChecksumForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workflow.instances.length = 0;
    workflow.setInput.mockResolvedValue(readyInput({ crc32: CRC32, md5: "m".repeat(32), sha1: "s".repeat(40) }));
  });

  it("shows the staged checksums and calculates a newly selected algorithm", async () => {
    workflow.calculate.mockResolvedValue(
      readyInput({ crc32: CRC32, md5: "m".repeat(32), sha1: "s".repeat(40), sha256: SHA256 }),
    );
    render(<ChecksumForm />);

    addRom();

    expect((await screen.findAllByText(CRC32)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /^Calculate/ })).toBeNull();

    fireEvent.click(screen.getByLabelText("SHA-256"));
    fireEvent.click(await screen.findByRole("button", { name: "Calculate SHA-256" }));

    await waitFor(() => expect(workflow.calculate).toHaveBeenCalledWith(["crc32", "md5", "sha1", "sha256"]));
    expect(await screen.findByText(SHA256)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Calculate/ })).toBeNull();
  });

  it("compares a pasted checksum with the computed values", async () => {
    render(<ChecksumForm />);
    addRom();
    await screen.findAllByText(CRC32);
    const compare = screen.getByLabelText("Compare with an expected checksum");

    fireEvent.change(compare, { target: { value: ` 0x${CRC32.toUpperCase()} ` } });
    expect(screen.getByText("Match: the CRC32 of this ROM.")).toBeTruthy();

    fireEvent.change(compare, { target: { value: "e".repeat(40) } });
    expect(screen.getByText(/No computed checksum matches\. This is not the expected ROM/)).toBeTruthy();

    // CRC32C and Adler-32 share CRC32's length, so an 8-digit miss is not final.
    fireEvent.change(compare, { target: { value: "deadbeef" } });
    expect(screen.getByText(/Calculate CRC32C or Adler-32 to compare this value/)).toBeTruthy();

    fireEvent.change(compare, { target: { value: SHA256 } });
    expect(screen.getByText(/Calculate SHA-256 or BLAKE3 to compare this value/)).toBeTruthy();

    fireEvent.change(compare, { target: { value: "xyz" } });
    expect(screen.getByText(/contains only the digits 0-9/)).toBeTruthy();
  });

  it("names the variant a pasted checksum matches", async () => {
    workflow.setInput.mockResolvedValue({
      ...readyInput({ crc32: CRC32, md5: "m".repeat(32), sha1: "s".repeat(40) }),
      files: [
        {
          checksums: { crc32: CRC32, md5: "m".repeat(32), sha1: "s".repeat(40) },
          fileName: "game.sfc",
          id: "rom",
          size: 16,
          checksumVariants: [{ checksums: { crc32: "0badf00d" }, id: "headerless", label: "Headerless" }],
        },
      ],
    });
    render(<ChecksumForm />);
    addRom();
    await screen.findAllByText(CRC32);

    fireEvent.change(screen.getByLabelText("Compare with an expected checksum"), { target: { value: "0badf00d" } });

    expect(screen.getByText("Match: the CRC32 of this ROM (Headerless).")).toBeTruthy();
  });

  it("does not match a checksum whose algorithm is switched off", async () => {
    render(<ChecksumForm />);
    addRom();
    await screen.findAllByText(CRC32);

    fireEvent.click(screen.getByLabelText("CRC32"));
    fireEvent.change(screen.getByLabelText("Compare with an expected checksum"), { target: { value: CRC32 } });

    expect(screen.queryByText(/^Match:/)).toBeNull();
    expect(screen.getByText(/Calculate CRC32 or CRC32C or Adler-32 to compare this value/)).toBeTruthy();
  });

  it("keeps completed track checksums after a calculation is cancelled", async () => {
    const initial = readyInput({ crc32: CRC32, md5: "m".repeat(32), sha1: "s".repeat(40) });
    initial.files.push({ ...initial.files[0], fileName: "track02.bin", id: "track02" });
    workflow.setInput.mockResolvedValue(initial);
    workflow.calculate.mockImplementation(async () => {
      const [instance] = workflow.instances as Array<{ input: unknown }>;
      instance.input = {
        ...initial,
        files: [
          { ...initial.files[0], checksums: { ...initial.files[0].checksums, sha256: SHA256 } },
          initial.files[1],
        ],
      };
      throw Object.assign(new Error("cancelled"), { code: "CANCELLED" });
    });
    render(<ChecksumForm />);
    addRom();
    await screen.findAllByText(CRC32);
    fireEvent.click(screen.getByLabelText("SHA-256"));
    fireEvent.click(await screen.findByRole("button", { name: "Calculate SHA-256" }));

    expect(await screen.findByText(SHA256)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Calculate SHA-256" })).toBeTruthy();
  });

  it("reports an uncomputed digest on later tracks instead of a mismatch", async () => {
    const initial = readyInput({
      crc32: CRC32,
      md5: "a".repeat(32),
      sha1: "b".repeat(40),
      sha256: SHA256,
      blake3: "d".repeat(64),
    });
    workflow.setInput.mockResolvedValue({
      ...initial,
      files: [
        ...initial.files,
        { checksums: { ...initial.files[0].checksums, sha256: "" }, fileName: "track02.bin", id: "track02", size: 16 },
      ],
    });
    render(<ChecksumForm />);
    addRom();
    await screen.findAllByText(CRC32);
    fireEvent.click(screen.getByLabelText("SHA-256"));
    fireEvent.click(screen.getByLabelText("BLAKE3"));
    fireEvent.change(screen.getByLabelText("Compare with an expected checksum"), {
      target: { value: "c".repeat(64) },
    });

    expect(screen.getByText(/Calculate SHA-256 to compare this value/)).toBeTruthy();
  });

  it("keeps the staged ROM when the display settings change", async () => {
    const { rerender } = render(
      <RomWeaverSettingsProvider settings={{ byteUnits: "binary", language: "en" }}>
        <ChecksumForm />
      </RomWeaverSettingsProvider>,
    );
    addRom();
    await screen.findAllByText(CRC32);

    rerender(
      <RomWeaverSettingsProvider settings={{ byteUnits: "decimal", language: "en" }}>
        <ChecksumForm />
      </RomWeaverSettingsProvider>,
    );

    expect(screen.getAllByText(CRC32).length).toBeGreaterThan(0);
    expect(workflow.instances).toHaveLength(1);
    expect(workflow.setInput).toHaveBeenCalledTimes(1);
  });

  it("accepts a new ROM after the ROM is removed during a calculation", async () => {
    workflow.calculate.mockReturnValue(new Promise(() => undefined));
    render(<ChecksumForm />);
    addRom();
    await screen.findAllByText(CRC32);
    fireEvent.click(screen.getByLabelText("BLAKE3"));
    fireEvent.click(await screen.findByRole("button", { name: "Calculate BLAKE3" }));
    expect(await screen.findByRole("button", { name: "Cancel checksum" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove ROM" }));

    await waitFor(() =>
      expect((screen.getByLabelText("Drop a ROM to checksum it") as HTMLInputElement).disabled).toBe(false),
    );
  });

  it("disposes the staged workflow when the ROM is removed", async () => {
    render(<ChecksumForm />);
    addRom();
    await screen.findAllByText(CRC32);

    fireEvent.click(screen.getByRole("button", { name: "Remove ROM" }));

    const [instance] = workflow.instances as Array<{ dispose: ReturnType<typeof vi.fn> }>;
    await waitFor(() => expect(instance?.dispose).toHaveBeenCalled());
    expect(screen.queryByText("Compare with an expected checksum")).toBeNull();
  });
});
