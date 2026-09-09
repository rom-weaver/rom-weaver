import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ExpectedRomPlatform,
  listExpectedRomPlatforms,
  searchExpectedRomByName,
} from "../../lib/apply/expected-rom-lookup.ts";
import { identifyRecordChecks } from "../../lib/identify/identify-record-checks.ts";
import type { ParsedBundleChecks } from "../../types/bundle.ts";
import type { ParsedIdentifyResolution, ParsedIdentifyTitleMatch } from "../../types/identify.ts";

/** Smallest query the search accepts; one character matches most of a pack. */
const MIN_QUERY_LENGTH = 2;

/** Most titles one search returns. The command truncates to the same number. */
const RESULT_LIMIT = 50;

/** A title the user picked, shaped like the checksum path's answer. */
type RomNameLookupResult = {
  checks: ParsedBundleChecks;
  identification: ParsedIdentifyResolution;
};

type RomNameLookupMessages = {
  failed: string;
  noMatch: string;
  platformsFailed: string;
  tooShort: string;
  unavailable: string;
};

type RomNameLookupState = {
  busy: boolean;
  error: string;
  filter: string;
  matches: ParsedIdentifyTitleMatch[];
  platform: ExpectedRomPlatform | undefined;
  platforms: ExpectedRomPlatform[];
  /** False until the catalog request settles, so an empty list is not yet an answer. */
  platformsLoaded: boolean;
  result: RomNameLookupResult | undefined;
  stage: string;
  text: string;
};

const IDLE: RomNameLookupState = {
  busy: false,
  error: "",
  filter: "",
  matches: [],
  platform: undefined,
  platforms: [],
  platformsLoaded: false,
  result: undefined,
  stage: "",
  text: "",
};

const normalize = (value: string) => value.trim().toLowerCase();

/**
 * Platforms whose display name or pack slug contains every word of the filter.
 * 144 platforms do not fit a list the user scrolls, so the filter is the way in.
 */
const filterPlatforms = (platforms: readonly ExpectedRomPlatform[], filter: string): ExpectedRomPlatform[] => {
  const words = normalize(filter).split(/\s+/u).filter(Boolean);
  if (!words.length) return [...platforms];
  return platforms.filter((entry) => {
    const haystack = `${entry.platform} ${entry.slug}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
};

/** The expectation a chosen title asserts: the record's own checksums and size. */
const checksForMatch = (match: ParsedIdentifyTitleMatch): ParsedBundleChecks => {
  const record = identifyRecordChecks({ matches: [match], status: "matched" });
  if (!record) return { checksums: {} };
  return { checksums: record.checksums, ...(record.size === undefined ? {} : { size: record.size }) };
};

/**
 * The apply page's second file-free way to answer "which ROM do I need": the
 * user picks a platform, searches its titles by name, and picks one. A name
 * cannot be routed to a pack the way a checksum can, so the platform is
 * required and exactly that platform's pack loads. Like the checksum hook, the
 * search runs only on an explicit submit, never on typing.
 */
const useRomNameLookup = (messages: RomNameLookupMessages) => {
  const [state, setState] = useState<RomNameLookupState>(IDLE);
  const abortRef = useRef<AbortController | undefined>(undefined);
  // A late answer from a superseded search must not overwrite a newer one.
  const runRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  // The catalog costs a fetch, and most apply runs never open this search, so
  // the list loads on the first interaction with the picker rather than on
  // mount. It is requested once per hook instance.
  const platformsRequestedRef = useRef(false);
  const loadPlatforms = useCallback(() => {
    if (platformsRequestedRef.current) return;
    platformsRequestedRef.current = true;
    void listExpectedRomPlatforms()
      .then((platforms) => {
        if (mountedRef.current) setState((current) => ({ ...current, platforms, platformsLoaded: true }));
      })
      .catch(() => {
        if (mountedRef.current) {
          setState((current) => ({ ...current, error: messages.platformsFailed, platformsLoaded: true }));
        }
      });
  }, [messages.platformsFailed]);

  const setFilter = useCallback(
    (filter: string) => {
      loadPlatforms();
      setState((current) => ({ ...current, filter }));
    },
    [loadPlatforms],
  );

  const setText = useCallback((text: string) => {
    setState((current) => ({ ...current, error: "", text }));
  }, []);

  const choosePlatform = useCallback((platform: ExpectedRomPlatform) => {
    runRef.current += 1;
    abortRef.current?.abort();
    setState((current) => ({
      ...current,
      busy: false,
      error: "",
      filter: platform.platform,
      matches: [],
      platform,
      stage: "",
    }));
  }, []);

  const clearPlatform = useCallback(() => {
    runRef.current += 1;
    abortRef.current?.abort();
    setState((current) => ({ ...current, busy: false, error: "", filter: "", matches: [], platform: undefined }));
  }, []);

  const clear = useCallback(() => {
    runRef.current += 1;
    abortRef.current?.abort();
    setState((current) => ({ ...IDLE, platforms: current.platforms }));
  }, []);

  const choose = useCallback((match: ParsedIdentifyTitleMatch) => {
    setState((current) => ({
      ...current,
      result: { checks: checksForMatch(match), identification: { matches: [match], status: "matched" } },
    }));
  }, []);

  const search = useCallback(async () => {
    const platform = state.platform;
    const query = state.text.trim();
    if (!platform) return;
    if (query.length < MIN_QUERY_LENGTH) {
      setState((current) => ({ ...current, error: messages.tooShort }));
      return;
    }
    runRef.current += 1;
    const run = runRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    // The previous list stays up while the next one loads, so a user who is
    // refining a query never watches the results disappear and come back.
    setState((current) => ({ ...current, busy: true, error: "", stage: "" }));
    try {
      const found = await searchExpectedRomByName(platform.slug, query, {
        limit: RESULT_LIMIT,
        onProgress: (progress) => {
          if (runRef.current !== run) return;
          setState((current) => ({ ...current, stage: progress.message || progress.label || "" }));
        },
        signal: controller.signal,
      });
      if (runRef.current !== run || !mountedRef.current) return;
      if (!found || found.status === "unavailable") {
        setState((current) => ({
          ...current,
          busy: false,
          error: found ? [messages.unavailable, found.unavailableReason].filter(Boolean).join(" ") : messages.noMatch,
          matches: [],
          stage: "",
        }));
        return;
      }
      setState((current) => ({ ...current, busy: false, matches: found.matches, stage: "" }));
    } catch (error) {
      if (runRef.current !== run || controller.signal.aborted || !mountedRef.current) return;
      setState((current) => ({
        ...current,
        busy: false,
        error: error instanceof Error ? error.message : messages.failed,
        stage: "",
      }));
    }
  }, [messages.failed, messages.noMatch, messages.tooShort, messages.unavailable, state.platform, state.text]);

  return {
    ...state,
    choose,
    choosePlatform,
    clear,
    clearPlatform,
    filteredPlatforms: filterPlatforms(state.platforms, state.filter),
    loadPlatforms,
    search,
    setFilter,
    setText,
  };
};

export { useRomNameLookup };
