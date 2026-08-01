import { useLayoutEffect, useState } from "preact/hooks";

type Subscribe = (onStoreChange: () => void) => () => void;

let useServerSnapshotForInitialRender = typeof document === "undefined";

const setExternalStoreHydrating = (hydrating: boolean) => {
  useServerSnapshotForInitialRender = hydrating;
};

const useExternalStore = <Snapshot>(
  subscribe: Subscribe,
  getSnapshot: () => Snapshot,
  getServerSnapshot: () => Snapshot = getSnapshot,
): Snapshot => {
  const [snapshot, setSnapshot] = useState(() =>
    useServerSnapshotForInitialRender ? getServerSnapshot() : getSnapshot(),
  );
  useLayoutEffect(() => {
    const update = () => {
      const next = getSnapshot();
      setSnapshot((current) => (Object.is(current, next) ? current : next));
    };
    update();
    return subscribe(update);
  }, [getSnapshot, subscribe]);
  return snapshot;
};

export { setExternalStoreHydrating, useExternalStore };
