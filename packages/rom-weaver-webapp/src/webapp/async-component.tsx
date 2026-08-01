import { createElement } from "preact";
import type { ComponentChildren, ComponentType, RenderableProps } from "preact";
import { useEffect, useState } from "preact/hooks";

type AsyncComponentLoader<Props> = () => Promise<{ default: ComponentType<Props> }>;

function createAsyncComponent<Props>(load: AsyncComponentLoader<Props>) {
  let loaded: ComponentType<Props> | null = null;
  let pending: Promise<ComponentType<Props>> | null = null;
  const subscribers = new Set<(component: ComponentType<Props>) => void>();

  const preload = (): Promise<ComponentType<Props>> => {
    pending ??= load()
      .then(({ default: component }) => {
        loaded = component;
        for (const subscriber of subscribers) subscriber(component);
        return component;
      })
      .catch((error) => {
        pending = null;
        throw error;
      });
    return pending;
  };

  const Component = (props: Props): ComponentChildren => {
    const [resolved, setResolved] = useState<ComponentType<Props> | null>(() => loaded);
    const [retryGeneration, setRetryGeneration] = useState(0);
    // biome-ignore lint/correctness/useExhaustiveDependencies: retryGeneration deliberately retriggers after a failed lazy import.
    useEffect(() => {
      if (resolved) return undefined;
      let active = true;
      let retryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
      const receive = (component: ComponentType<Props>) => {
        if (active) setResolved(() => component);
      };
      subscribers.add(receive);
      void preload()
        .then(receive)
        .catch(() => {
          if (active) {
            retryTimer = globalThis.setTimeout(() => setRetryGeneration((generation) => generation + 1), 1000);
          }
        });
      return () => {
        active = false;
        subscribers.delete(receive);
        if (retryTimer !== undefined) globalThis.clearTimeout(retryTimer);
      };
    }, [resolved, retryGeneration]);
    if (!resolved) return null;
    const Resolved = resolved;
    return createElement(Resolved, props as RenderableProps<Props>);
  };

  return { Component, preload };
}

export { createAsyncComponent };
