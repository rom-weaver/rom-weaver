import { type MutableRefObject, useRef } from "react";

// Keeps the latest value reachable from a stable ref, so callbacks can read fresh state without
// re-subscribing to it as a dependency. Lets event-handler hooks return stable identities while still
// operating on the current render's values (read once at invocation time).
const useLatestRef = <T>(value: T): MutableRefObject<T> => {
  const ref = useRef(value);
  ref.current = value;
  return ref;
};

export { useLatestRef };
