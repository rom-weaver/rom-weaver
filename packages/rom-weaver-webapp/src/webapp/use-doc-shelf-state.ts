import { useCallback, useEffect, useLayoutEffect, useState } from "react";

type DocShelfState = Record<string, boolean>;
type DocShelf = { title: string };
const DOC_SHELF_STATE_KEY = "rom-weaver-docs-shelves";
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const readDocShelfState = (shelves: readonly DocShelf[]): DocShelfState => {
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(sessionStorage.getItem(DOC_SHELF_STATE_KEY) || "{}");
  } catch {
    // The navigation MUST remain usable when storage is blocked.
  }
  return Object.fromEntries(
    shelves.map((shelf, index) => [
      shelf.title,
      typeof stored?.[shelf.title] === "boolean" ? stored[shelf.title] : index === 0,
    ]),
  ) as DocShelfState;
};

const useDocShelfState = (shelves: readonly DocShelf[]) => {
  const [openShelves, setOpenShelves] = useState(() => readDocShelfState(shelves));
  const [ready, setReady] = useState(false);
  useIsomorphicLayoutEffect(() => {
    setOpenShelves(readDocShelfState(shelves));
    setReady(true);
  }, [shelves]);
  const onShelfToggle = useCallback(
    (title: string, open: boolean) => {
      if (!ready) return;
      setOpenShelves((current) => {
        if (current[title] === open) return current;
        const next = { ...current, [title]: open };
        try {
          const stored = JSON.parse(sessionStorage.getItem(DOC_SHELF_STATE_KEY) || "{}");
          sessionStorage.setItem(DOC_SHELF_STATE_KEY, JSON.stringify({ ...stored, ...next }));
        } catch {
          // The navigation MUST remain usable when storage is blocked.
        }
        return next;
      });
    },
    [ready],
  );
  return { onShelfToggle, openShelves };
};

export { useDocShelfState };
export type { DocShelfState };
