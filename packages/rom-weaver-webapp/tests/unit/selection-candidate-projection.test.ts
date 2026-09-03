import { describe, expect, it } from "vitest";
import type { CandidateSelectionRequest } from "../../src/types/selection.ts";
import { projectSelectionCandidates } from "../../src/lib/workflow/selection-candidate-projection.ts";
import type { SharedRomSourceState, SharedRomStagedSource } from "../../src/lib/workflow/staged-source-types.ts";

describe("projectSelectionCandidates", () => {
  it("maps public ids, clones candidates, rewrites relationships, and keeps internal metadata", () => {
    const group = {
      breadcrumbs: ["bundle.zip"],
      candidateIds: ["child", "missing"],
      id: "group",
      kind: "multi-file-input" as const,
      label: "Patch files",
      path: "patches",
      selectable: true,
      type: "group" as const,
      warnings: ["nested archive"],
    };
    const child = {
      breadcrumbs: ["bundle.zip", "patches"],
      fileName: "child.ips",
      id: "child",
      kind: "patch" as const,
      parentCandidateId: "group",
      path: "patches/child.ips",
      selectable: true,
      type: "file" as const,
    };
    const hidden = {
      fileName: "hidden.txt",
      id: "hidden",
      kind: "unknown" as const,
      selectable: false,
      type: "file" as const,
    };
    const request: CandidateSelectionRequest = {
      candidates: [group, child, hidden],
      role: "patch",
      sourceName: "bundle.zip",
      warnings: [],
    };
    const owner = {
      index: 0,
      internalCandidates: new Map(),
      parentCompressions: [],
      source: {},
      state: { candidates: [], role: "patch", status: "loading" },
    } as unknown as SharedRomStagedSource<unknown, SharedRomSourceState>;

    let sequence = 0;
    const projected = projectSelectionCandidates({
      createPublicId: () => `public-${++sequence}`,
      owner,
      request,
    });

    expect(projected.candidates).toEqual([
      {
        ...group,
        candidateIds: ["public-2", "missing"],
        id: "public-1",
      },
      {
        ...child,
        id: "public-2",
        parentCandidateId: "public-1",
      },
      { ...hidden, id: "public-3" },
    ]);
    expect(projected.candidates[0]).not.toBe(group);
    expect(projected.candidates[1]).not.toBe(child);
    expect(projected.candidates[0]?.type === "group" && projected.candidates[0].candidateIds).not.toBe(
      group.candidateIds,
    );
    expect(projected.internalCandidates.get("public-1")).toMatchObject({
      archiveEntry: "patches",
      candidate: group,
      owner,
      request,
    });
    expect(projected.internalCandidates.get("public-2")).toMatchObject({
      archiveEntry: "patches/child.ips",
      candidate: child,
      owner,
      request,
    });
    expect(projected.internalCandidates.get("public-3")).toMatchObject({ candidate: hidden, owner, request });
    expect(request.candidates[0]).toEqual(group);
    expect(request.candidates[1]).toEqual(child);
  });
});
