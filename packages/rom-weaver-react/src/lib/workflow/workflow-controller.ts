import type { CandidateSelectionRequest, SelectFile, SelectionChoice } from "../../types/selection.ts";
import { assertSelectionExists, resolveAutomaticSelection } from "../input/selection.ts";

abstract class WorkflowController<TEvents extends Record<string, unknown>> {
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  on<TEvent extends keyof TEvents & string>(event: TEvent, listener: (payload: TEvents[TEvent]) => void): void {
    const listeners = this.listeners.get(event) || new Set();
    listeners.add(listener as (payload: unknown) => void);
    this.listeners.set(event, listeners);
  }

  off<TEvent extends keyof TEvents & string>(event: TEvent, listener: (payload: TEvents[TEvent]) => void): void {
    this.listeners.get(event)?.delete(listener as (payload: unknown) => void);
  }

  protected trigger<TEvent extends keyof TEvents & string>(event: TEvent, payload: TEvents[TEvent]): void {
    const listeners = this.listeners.get(event);
    this.traceTriggerEvent(event, payload, listeners?.size || 0);
    if (!listeners?.size) return;
    for (const listener of [...listeners]) listener(payload);
  }

  protected clearListeners(): void {
    this.listeners.clear();
  }

  protected async resolveSelectionRequest(
    request: CandidateSelectionRequest,
    selectFile?: SelectFile,
  ): Promise<SelectionChoice | null> {
    const automatic = resolveAutomaticSelection(request);
    if (automatic) return automatic;
    if (typeof selectFile !== "function") return null;
    const selection = await Promise.resolve(selectFile(request));
    assertSelectionExists(request, selection);
    return selection;
  }

  protected abstract traceTriggerEvent<TEvent extends keyof TEvents & string>(
    event: TEvent,
    payload: TEvents[TEvent],
    listenerCount: number,
  ): void;
}

export { WorkflowController };
