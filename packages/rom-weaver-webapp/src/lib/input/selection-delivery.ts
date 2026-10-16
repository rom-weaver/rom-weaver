const deliveries = new WeakMap<Event, Promise<void>>();

const trackSelectionDelivery = (event: Event, delivery: void | Promise<void>): void => {
  if (delivery) deliveries.set(event, delivery);
};

const dispatchSelectionDelivery = (target: EventTarget, event: Event): Promise<void> => {
  target.dispatchEvent(event);
  return deliveries.get(event) ?? Promise.resolve();
};

export { dispatchSelectionDelivery, trackSelectionDelivery };
