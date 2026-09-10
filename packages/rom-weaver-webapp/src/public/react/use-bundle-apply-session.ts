import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import { lookupExpectedRom } from "../../lib/apply/expected-rom-lookup.ts";
import { fillMemberLaneChecks } from "../../lib/bundle/bundle-member-checks.ts";
import type { BundleApplySession } from "../../lib/bundle/bundle-session-model.ts";
import { bundleCheckTokens } from "../../lib/bundle/bundle-targets.ts";
import { createLogger } from "../../lib/logging.ts";
import { createPatchMetadataLabel } from "../../lib/output/output-name-composition.ts";
import type { ParsedBundleChecks, ParsedBundlePatchInput } from "../../types/bundle.ts";
import type { BinarySource, PatcherOutputController, PatcherStackController } from "./patcher-form.ts";
import { getReactBinarySourceFileName } from "./workflow-adapters.ts";

const logger = createLogger("bundle-apply-session");

/** Per-patch bundle metadata kept for the cards (label/description) and export round-trips. */
type BundlePatchMeta = {
  input?: ParsedBundlePatchInput;
  target?: ParsedBundlePatchInput;
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

const mergeBundleMetaForIds = (
  previous: ReadonlyMap<string, BundlePatchMeta>,
  ids: readonly string[],
  updates: Partial<BundlePatchMeta>,
): ReadonlyMap<string, BundlePatchMeta> => {
  const next = new Map(previous);
  for (const id of ids) next.set(id, { ...next.get(id), ...updates });
  return next;
};

type GeneratedPatchNameSource = BinarySource & { _generatedPatchName?: string };

const setGeneratedPatchName = (source: BinarySource | undefined, metadata?: BundlePatchMeta): void => {
  if (!source || typeof source !== "object") return;
  const generatedPatchName = createPatchMetadataLabel(metadata);
  try {
    (source as GeneratedPatchNameSource)._generatedPatchName = generatedPatchName || undefined;
  } catch {
    // Some host file handles may be non-extensible. The regular filename fallback still works.
  }
};

const clearGeneratedPatchNames = (patches: BinarySource[]): void => {
  for (const patch of patches) setGeneratedPatchName(patch);
};

const createBundlePatchMetadata = (
  patches: BinarySource[],
  entries: BundleApplySession["entries"],
  ids: string[],
): Map<string, BundlePatchMeta> => {
  const metadataById = new Map<string, BundlePatchMeta>();
  for (const [index, entry] of entries.entries()) {
    const id = ids[index];
    if (!id) continue;
    const metadata = Object.fromEntries(
      Object.entries({
        author: entry.author,
        basis: entry.basis,
        description: entry.description,
        id: entry.id,
        input: entry.input,
        target: entry.target,
        inputChecks: entry.inputChecks,
        label: entry.label,
        name: entry.name,
        outputChecks: entry.outputChecks,
        version: entry.version,
      }).filter(([, value]) => value !== undefined),
    ) as BundlePatchMeta;
    metadataById.set(id, metadata);
    setGeneratedPatchName(patches[index], metadata);
  }
  return metadataById;
};

const restoreBundlePatchMetadata = (
  patches: BinarySource[],
  entries: BundleApplySession["entries"],
  ids: string[],
  metadataById: ReadonlyMap<string, BundlePatchMeta>,
): void => {
  for (const [index, entry] of entries.entries()) {
    const id = ids[index];
    if (!id) continue;
    setGeneratedPatchName(patches[index], metadataById.get(id) || entry);
  }
};

/** The output name field carries the name WITHOUT an extension (the format select owns it). */
const stripOutputNameExtension = (name: string): string => {
  const stripped = name.replace(/\.[a-z0-9]{1,5}$/i, "").trim();
  return stripped || name.trim();
};

/**
 * Per-track input checks for the bundle's ROM-member lanes, taken from the
 * identify record its `rom` checks name. Apply-time only: the values are handed
 * to the patch options, never merged into the exported bundle metadata.
 */
const resolveMemberLaneChecks = async (
  session: BundleApplySession,
): Promise<ReadonlyMap<number, ParsedBundleChecks>> => {
  const empty = new Map<number, ParsedBundleChecks>();
  const needsFill = session.entries.some(
    (entry) => !!(entry.target && "rom" in entry.target && entry.target.member) && !(entry.input || entry.inputChecks),
  );
  if (!needsFill) return empty;
  const romChecks = session.romExpectation?.checks || session.chainEndpointChecks.input;
  if (!romChecks) return empty;
  try {
    const identification = await lookupExpectedRom(romChecks);
    const fills = fillMemberLaneChecks(session.entries, identification);
    if (fills.size) logger.debug("bundle session filled member lane checks", { entries: [...fills.keys()] });
    return fills;
  } catch {
    // A ROM the identify database cannot name is not an apply error; the lanes
    // simply keep the checks the bundle itself declared.
    return empty;
  }
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
  const [bundleDefaultsPending, setBundleDefaultsPending] = useState(false);
  const seedGenerationRef = useRef(0);
  // Apply-time input checks per patch id, filled from the identify record the
  // bundle's rom checks name. Kept out of `bundleMetaById` on purpose: the form
  // rebuilds run options from that metadata, and an export must not carry these.
  const memberLaneChecksRef = useRef<ReadonlyMap<string, string>>(new Map());
  const activeSeedPatchNamesRef = useRef<readonly string[] | null>(null);

  useEffect(
    () => () => {
      seedGenerationRef.current += 1;
      activeSeedPatchNamesRef.current = null;
    },
    [],
  );

  const handleBundlePatchesChange = useCallback(
    (patches: BinarySource[]) => {
      lastPatchesRef.current = patches;
      const session = bundleSession;
      if (!session?.entries.length) {
        clearGeneratedPatchNames(patches);
        if (activeSeedPatchNamesRef.current) {
          seedGenerationRef.current += 1;
          activeSeedPatchNamesRef.current = null;
          appliedKeyRef.current = null;
          setBundleDefaultsPending(false);
          logger.debug("bundle session seed cancelled after patch-list change", {
            patchCount: patches.length,
          });
        }
        return;
      }
      const names = patches.map((patch, index) => getReactBinarySourceFileName(patch, `Patch ${index + 1}`));
      const expected = session.entries.map((entry) => entry.fileName);
      const matchesSession = names.length === expected.length && expected.every((name, index) => names[index] === name);
      if (!matchesSession) {
        clearGeneratedPatchNames(patches);
        if (activeSeedPatchNamesRef.current) {
          seedGenerationRef.current += 1;
          activeSeedPatchNamesRef.current = null;
          appliedKeyRef.current = null;
          setBundleDefaultsPending(false);
          logger.debug("bundle session seed cancelled after patch-list change", {
            key: session.key,
            patchCount: names.length,
          });
        }
        return;
      }
      const ids = getPatchIds();
      if (appliedKeyRef.current === session.key) {
        restoreBundlePatchMetadata(patches, session.entries, ids, bundleMetaById);
        return;
      }
      appliedKeyRef.current = session.key;
      const generation = seedGenerationRef.current + 1;
      seedGenerationRef.current = generation;
      activeSeedPatchNamesRef.current = expected;
      setBundleDefaultsPending(true);
      logger.debug("bundle session matched patch list; seeding enablement + defaults", {
        key: session.key,
        patchCount: patches.length,
      });
      seedPatchEnablement(
        session.entries
          .map((entry, index) => ({
            enabled: !entry.optional,
            id: ids[index] ?? "",
          }))
          .filter((entry) => !!entry.id),
      );
      const meta = createBundlePatchMetadata(patches, session.entries, ids);
      setBundleMetaById(meta);
      memberLaneChecksRef.current = new Map();
      // The controller work runs task-chained straight from the match, so everything lands while the
      // patches are still staging - well before the apply button arms. Deferring longer would race a
      // fast apply click: any settings commit cancels a queued apply (by design for real user edits).
      void (async () => {
        const isCurrent = () => seedGenerationRef.current === generation;
        try {
          // Let the patch-list state commit so the option mutations snapshot the new list.
          await nextTask();
          if (!isCurrent()) return;
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (!isCurrent()) return;
            const items = controllersRef.current.patchStack?.getState().items || [];
            if (
              items.length === session.entries.length &&
              items.every((item) => !(item.progress || item.optionsDisabled))
            ) {
              break;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
          }
          const memberLaneChecks = await resolveMemberLaneChecks(session);
          if (!isCurrent()) return;
          memberLaneChecksRef.current = new Map(
            [...memberLaneChecks].flatMap(([index, checks]) => {
              const id = ids[index];
              const tokens = bundleCheckTokens(checks);
              return id && tokens ? [[id, tokens] as const] : [];
            }),
          );
          // Seed header modes through normal options. The bundle's ROM checksum
          // belongs only to the chain input; reactive sync owns the chain output
          // because it applies only while the full bundle chain remains intact.
          for (const [index, entry] of session.entries.entries()) {
            if (!isCurrent()) return;
            const inputChecks = index === 0 ? session.chainEndpointChecks.input?.checksums : undefined;
            const validateInputChecksum = inputChecks?.sha1 || inputChecks?.md5 || inputChecks?.crc32;
            await Promise.resolve(
              controllersRef.current.patchStack?.setPatchOption?.(index, {
                ...(entry.id ? { id: entry.id } : {}),
                ...(entry.input ? { input: entry.input } : {}),
                ...(entry.target ? { target: entry.target } : {}),
                ...(entry.basis ? { basis: entry.basis } : {}),
                ...(entry.header === "keep" || entry.header === "strip" ? { header: entry.header } : {}),
                ...(validateInputChecksum ? { validateInputChecksum } : {}),
                ...(memberLaneChecks.has(index)
                  ? { inputChecks: bundleCheckTokens(memberLaneChecks.get(index)) || "" }
                  : {}),
                // A local bundle can finish staging before its session metadata lands. Its option update
                // clears the earlier verdict, so revalidate once after the final seeded entry.
                revalidate: index === session.entries.length - 1,
              }),
            );
          }
          if (!isCurrent()) return;
          // Output defaults emulate user edits so later real edits win. Each setter merges into the
          // settings snapshot captured at ITS render, so consecutive same-tick calls would clobber one
          // another - yield a task between calls so each reads the committed result of the previous.
          const defaults = session.outputDefaults;
          if (defaults.name) {
            controllersRef.current.output?.setDisplayFileName(stripOutputNameExtension(defaults.name));
            await nextTask();
          }
          if (!isCurrent()) return;
          if (defaults.header) controllersRef.current.output?.setOutputHeader?.(defaults.header);
        } finally {
          if (isCurrent()) {
            activeSeedPatchNamesRef.current = null;
            setBundleDefaultsPending(false);
            logger.debug("bundle session defaults applied", {
              key: session.key,
              patchCount: session.entries.length,
            });
          }
        }
      })();
    },
    [bundleMetaById, controllersRef, bundleSession, getPatchIds, seedPatchEnablement],
  );

  // Replay the match when the session lands AFTER its patches did (local
  // bundle drops): the patch list is already final, so no further list-change
  // callback would ever fire.
  useEffect(() => {
    if (!bundleSession || appliedKeyRef.current === bundleSession.key) return;
    if (!lastPatchesRef.current.length) return;
    handleBundlePatchesChange(lastPatchesRef.current);
  }, [handleBundlePatchesChange, bundleSession]);

  useEffect(() => {
    const ids = getPatchIds();
    for (const [id, metadata] of bundleMetaById) {
      const index = ids.indexOf(id);
      if (index >= 0) setGeneratedPatchName(lastPatchesRef.current[index], metadata);
    }
  }, [bundleMetaById, getPatchIds]);

  const updateBundleMeta = useCallback((id: string, updates: Partial<BundlePatchMeta>) => {
    setBundleMetaById((previous) => {
      const next = new Map(previous);
      next.set(id, { ...next.get(id), ...updates });
      return next;
    });
  }, []);

  const updateBundleMetaForIds = useCallback((ids: readonly string[], updates: Partial<BundlePatchMeta>) => {
    setBundleMetaById((previous) => mergeBundleMetaForIds(previous, ids, updates));
  }, []);

  return {
    bundleDefaultsPending,
    bundleMetaById,
    handleBundlePatchesChange,
    memberLaneChecksRef,
    updateBundleMeta,
    updateBundleMetaForIds,
  };
};

export type { BundlePatchMeta, BundleSessionControllers };
export { mergeBundleMetaForIds, useBundleApplySession };
