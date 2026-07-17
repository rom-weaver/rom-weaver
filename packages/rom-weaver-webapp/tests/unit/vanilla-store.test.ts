import { describe, expect, it, vi } from "vitest";
import { createStore } from "../../src/webapp/vanilla-store.ts";

type Counter = { count: number; label: string };

const counterStore = () => createStore<Counter>(() => ({ count: 0, label: "start" }));

describe("createStore", () => {
  it("returns the initial state from getState", () => {
    expect(counterStore().getState()).toEqual({ count: 0, label: "start" });
  });

  it("shallow-merges a partial patch into a fresh state object", () => {
    const store = counterStore();
    const before = store.getState();
    store.setState({ count: 1 });
    expect(store.getState()).toEqual({ count: 1, label: "start" });
    expect(store.getState()).not.toBe(before);
  });

  it("supports updater functions reading current state", () => {
    const store = counterStore();
    store.setState({ count: 5 });
    store.setState((state) => ({ count: state.count + 1 }));
    expect(store.getState().count).toBe(6);
  });

  it("notifies subscribers with next and previous state", () => {
    const store = counterStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setState({ count: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ count: 2, label: "start" }, { count: 0, label: "start" });
  });

  it("stops notifying after unsubscribe", () => {
    const store = counterStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.setState({ count: 1 });
    unsubscribe();
    store.setState({ count: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies every active subscriber", () => {
    const store = counterStore();
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);
    store.setState({ label: "next" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
