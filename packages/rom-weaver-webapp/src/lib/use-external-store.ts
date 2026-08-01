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
  const useServerSnapshot = useServerSnapshotForInitialRender;
  const [snapshot, setSnapshot] = useState(() => (useServerSnapshot ? getServerSnapshot() : getSnapshot()));
  useLayoutEffect(() => {
    const update = () => {
      const next = getSnapshot();
      setSnapshot((current) => (Object.is(current, next) ? current : next));
    };
    update();
    return subscribe(update);
  }, [getSnapshot, subscribe]);
  // A parent render can observe a store's current value before the store's
  // listener effect gets a chance to schedule setSnapshot. Return the live
  // value for client renders so consumers never paint that stale pass; the
  // state above remains the subscription's render trigger and hydration still
  // starts from the server snapshot.
  return useServerSnapshot ? snapshot : getSnapshot();
};

export { setExternalStoreHydrating, useExternalStore };
