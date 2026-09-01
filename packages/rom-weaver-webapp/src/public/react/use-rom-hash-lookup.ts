import { useCallback, useEffect, useRef, useState } from "react";
import type { ParsedBundleChecks } from "../../types/bundle.ts";
import type { ParsedIdentifyResolution } from "../../types/identify.ts";
import { identifyHashAlgorithm } from "../../types/identify.ts";

/** A checksum the user pasted, once the identify data has answered for it. */
type RomHashLookupResult = {
  checks: ParsedBundleChecks;
  identification: ParsedIdentifyResolution;
};

type RomHashLookupState = {
  busy: boolean;
  error: string;
  result: RomHashLookupResult | undefined;
  stage: string;
  text: string;
};

const IDLE: RomHashLookupState = { busy: false, error: "", result: undefined, stage: "", text: "" };

/**
 * The apply page's file-free way to answer "which ROM do I need": the user
 * pastes a checksum, and the local identify data turns it into an expected-ROM
 * card. Same lookup the identify page runs, and the same full pack load, so it
 * only ever starts from an explicit submit - never from typing.
 */
const useRomHashLookup = (messages: { invalid: string; invalidChars: string }) => {
  const [state, setState] = useState<RomHashLookupState>(IDLE);
  const abortRef = useRef<AbortController | undefined>(undefined);
  // A late answer from a superseded search must not overwrite a newer one.
  const runRef = useRef(0);
  useEffect(() => () => abortRef.current?.abort(), []);

  const setText = useCallback((text: string) => {
    setState((current) => ({ ...current, error: "", text }));
  }, []);

  const clear = useCallback(() => {
    runRef.current += 1;
    abortRef.current?.abort();
    setState(IDLE);
  }, []);

  const search = useCallback(async () => {
    const hash = state.text.trim().toLowerCase();
    const algorithm = identifyHashAlgorithm(hash);
    if (!algorithm) {
      setState((current) => ({
        ...current,
        error: /[^0-9a-f]/.test(hash) ? messages.invalidChars : messages.invalid,
      }));
      return;
    }
    runRef.current += 1;
    const run = runRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState((current) => ({ ...current, busy: true, error: "", result: undefined, stage: "" }));
    try {
      const { identifyChecks } = await import("../../platform/browser/browser-api.ts");
      const result = await identifyChecks(
        { checksums: { [algorithm]: hash } },
        {
          onProgress: (progress) => {
            if (runRef.current !== run) return;
            setState((current) => ({ ...current, stage: progress.message || progress.label || "" }));
          },
          signal: controller.signal,
        },
      );
      if (runRef.current !== run) return;
      const candidate = result.candidates[0];
      if (!candidate || candidate.status === "unavailable") {
        setState((current) => ({
          ...current,
          busy: false,
          error: "The identification data is not available on this device, so this checksum cannot be looked up.",
          stage: "",
        }));
        return;
      }
      if (!candidate.matches.length) {
        setState((current) => ({
          ...current,
          busy: false,
          error: "No ROM in the identification data has this checksum.",
          stage: "",
        }));
        return;
      }
      setState((current) => ({
        ...current,
        busy: false,
        stage: "",
        result: {
          checks: { checksums: { [algorithm]: hash } },
          identification: { matches: candidate.matches, status: candidate.status },
        },
      }));
    } catch (error) {
      if (runRef.current !== run || controller.signal.aborted) return;
      setState((current) => ({
        ...current,
        busy: false,
        error: error instanceof Error ? error.message : "The checksum lookup failed.",
        stage: "",
      }));
    }
  }, [messages.invalid, messages.invalidChars, state.text]);

  return { ...state, clear, search, setText };
};

export { useRomHashLookup };
