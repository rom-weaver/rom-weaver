import { useCallback, useEffect, useRef, useState } from "react";
import { lookupExpectedRom } from "../../lib/apply/expected-rom-lookup.ts";
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
    // The previous answer stays up while the next one is looked up: a card the
    // user is refining MUST NOT vanish and flip the bench back to the hero.
    setState((current) => ({ ...current, busy: true, error: "", stage: "" }));
    try {
      const checks = { checksums: { [algorithm]: hash } };
      const found = await lookupExpectedRom(checks, {
        onProgress: (progress) => {
          if (runRef.current !== run) return;
          setState((current) => ({ ...current, stage: progress.message || progress.label || "" }));
        },
        signal: controller.signal,
      });
      if (runRef.current !== run) return;
      if (!found || found.status === "unavailable") {
        setState((current) => ({
          ...current,
          busy: false,
          error: found
            ? "The identification data is not available on this device, so this checksum cannot be looked up."
            : "No ROM in the identification data has this checksum.",
          stage: "",
        }));
        return;
      }
      setState((current) => ({ ...current, busy: false, stage: "", result: { checks, identification: found } }));
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
