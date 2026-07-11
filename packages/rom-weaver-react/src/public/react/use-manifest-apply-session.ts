import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import { createLogger } from "../../lib/logging.ts";
import type { ManifestApplySession } from "../../lib/manifest/manifest-session-model.ts";
import type { ParsedManifestChecks } from "../../types/manifest.ts";
import { getBinarySourceListStableIds } from "./input-session-helpers.ts";
import type { BinarySource, PatcherOutputController, PatcherStackController } from "./patcher-form.ts";
import { getReactBinarySourceFileName } from "./workflow-adapters.ts";

const logger = createLogger("manifest-apply-session");

/** Per-patch manifest metadata kept for the cards (label/description) and export round-trips. */
type ManifestPatchMeta = {
  name?: string;
  label?: string;
  description?: string;
  inputChecks?: ParsedManifestChecks;
  outputChecks?: ParsedManifestChecks;
};

type ManifestSessionControllers = {
  output: PatcherOutputController | null;
  patchStack: PatcherStackController | null;
};

/** The output name field carries the name WITHOUT an extension (the format select owns it). */
const stripOutputNameExtension = (name: string): string => {
  const stripped = name.replace(/\.[a-z0-9]{1,5}$/i, "").trim();
  return stripped || name.trim();
};

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Applies a `?manifest=` session to the apply form exactly once: when the patch list first matches
 * the manifest's delivered files (ordered file names), it seeds enablement (optional → off,
 * everything else → on), applies per-patch header modes and the manifest's output defaults
 * through the same controller methods user edits use (so later user edits naturally win), and keeps
 * the per-patch label/description metadata for the patch cards, keyed by stable source id.
 */
const useManifestApplySession = ({
  manifestSession,
  controllersRef,
  seedPatchEnablement,
}: {
  manifestSession: ManifestApplySession | null;
  /** Latest-controller ref — the local controllers are recreated per render, so reads go through here. */
  controllersRef: MutableRefObject<ManifestSessionControllers>;
  seedPatchEnablement: (entries: Array<{ id: string; enabled: boolean }>) => void;
}) => {
  const appliedKeyRef = useRef<string | null>(null);
  // Latest delivered patch list: a locally-dropped bundle delivers its patches
  // in the same task that sets the session state, so the list-change callback
  // can fire with a stale null session. The session-arrival effect below
  // replays the match against this mirror.
  const lastPatchesRef = useRef<BinarySource[]>([]);
  const [manifestMetaById, setManifestMetaById] = useState<ReadonlyMap<string, ManifestPatchMeta>>(new Map());

  const handleManifestPatchesChange = useCallback(
    (patches: BinarySource[]) => {
      lastPatchesRef.current = patches;
      const session = manifestSession;
      if (!session?.entries.length || appliedKeyRef.current === session.key) return;
      const names = patches.map((patch, index) => getReactBinarySourceFileName(patch, `Patch ${index + 1}`));
      const expected = session.entries.map((entry) => entry.fileName);
      if (names.length !== expected.length || expected.some((name, index) => names[index] !== name)) return;
      appliedKeyRef.current = session.key;
      logger.debug("manifest session matched patch list; seeding enablement + defaults", {
        key: session.key,
        patchCount: patches.length,
      });
      const ids = getBinarySourceListStableIds(patches);
      seedPatchEnablement(
        session.entries
          .map((entry, index) => ({
            enabled: !entry.optional,
            id: ids[index] ?? "",
          }))
          .filter((entry) => !!entry.id),
      );
      const meta = new Map<string, ManifestPatchMeta>();
      session.entries.forEach((entry, index) => {
        const id = ids[index];
        if (!id) return;
        meta.set(id, {
          ...(entry.name ? { name: entry.name } : {}),
          ...(entry.label ? { label: entry.label } : {}),
          ...(entry.description ? { description: entry.description } : {}),
          ...(entry.inputChecks ? { inputChecks: entry.inputChecks } : {}),
          ...(entry.outputChecks ? { outputChecks: entry.outputChecks } : {}),
        });
      });
      setManifestMetaById(meta);
      // The controller work runs task-chained straight from the match, so everything lands while the
      // patches are still staging — well before the apply button arms. Deferring longer would race a
      // fast apply click: any settings commit cancels a queued apply (by design for real user edits).
      void (async () => {
        // Let the patch-list state commit so the option mutations snapshot the new list.
        await nextTask();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const items = controllersRef.current.patchStack?.getState().items || [];
          if (
            items.length === session.entries.length &&
            items.every((item) => !(item.progress || item.optionsDisabled))
          ) {
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
        // Per-patch header modes ride the normal option path (the same call the Options drawer's
        // strip-header checkbox makes); `auto` entries stay with the engine's per-step decision.
        // Validation checksums seed only the chain ENDPOINTS — the manifest's ROM/final-output
        // expectations, session-level rather than per-patch: they verify the ROM (card coloring +
        // apply-time input validation) without being attributed to the patches' own check fields,
        // and mid-chain states describe intermediates the webapp cannot verify before applying.
        for (const [index, entry] of session.entries.entries()) {
          const inputChecks = index === 0 ? session.chainEndpointChecks.input?.checksums : undefined;
          const outputChecks =
            index === session.entries.length - 1 ? session.chainEndpointChecks.output?.checksums : undefined;
          const validateInputChecksum = inputChecks?.sha1 || inputChecks?.md5 || inputChecks?.crc32;
          const validateOutputChecksum = outputChecks?.sha1 || outputChecks?.md5 || outputChecks?.crc32;
          await controllersRef.current.patchStack?.setPatchOption?.(index, {
            ...(entry.header === "keep" || entry.header === "strip" ? { header: entry.header } : {}),
            ...(validateInputChecksum ? { validateInputChecksum } : {}),
            ...(validateOutputChecksum ? { validateOutputChecksum } : {}),
          });
        }
        // Output defaults emulate user edits so later real edits win. Each setter merges into the
        // settings snapshot captured at ITS render, so consecutive same-tick calls would clobber one
        // another — yield a task between calls so each reads the committed result of the previous.
        const defaults = session.outputDefaults;
        if (defaults.name) {
          controllersRef.current.output?.setDisplayFileName(stripOutputNameExtension(defaults.name));
          await nextTask();
        }
        if (defaults.header) controllersRef.current.output?.setOutputHeader?.(defaults.header);
      })();
    },
    [controllersRef, manifestSession, seedPatchEnablement],
  );

  // Replay the match when the session lands AFTER its patches did (local
  // bundle drops): the patch list is already final, so no further list-change
  // callback would ever fire.
  useEffect(() => {
    if (!manifestSession || appliedKeyRef.current === manifestSession.key) return;
    if (!lastPatchesRef.current.length) return;
    handleManifestPatchesChange(lastPatchesRef.current);
  }, [handleManifestPatchesChange, manifestSession]);

  const updateManifestMeta = useCallback((id: string, updates: Partial<ManifestPatchMeta>) => {
    setManifestMetaById((previous) => {
      const next = new Map(previous);
      next.set(id, { ...next.get(id), ...updates });
      return next;
    });
  }, []);

  return { handleManifestPatchesChange, manifestMetaById, updateManifestMeta };
};

export type { ManifestPatchMeta, ManifestSessionControllers };
export { useManifestApplySession };
