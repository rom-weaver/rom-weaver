import { afterEach, describe, expect, it } from "vitest";
import { isInsideLocalDropZone } from "../../src/webapp/use-page-drag.ts";

const buildZone = () => {
  const app = document.createElement("div");
  app.className = "rw-app";
  const zone = document.createElement("label");
  zone.className = "drop hero";
  const title = document.createElement("span");
  zone.append(title);
  app.append(zone);
  document.body.append(app);
  return { app, title, zone };
};

// What the page-level drop listener sees for a bubbling `drop`: the verdict is read from a document
// listener, after any listener on the zone has run.
const verdictAtDocument = (dispatchOn) => {
  let verdict;
  const listener = (event) => {
    verdict = isInsideLocalDropZone(event);
  };
  document.addEventListener("drop", listener);
  try {
    dispatchOn.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
  } finally {
    document.removeEventListener("drop", listener);
  }
  return verdict;
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("isInsideLocalDropZone", () => {
  it("recognizes a drop on a zone and on a child of it", () => {
    const { title, zone } = buildZone();
    expect(verdictAtDocument(zone)).toBe(true);
    expect(verdictAtDocument(title)).toBe(true);
  });

  it("recognizes a drop on a child the zone's own handler detached", () => {
    const { title, zone } = buildZone();
    // The Apply hero re-renders on drop, replacing its title, bead, and copy nodes before the
    // document listener runs; `title.closest()` no longer reaches the zone by then.
    zone.addEventListener("drop", () => title.remove());
    expect(verdictAtDocument(title)).toBe(true);
    expect(title.isConnected).toBe(false);
    expect(title.closest(".rw-app .drop")).toBeNull();
  });

  it("rejects a drop outside every zone", () => {
    const { app } = buildZone();
    const outside = document.createElement("p");
    app.append(outside);
    expect(verdictAtDocument(outside)).toBe(false);
    expect(verdictAtDocument(document.body)).toBe(false);
  });

  it("requires the zone to sit inside the app", () => {
    const stray = document.createElement("div");
    stray.className = "drop";
    document.body.append(stray);
    expect(verdictAtDocument(stray)).toBe(false);
  });
});
