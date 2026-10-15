import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import { lookupExpectedRom } from "../../lib/apply/expected-rom-lookup.ts";
import { fillMemberLaneChecks } from "../../lib/weave/weave-member-checks.ts";
import type { WeaveApplySession } from "../../lib/weave/weave-session-model.ts";
import { weaveCheckTokens } from "../../lib/weave/weave-targets.ts";
import { createLogger } from "../../lib/logging.ts";
import { createPatchMetadataLabel } from "../../lib/output/output-name-composition.ts";
import type { ParsedWeaveChecks, ParsedWeavePatchInput } from "../../types/weave.ts";
import type { BinarySource, PatcherOutputController, PatcherStackController } from "./patcher-form.ts";
import { waitForPatchStackReady } from "./wait-for-patch-stack-ready.ts";
import { getReactBinarySourceFileName } from "./workflow-adapters.ts";

const logger = createLogger("weave-apply-session");

/** Per-patch weave metadata kept for the cards (label/description) and export round-trips. */
type WeavePatchMeta = {
  input?: ParsedWeavePatchInput;
  target?: ParsedWeavePatchInput;
  /** Stable author-facing identity carried through weave exports. */
  id?: string;
  /** Author-controlled patch release version; distinct from the schema version. */
  version?: string;
  /** Patch author credit. */
  author?: string;
  name?: string;
  label?: string;
  description?: string;
  inputChecks?: ParsedWeaveChecks;
  outputChecks?: ParsedWeaveChecks;
  /** Per-patch authored input basis; absent leaves the workflow default or inference in control. */
  basis?: "base" | "previous";
};

type WeaveSessionControllers = {
  output: PatcherOutputController | null;
  patchStack: PatcherStackController | null;
};

const mergeWeaveMetaForIds = (
  previous: ReadonlyMap<string, WeavePatchMeta>,
  ids: readonly string[],
  updates: Partial<WeavePatchMeta>,
): ReadonlyMap<string, WeavePatchMeta> => {
  const next = new Map(previous);
  for (const id of ids) next.set(id, { ...next.get(id), ...updates });
  return next;
};

type GeneratedPatchNameSource = BinarySource & { _generatedPatchName?: string };

const setGeneratedPatchName = (source: BinarySource | undefined, metadata?: WeavePatchMeta): void => {
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

const createWeavePatchMetadata = (
  patches: BinarySource[],
  entries: WeaveApplySession["entries"],
  ids: string[],
): Map<string, WeavePatchMeta> => {
  const metadataById = new Map<string, WeavePatchMeta>();
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
    ) as WeavePatchMeta;
    metadataById.set(id, metadata);
    setGeneratedPatchName(patches[index], metadata);
  }
  return metadataById;
};

const restoreWeavePatchMetadata = (
  patches: BinarySource[],
  entries: WeaveApplySession["entries"],
  ids: string[],
  metadataById: ReadonlyMap<string, WeavePatchMeta>,
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
 * Per-track input checks for the weave's ROM-member lanes, taken from the
 * identify record its `rom` checks name. Apply-time only: the values are handed
 * to the patch options, never merged into the exported weave metadata.
 */
const resolveMemberLaneChecks = async (session: WeaveApplySession): Promise<ReadonlyMap<number, ParsedWeaveChecks>> => {
  const empty = new Map<number, ParsedWeaveChecks>();
  const needsFill = session.entries.some(
    (entry) => !!(entry.target && "rom" in entry.target && entry.target.member) && !(entry.input || entry.inputChecks),
  );
  if (!needsFill) return empty;
  const romChecks = session.romExpectation?.checks || session.chainEndpointChecks.input;
  if (!romChecks) return empty;
  try {
    const identification = await lookupExpectedRom(romChecks);
    const fills = fillMemberLaneChecks(session.entries, identification);
    if (fills.size) logger.debug("weave session filled member lane checks", { entries: [...fills.keys()] });
    return fills;
  } catch {
    // A ROM the identify database cannot name is not an apply error; the lanes
    // simply keep the checks the weave itself declared.
    return empty;
  }
};

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Applies a `?weave=` session to the apply form exactly once: when the patch list first matches
 * the weave's delivered files (ordered file names), it seeds enablement (optional → off,
 * everything else → on), applies per-patch header modes and the weave's output defaults
 * through the same controller methods user edits use (so later user edits naturally win), and keeps
 * the per-patch label/description metadata for the patch cards, keyed by stable patch-slot id.
 */
const useWeaveApplySession = ({
  weaveSession,
  controllersRef,
  getPatchIds,
  seedPatchEnablement,
}: {
  weaveSession: WeaveApplySession | null;
  /** Latest-controller ref - the local controllers are recreated per render, so reads go through here. */
  controllersRef: MutableRefObject<WeaveSessionControllers>;
  getPatchIds: () => string[];
  seedPatchEnablement: (entries: Array<{ id: string; enabled: boolean }>) => void;
}) => {
  const appliedKeyRef = useRef<string | null>(null);
  // Latest delivered patch list: a locally-dropped weave delivers its patches
  // in the same task that sets the session state, so the list-change callback
  // can fire with a stale null session. The session-arrival effect below
  // replays the match against this mirror.
  const lastPatchesRef = useRef<BinarySource[]>([]);
  const [weaveMetaById, setWeaveMetaById] = useState<ReadonlyMap<string, WeavePatchMeta>>(new Map());
  const [weaveDefaultsPending, setWeaveDefaultsPending] = useState(false);
  const seedGenerationRef = useRef(0);
  const seedAbortRef = useRef<AbortController | null>(null);
  // Apply-time input checks per patch id, filled from the identify record the
  // weave's rom checks name. Kept out of `weaveMetaById` on purpose: the form
  // rebuilds run options from that metadata, and an export must not carry these.
  const memberLaneChecksRef = useRef<ReadonlyMap<string, string>>(new Map());
  const activeSeedPatchNamesRef = useRef<readonly string[] | null>(null);

  useEffect(
    () => () => {
      seedGenerationRef.current += 1;
      seedAbortRef.current?.abort();
      seedAbortRef.current = null;
      activeSeedPatchNamesRef.current = null;
    },
    [],
  );

  const handleWeavePatchesChange = useCallback(
    (patches: BinarySource[]) => {
      lastPatchesRef.current = patches;
      const session = weaveSession;
      if (!session?.entries.length) {
        clearGeneratedPatchNames(patches);
        if (activeSeedPatchNamesRef.current) {
          seedGenerationRef.current += 1;
          seedAbortRef.current?.abort();
          seedAbortRef.current = null;
          activeSeedPatchNamesRef.current = null;
          appliedKeyRef.current = null;
          setWeaveDefaultsPending(false);
          logger.debug("weave session seed cancelled after patch-list change", {
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
          seedAbortRef.current?.abort();
          seedAbortRef.current = null;
          activeSeedPatchNamesRef.current = null;
          appliedKeyRef.current = null;
          setWeaveDefaultsPending(false);
          logger.debug("weave session seed cancelled after patch-list change", {
            key: session.key,
            patchCount: names.length,
          });
        }
        return;
      }
      const ids = getPatchIds();
      if (appliedKeyRef.current === session.key) {
        restoreWeavePatchMetadata(patches, session.entries, ids, weaveMetaById);
        return;
      }
      appliedKeyRef.current = session.key;
      const generation = seedGenerationRef.current + 1;
      seedGenerationRef.current = generation;
      seedAbortRef.current?.abort();
      const seedAbort = new AbortController();
      seedAbortRef.current = seedAbort;
      activeSeedPatchNamesRef.current = expected;
      setWeaveDefaultsPending(true);
      logger.debug("weave session matched patch list; seeding enablement + defaults", {
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
      const meta = createWeavePatchMetadata(patches, session.entries, ids);
      setWeaveMetaById(meta);
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
          await waitForPatchStackReady(controllersRef.current.patchStack, {
            count: session.entries.length,
            signal: seedAbort.signal,
          });
          if (!isCurrent()) return;
          const memberLaneChecks = await resolveMemberLaneChecks(session);
          if (!isCurrent()) return;
          memberLaneChecksRef.current = new Map(
            [...memberLaneChecks].flatMap(([index, checks]) => {
              const id = ids[index];
              const tokens = weaveCheckTokens(checks);
              return id && tokens ? [[id, tokens] as const] : [];
            }),
          );
          // Seed header modes through normal options. The weave's ROM checksum
          // belongs only to the chain input; reactive sync owns the chain output
          // because it applies only while the full weave chain remains intact.
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
                  ? { inputChecks: weaveCheckTokens(memberLaneChecks.get(index)) || "" }
                  : {}),
                // A local weave can finish staging before its session metadata lands. Its option update
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
            seedAbortRef.current = null;
            activeSeedPatchNamesRef.current = null;
            setWeaveDefaultsPending(false);
            logger.debug("weave session defaults applied", {
              key: session.key,
              patchCount: session.entries.length,
            });
          }
        }
      })();
    },
    [weaveMetaById, controllersRef, weaveSession, getPatchIds, seedPatchEnablement],
  );

  // Replay the match when the session lands AFTER its patches did (local
  // weave drops): the patch list is already final, so no further list-change
  // callback would ever fire.
  useEffect(() => {
    if (!weaveSession || appliedKeyRef.current === weaveSession.key) return;
    if (!lastPatchesRef.current.length) return;
    handleWeavePatchesChange(lastPatchesRef.current);
  }, [handleWeavePatchesChange, weaveSession]);

  useEffect(() => {
    const ids = getPatchIds();
    for (const [id, metadata] of weaveMetaById) {
      const index = ids.indexOf(id);
      if (index >= 0) setGeneratedPatchName(lastPatchesRef.current[index], metadata);
    }
  }, [weaveMetaById, getPatchIds]);

  const updateWeaveMeta = useCallback((id: string, updates: Partial<WeavePatchMeta>) => {
    setWeaveMetaById((previous) => {
      const next = new Map(previous);
      next.set(id, { ...next.get(id), ...updates });
      return next;
    });
  }, []);

  const updateWeaveMetaForIds = useCallback((ids: readonly string[], updates: Partial<WeavePatchMeta>) => {
    setWeaveMetaById((previous) => mergeWeaveMetaForIds(previous, ids, updates));
  }, []);

  return {
    weaveDefaultsPending,
    weaveMetaById,
    handleWeavePatchesChange,
    memberLaneChecksRef,
    updateWeaveMeta,
    updateWeaveMetaForIds,
  };
};

export type { WeavePatchMeta, WeaveSessionControllers };
export { mergeWeaveMetaForIds, useWeaveApplySession };
