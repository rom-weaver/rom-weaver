// Minimal framework-free state container for the webapp root controller. It replaces the single
// `zustand/vanilla` `createStore` use with the same store/subscribe pattern the rest of the app
// already hand-rolls (see `useLiveStoreController`), so the app carries no third-party store dep.
//
// Semantics match the slice of zustand we relied on: `setState` shallow-merges a partial (or the
// result of an updater) into the current state and synchronously notifies every subscriber with
// `(state, previousState)`; `subscribe` returns an unsubscribe function.
type StoreApi<TState> = {
  getState: () => TState;
  setState: (partial: Partial<TState> | ((state: TState) => Partial<TState>)) => void;
  subscribe: (listener: (state: TState, previousState: TState) => void) => () => void;
};

const createStore = <TState extends object>(initializer: () => TState): StoreApi<TState> => {
  let state = initializer();
  const listeners = new Set<(state: TState, previousState: TState) => void>();
  return {
    getState: () => state,
    setState: (partial) => {
      const partialState = typeof partial === "function" ? partial(state) : partial;
      const previousState = state;
      state = { ...state, ...partialState };
      for (const listener of listeners) listener(state, previousState);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

export { createStore };
