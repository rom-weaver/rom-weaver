import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import type { BundleApplySession } from "../../lib/bundle/bundle-session-model.ts";
import { createLogger } from "../../lib/logging.ts";
import type { ParsedBundleChecks } from "../../types/bundle.ts";
import type { BinarySource, PatcherOutputController, PatcherStackController } from "./patcher-form.ts";
import { getReactBinarySourceFileName } from "./workflow-adapters.ts";

const logger = createLogger("bundle-apply-session");

/** Per-patch bundle metadata kept for the cards (label/description) and export round-trips. */
type BundlePatchMeta = {
  /** Stable author-facing identity carried through bundle exports. */
  id?: string;
  /** Author-controlled patch release version; distinct from the schema version. */
  version?: string;
  /** Patch author credit. */
  author?: string;
  name?: string;
  label?: string;
  description?: string;
  inputChecks?: ParsedBundleChecks;
  outputChecks?: ParsedBundleChecks;
  /** Declared input basis (`base` = authored against the ROM; absent = previous/inferred). */
  basis?: "base" | "previous";
};

type BundleSessionControllers = {
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
 * Applies a `?bundle=` session to the apply form exactly once: when the patch list first matches
 * the bundle's delivered files (ordered file names), it seeds enablement (optional → off,
 * everything else → on), applies per-patch header modes and the bundle's output defaults
 * through the same controller methods user edits use (so later user edits naturally win), and keeps
 * the per-patch label/description metadata for the patch cards, keyed by stable patch-slot id.
 */
const useBundleApplySession = ({
  bundleSession,
  controllersRef,
  getPatchIds,
  seedPatchEnablement,
}: {
  bundleSession: BundleApplySession | null;
  /** Latest-controller ref - the local controllers are recreated per render, so reads go through here. */
  controllersRef: MutableRefObject<BundleSessionControllers>;
  getPatchIds: () => string[];
  seedPatchEnablement: (entries: Array<{ id: string; enabled: boolean }>) => void;
}) => {
  const appliedKeyRef = useRef<string | null>(null);
  // Latest delivered patch list: a locally-dropped bundle delivers its patches
  // in the same task that sets the session state, so the list-change callback
  // can fire with a stale null session. The session-arrival effect below
  // replays the match against this mirror.
  const lastPatchesRef = useRef<BinarySource[]>([]);
  const [bundleMetaById, setBundleMetaById] = useState<ReadonlyMap<string, BundlePatchMeta>>(new Map());

  const handleBundlePatchesChange = useCallback(
    (patches: BinarySource[]) => {
      lastPatchesRef.current = patches;
      const session = bundleSession;
      if (!session?.entries.length || appliedKeyRef.current === session.key) return;
      const names = patches.map((patch, index) => getReactBinarySourceFileName(patch, `Patch ${index + 1}`));
      const expected = session.entries.map((entry) => entry.fileName);
      if (names.length !== expected.length || expected.some((name, index) => names[index] !== name)) return;
      appliedKeyRef.current = session.key;
      logger.debug("bundle session matched patch list; seeding enablement + defaults", {
        key: session.key,
        patchCount: patches.length,
      });
      const ids = getPatchIds();
      seedPatchEnablement(
        session.entries
          .map((entry, index) => ({
            enabled: !entry.optional,
            id: ids[index] ?? "",
          }))
          .filter((entry) => !!entry.id),
      );
      const meta = new Map<string, BundlePatchMeta>();
      session.entries.forEach((entry, index) => {
        const id = ids[index];
        if (!id) return;
        meta.set(id, {
          ...(entry.id ? { id: entry.id } : {}),
          ...(entry.version ? { version: entry.version } : {}),
          ...(entry.name ? { name: entry.name } : {}),
          ...(entry.label ? { label: entry.label } : {}),
          ...(entry.description ? { description: entry.description } : {}),
          ...(entry.version ? { version: entry.version } : {}),
          ...(entry.author ? { author: entry.author } : {}),
          ...(entry.inputChecks ? { inputChecks: entry.inputChecks } : {}),
          ...(entry.outputChecks ? { outputChecks: entry.outputChecks } : {}),
          ...(entry.basis ? { basis: entry.basis } : {}),
        });
      });
      setBundleMetaById(meta);
      // The controller work runs task-chained straight from the match, so everything lands while the
      // patches are still staging - well before the apply button arms. Deferring longer would race a
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
        // The input validation checksum seeds only the chain INPUT endpoint - the bundle's base-ROM
        // expectation, session-level rather than per-patch: it verifies the ROM (card coloring +
        // apply-time input validation) without being attributed to the patch's own check fields.
        // The OUTPUT endpoint is NOT seeded here: the bundle's expected result describes the full
        // chain only, so the form's reactive sync owns it - it engages the check while every bundle
        // patch is enabled in bundle order and stands it down for partial/diverged chains.
        for (const [index, entry] of session.entries.entries()) {
          const inputChecks = index === 0 ? session.chainEndpointChecks.input?.checksums : undefined;
          const validateInputChecksum = inputChecks?.sha1 || inputChecks?.md5 || inputChecks?.crc32;
          await controllersRef.current.patchStack?.setPatchOption?.(index, {
            ...(entry.header === "keep" || entry.header === "strip" ? { header: entry.header } : {}),
            ...(validateInputChecksum ? { validateInputChecksum } : {}),
          });
        }
        // Output defaults emulate user edits so later real edits win. Each setter merges into the
        // settings snapshot captured at ITS render, so consecutive same-tick calls would clobber one
        // another - yield a task between calls so each reads the committed result of the previous.
        const defaults = session.outputDefaults;
        if (defaults.name) {
          controllersRef.current.output?.setDisplayFileName(stripOutputNameExtension(defaults.name));
          await nextTask();
        }
        if (defaults.header) controllersRef.current.output?.setOutputHeader?.(defaults.header);
      })();
    },
    [controllersRef, bundleSession, getPatchIds, seedPatchEnablement],
  );

  // Replay the match when the session lands AFTER its patches did (local
  // bundle drops): the patch list is already final, so no further list-change
  // callback would ever fire.
  useEffect(() => {
    if (!bundleSession || appliedKeyRef.current === bundleSession.key) return;
    if (!lastPatchesRef.current.length) return;
    handleBundlePatchesChange(lastPatchesRef.current);
  }, [handleBundlePatchesChange, bundleSession]);

  const updateBundleMeta = useCallback((id: string, updates: Partial<BundlePatchMeta>) => {
    setBundleMetaById((previous) => {
      const next = new Map(previous);
      next.set(id, { ...next.get(id), ...updates });
      return next;
    });
  }, []);

  return { bundleMetaById, handleBundlePatchesChange, updateBundleMeta };
};

export type { BundlePatchMeta, BundleSessionControllers };
export { useBundleApplySession };
