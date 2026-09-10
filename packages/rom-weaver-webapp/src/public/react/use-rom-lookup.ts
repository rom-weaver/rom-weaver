import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ExpectedRomTitle,
  lookupExpectedRom,
  searchExpectedRomByName,
  searchExpectedRomTitles,
} from "../../lib/apply/expected-rom-lookup.ts";
import { identifyRecordChecks } from "../../lib/identify/identify-record-checks.ts";
import { baseTitle, normalizeTitle } from "../../lib/identify/title-index.mjs";
import type { ParsedBundleChecks } from "../../types/bundle.ts";
import type { ParsedIdentifyResolution, ParsedIdentifyTitleMatch } from "../../types/identify.ts";
import { identifyHashAlgorithm } from "../../types/identify.ts";

/** Smallest name the search accepts; one character matches most of the index. */
const MIN_QUERY_LENGTH = 2;

const SEARCH_DELAY_MS = 300;

/**
 * How many pack records a title's release lookup reads before the exact-title
 * filter. The pack search ranks every superstring too ("Sonic the Hedgehog 2"
 * for "Sonic the Hedgehog"), and shorter names score higher, so the releases
 * of a much-sequelled title can sit well past the first fifty hits.
 */
const VERSIONS_LIMIT = 200;

/** Records of exactly the chosen title; the pack search also returns every superstring. */
const releasesOf = (title: ExpectedRomTitle, matches: ParsedIdentifyTitleMatch[]) => {
  const wanted = normalizeTitle(title.name);
  return matches.filter((match) => normalizeTitle(baseTitle(match.name)) === wanted);
};

/**
 * Hex text this long or longer is a checksum somebody meant to paste, so a
 * wrong length is reported instead of searched as a name. Shorter hex text
 * ("dead", "cafe") is a plausible game name and searches as one.
 */
const MIN_HASH_LENGTH = 8;

/** The ROM the user settled on, shaped the same whichever route found it. */
type RomLookupResult = {
  checks: ParsedBundleChecks;
  /** Which route answered; the card's meta line names it. */
  foundBy: "checksum" | "name";
  identification: ParsedIdentifyResolution;
};

type RomLookupMessages = {
  failed: string;
  hashInvalid: string;
  hashNoMatch: string;
  hashUnavailable: string;
  nameNoMatch: string;
  nameUnavailable: string;
  tooShort: string;
  versionsNoMatch: string;
};

type RomLookupState = {
  busy: boolean;
  checksum: ParsedBundleChecks | undefined;
  error: string;
  result: RomLookupResult | undefined;
  stage: string;
  text: string;
  /** Titles a name search found across every platform. */
  titles: ExpectedRomTitle[];
  /** The title selected for a release lookup; absent for checksum matches. */
  title: ExpectedRomTitle | undefined;
  /** Release choices from the selected title or a checksum lookup. */
  versions: ParsedIdentifyTitleMatch[];
};

const IDLE: RomLookupState = {
  busy: false,
  checksum: undefined,
  error: "",
  result: undefined,
  stage: "",
  text: "",
  title: undefined,
  titles: [],
  versions: [],
};

/** The expectation a chosen release asserts: the record's own checksums and size. */
const checksForMatch = (match: ParsedIdentifyTitleMatch): ParsedBundleChecks => {
  const record = identifyRecordChecks({ matches: [match], status: "matched" });
  if (!record) return { checksums: {} };
  return { checksums: record.checksums, ...(record.size === undefined ? {} : { size: record.size }) };
};

const describeError = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/**
 * The file-free way to answer "which ROM do I need": one text box that takes a
 * checksum or a game name. The text decides the route - 8, 32, or 40 hex
 * characters is a checksum the router sends to its packs; anything else is a
 * name the title index answers across every platform, and choosing a title
 * lists its releases from that platform's pack. Either route ends in the same
 * expected-ROM result. Typing waits for a pause before searching. Releases
 * MUST remain choices until the user selects their expected checksums.
 */
const useRomLookup = (messages: RomLookupMessages) => {
  const [state, setState] = useState<RomLookupState>(IDLE);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // A late answer from a superseded lookup must not overwrite a newer one.
  const runRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  const cancel = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
    runRef.current += 1;
    abortRef.current?.abort();
  }, []);

  const begin = useCallback(() => {
    cancel();
    const controller = new AbortController();
    abortRef.current = controller;
    // The previous answer stays up while the next one loads: a card the user
    // is refining MUST NOT vanish and flip the bench back to the hero.
    setState((current) => ({ ...current, busy: true, error: "", stage: "" }));
    return { controller, run: runRef.current };
  }, [cancel]);

  const stale = useCallback(
    (run: number, controller: AbortController) =>
      runRef.current !== run || controller.signal.aborted || !mountedRef.current,
    [],
  );

  const onProgress = useCallback(
    (run: number) => (progress: { label?: string; message?: string }) => {
      if (runRef.current !== run) return;
      setState((current) => ({ ...current, stage: progress.message || progress.label || "" }));
    },
    [],
  );

  const fail = useCallback((error: string) => {
    setState((current) => ({ ...current, busy: false, error, stage: "" }));
  }, []);

  const clear = useCallback(() => {
    cancel();
    setState(IDLE);
  }, [cancel]);

  const searchHash = useCallback(
    async (hash: string) => {
      const algorithm = identifyHashAlgorithm(hash);
      if (!algorithm) {
        setState((current) => ({ ...current, error: messages.hashInvalid }));
        return;
      }
      const { controller, run } = begin();
      try {
        const checks = { checksums: { [algorithm]: hash } };
        const found = await lookupExpectedRom(checks, { onProgress: onProgress(run), signal: controller.signal });
        if (stale(run, controller)) return;
        if (!found) return fail(messages.hashNoMatch);
        if (found.status === "unavailable") {
          return fail([messages.hashUnavailable, found.unavailableReason].filter(Boolean).join(" "));
        }
        setState((current) => ({
          ...current,
          busy: false,
          checksum: checks,
          stage: "",
          title: undefined,
          titles: [],
          versions: found.matches,
        }));
      } catch (error) {
        if (stale(run, controller)) return;
        fail(describeError(error, messages.failed));
      }
    },
    [begin, fail, messages, onProgress, stale],
  );

  const searchName = useCallback(
    async (query: string) => {
      if (query.length < MIN_QUERY_LENGTH) {
        setState((current) => ({ ...current, error: messages.tooShort }));
        return;
      }
      const { controller, run } = begin();
      try {
        const found = await searchExpectedRomTitles(query, {
          limit: Infinity,
          onProgress: onProgress(run),
          signal: controller.signal,
        });
        if (stale(run, controller)) return;
        if (found.status === "unavailable") {
          setState((current) => ({ ...current, title: undefined, titles: [], versions: [] }));
          return fail([messages.nameUnavailable, found.unavailableReason].filter(Boolean).join(" "));
        }
        if (!found.titles.length) {
          setState((current) => ({ ...current, title: undefined, titles: [], versions: [] }));
          return fail(messages.nameNoMatch);
        }
        setState((current) => ({
          ...current,
          busy: false,
          stage: "",
          title: undefined,
          checksum: undefined,
          titles: found.titles,
          versions: [],
        }));
      } catch (error) {
        if (stale(run, controller)) return;
        fail(describeError(error, messages.failed));
      }
    },
    [begin, fail, messages, onProgress, stale],
  );

  const setText = useCallback(
    (text: string, composing = false) => {
      cancel();
      setState((current) => ({
        ...current,
        busy: false,
        checksum: undefined,
        error: "",
        stage: "",
        text,
        title: undefined,
        titles: [],
        versions: [],
      }));
      if (composing) return;
      const query = text.trim();
      if (query.length < MIN_QUERY_LENGTH) return;
      const hex = query.toLowerCase();
      if (/^[0-9a-f]+$/u.test(hex) && hex.length >= MIN_HASH_LENGTH) {
        if (identifyHashAlgorithm(hex)) timerRef.current = setTimeout(() => void searchHash(hex), SEARCH_DELAY_MS);
        return;
      }
      timerRef.current = setTimeout(() => void searchName(query), SEARCH_DELAY_MS);
    },
    [cancel, searchHash, searchName],
  );

  const search = useCallback(async () => {
    cancel();
    const text = state.text.trim();
    if (!text) return;
    const hex = text.toLowerCase();
    if (/^[0-9a-f]+$/u.test(hex) && hex.length >= MIN_HASH_LENGTH) return searchHash(hex);
    return searchName(text);
  }, [cancel, searchHash, searchName, state.text]);

  const choose = useCallback(
    (match: ParsedIdentifyTitleMatch) => {
      cancel();
      setState((current) => {
        const record = checksForMatch(match);
        return {
          ...current,
          busy: false,
          error: "",
          stage: "",
          result: {
            checks: {
              ...record,
              checksums: { ...record.checksums, ...current.checksum?.checksums },
            },
            foundBy: current.checksum ? "checksum" : "name",
            identification: { matches: [match], status: "matched" },
          },
          checksum: undefined,
          title: undefined,
          titles: [],
          versions: [],
        };
      });
    },
    [cancel],
  );

  const chooseTitle = useCallback(
    async (title: ExpectedRomTitle) => {
      const { controller, run } = begin();
      setState((current) => ({ ...current, checksum: undefined, title, versions: [] }));
      try {
        const found = await searchExpectedRomByName(title.slug, title.name, {
          limit: VERSIONS_LIMIT,
          onProgress: onProgress(run),
          signal: controller.signal,
        });
        if (stale(run, controller)) return;
        if (found?.status === "unavailable") {
          return fail([messages.nameUnavailable, found.unavailableReason].filter(Boolean).join(" "));
        }
        const releases = found ? releasesOf(title, found.matches) : [];
        if (!releases.length) return fail(messages.versionsNoMatch);
        setState((current) => ({ ...current, busy: false, stage: "", versions: releases }));
      } catch (error) {
        if (stale(run, controller)) return;
        fail(describeError(error, messages.failed));
      }
    },
    [begin, fail, messages, onProgress, stale],
  );

  /** Back from a title's releases to the title list, which is kept. */
  const leaveTitle = useCallback(() => {
    cancel();
    setState((current) => ({ ...current, busy: false, error: "", stage: "", title: undefined, versions: [] }));
  }, [cancel]);

  return { ...state, choose, chooseTitle, clear, leaveTitle, search, setText };
};

export { useRomLookup, type RomLookupMessages };
