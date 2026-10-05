import { useEffect, useState } from "react";
import { APP_BUILD_VERSION } from "./build-version.ts";

const STORAGE_KEY = `rom-weaver-whats-new:${APP_BUILD_VERSION}`;
const PROMPT_DURATION = 2 * 60 * 60 * 1000;

type PromptVisit = { build: string; firstSeen: number; used: boolean };

const readVisit = (): PromptVisit => {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as PromptVisit | null;
    if (
      stored?.build === APP_BUILD_VERSION &&
      Number.isFinite(stored.firstSeen) &&
      stored.firstSeen <= Date.now() &&
      typeof stored.used === "boolean"
    )
      return stored;
  } catch {
    // Storage MAY be unavailable in private browsing.
  }
  return { build: APP_BUILD_VERSION, firstSeen: Date.now(), used: false };
};

const useWhatsNewPrompt = (opened: boolean) => {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [visit, setVisit] = useState(readVisit);
  const [expired, setExpired] = useState(() => Date.now() >= visit.firstSeen + PROMPT_DURATION);
  useEffect(() => {
    if (opened) setVisit((previous) => (previous.used ? previous : { ...previous, used: true }));
  }, [opened]);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(visit));
    } catch {
      // The prompt MUST still work for this session when storage is unavailable.
    }
    const remaining = visit.firstSeen + PROMPT_DURATION - Date.now();
    if (remaining <= 0) {
      setExpired(true);
      return;
    }
    const timer = window.setTimeout(() => setExpired(true), remaining);
    return () => window.clearTimeout(timer);
  }, [visit]);
  useEffect(() => {
    const syncVisit = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      const next = readVisit();
      setVisit(next);
      setExpired(Date.now() >= next.firstSeen + PROMPT_DURATION);
    };
    window.addEventListener("storage", syncVisit);
    return () => window.removeEventListener("storage", syncVisit);
  }, []);
  return hydrated && !(opened || visit.used || expired);
};

export { useWhatsNewPrompt };
