export const navigatorWith = (overrides: Record<string, unknown>): Navigator => {
  return new Proxy(navigator, {
    get(target, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) {
        return overrides[property as string];
      }
      return Reflect.get(target, property, target);
    },
  });
};
