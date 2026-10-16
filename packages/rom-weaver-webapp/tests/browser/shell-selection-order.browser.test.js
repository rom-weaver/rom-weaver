import { createElement, useLayoutEffect, useRef, useState } from "react";
import { hydrateRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import indexHtml from "../../index.html?raw";
import { readDataTransferFiles } from "../../src/lib/input/dropped-files.ts";
import { useInputUiController } from "../../src/public/react/use-patcher-controllers.ts";
import { useUnifiedApplyDrop } from "../../src/public/react/use-unified-apply-drop.ts";
import { captureShellClicks, replayShellSelections } from "../../src/webapp/shell-click-replay.ts";

const MARKUP =
  '<section aria-label="Apply files"><label>Choose files<input id="ordered-files" type="file" multiple=""></label><output id="selected-rom"></output><ol id="selected-patches"></ol></section>';
const noop = () => undefined;
let appRoot;
let reactRoot;
let frame;
let replayTask;
let received;
let receivedFiles;

const dispatchSelection = (kind, name) => {
  const input = appRoot.querySelector("input");
  const transfer = new DataTransfer();
  transfer.items.add(new File([name], name));
  if (kind === "pick") {
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    input.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }
};

const runFrame = () => {
  const callback = frame;
  frame = undefined;
  const timeout = vi.spyOn(window, "setTimeout").mockImplementationOnce((callback) => {
    replayTask = callback;
    return 0;
  });
  try {
    callback(performance.now());
  } finally {
    timeout.mockRestore();
  }
};
const runReplayTask = () => {
  const callback = replayTask;
  replayTask = undefined;
  callback();
};

const App = () => {
  const latest = useRef({ inputs: [], patches: [] });
  const [selection, setSelection] = useState(latest.current);
  const update = (key, files) => {
    latest.current = { ...latest.current, [key]: files };
    setSelection(latest.current);
  };
  const controller = useInputUiController({
    actions: {
      clearDismissibleErrors: noop,
      emitSessionTrace: noop,
      invalidateCompletedOutputState: noop,
      invalidatePatchStage: noop,
      setChecksumOverrideChecked: noop,
      setErrorMessage: noop,
      setFailurePlacement: noop,
      setOutputErrorMessage: noop,
      setPatchProgress: noop,
      setPatchProgressByKey: noop,
      setPatchStaging: noop,
      setProgress: noop,
      setRomInputs: noop,
      updateInputs: (files) => update("inputs", files),
      updatePatches: (files) => update("patches", files),
    },
    state: {
      get activePatches() {
        return latest.current.patches;
      },
      get effectiveInputs() {
        return latest.current.inputs;
      },
      failurePlacement: null,
      outputErrorMessage: "",
      romInputs: [],
    },
  });
  const { onDrop } = useUnifiedApplyDrop(controller);
  const deliver = (files) => {
    received.push(files.map((file) => file.name));
    receivedFiles.push(files);
    onDrop(files);
  };
  useLayoutEffect(() => {
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementationOnce((callback) => {
      frame = callback;
      return 0;
    });
    try {
      replayShellSelections(appRoot);
    } finally {
      raf.mockRestore();
    }
  }, []);
  return createElement(
    "section",
    {
      "aria-label": "Apply files",
      onDrop: (event) => {
        event.preventDefault();
        void readDataTransferFiles(event.dataTransfer).then(deliver);
      },
    },
    createElement(
      "label",
      null,
      "Choose files",
      createElement("input", {
        id: "ordered-files",
        type: "file",
        multiple: true,
        onChange: (event) => {
          deliver(Array.from(event.currentTarget.files));
          event.currentTarget.value = "";
        },
      }),
    ),
    createElement("output", { id: "selected-rom" }, selection.inputs[0]?.name || ""),
    createElement(
      "ol",
      { id: "selected-patches" },
      selection.patches.map((file) => createElement("li", { key: file.name }, file.name)),
    ),
  );
};

beforeEach(() => {
  received = [];
  receivedFiles = [];
  frame = undefined;
  replayTask = undefined;
  appRoot = document.createElement("div");
  appRoot.innerHTML = MARKUP;
  document.body.append(appRoot);
  const source = indexHtml.match(/<script>\s*\/\/ Buffer clicks[\s\S]*?<\/script>/)[0];
  const script = document.createElement("script");
  script.textContent = source.replace(/^<script>|<\/script>$/g, "");
  document.head.append(script);
  script.remove();
});
afterEach(async () => {
  if (frame) runFrame();
  if (replayTask) runReplayTask();
  await new Promise((resolve) => setTimeout(resolve, 0));
  reactRoot?.unmount();
  reactRoot = undefined;
  window.ROM_WEAVER_SHELL_CLICKS?.stop();
  window.ROM_WEAVER_SHELL_CLICKS?.stopSelections();
  delete window.ROM_WEAVER_SHELL_CLICKS;
  appRoot.remove();
});

const hydrate = () => {
  captureShellClicks();
  reactRoot = hydrateRoot(appRoot, createElement(App));
};

for (const kind of ["pick", "drop"]) {
  for (const timing of ["before-commit", "before-frame", "before-task"]) {
    for (const extension of ["sfc", "ips"]) {
      test(`${kind} keeps ${extension} selection order ${timing}`, async () => {
        dispatchSelection(kind, `old.${extension}`);
        hydrate();
        if (timing === "before-commit") dispatchSelection(kind, `new.${extension}`);
        await expect.poll(() => typeof frame).toBe("function");
        if (timing === "before-frame") dispatchSelection(kind, `new.${extension}`);
        runFrame();
        if (timing === "before-task") dispatchSelection(kind, `new.${extension}`);
        runReplayTask();
        await expect.poll(() => received.length).toBe(2);
        expect(received).toEqual([[`old.${extension}`], [`new.${extension}`]]);
        if (extension === "sfc") {
          await expect.poll(() => appRoot.querySelector("#selected-rom").textContent).toBe("new.sfc");
        } else {
          await expect
            .poll(() => Array.from(appRoot.querySelectorAll("li"), (item) => item.textContent))
            .toEqual(["old.ips", "new.ips"]);
        }
        dispatchSelection(kind, "live.ips");
        await expect.poll(() => received.at(-1)).toEqual(["live.ips"]);
        expect(received).toHaveLength(3);
      });
    }
  }
  test(`${kind} retains a burst of additive patches during the handoff`, async () => {
    const names = Array.from({ length: 12 }, (_, index) => `patch-${index}.ips`);
    dispatchSelection(kind, names[0]);
    hydrate();
    await expect.poll(() => typeof frame).toBe("function");
    for (const name of names.slice(1)) dispatchSelection(kind, name);
    runFrame();
    runReplayTask();
    await expect.poll(() => received).toEqual(names.map((name) => [name]));
    await expect.poll(() => Array.from(appRoot.querySelectorAll("li"), (item) => item.textContent)).toEqual(names);
  });
  test(`${kind} retains early-only selections through real React and Apply routing`, async () => {
    dispatchSelection(kind, "old.sfc");
    dispatchSelection(kind, "old.ips");
    hydrate();
    await expect.poll(() => typeof frame).toBe("function");
    runFrame();
    runReplayTask();
    await expect.poll(() => received).toEqual([["old.sfc"], ["old.ips"]]);
    await expect.poll(() => appRoot.querySelector("#selected-rom").textContent).toBe("old.sfc");
    await expect.poll(() => appRoot.querySelector("li")?.textContent).toBe("old.ips");
  });
}

const entryFile = (name, bytes) => ({
  name,
  isFile: true,
  isDirectory: false,
  file: (resolve) => resolve(new File([new Uint8Array(bytes)], name)),
});

const dropFolder = (extension) => {
  let release;
  let readStarted = false;
  let available = true;
  const first = entryFile(`folder-first.${extension}`, [1, 2, 3]);
  const second = entryFile(`folder-second.${extension}`, [4, 5, 6]);
  const nested = {
    name: "nested",
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let batch = 0;
      return { readEntries: (resolve) => resolve(batch++ === 0 ? [second] : []) };
    },
  };
  const directory = {
    name: "folder",
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let batch = 0;
      return {
        readEntries: (resolve) => {
          if (batch++ === 0) {
            readStarted = true;
            release = () => resolve([first]);
          } else resolve(batch === 2 ? [nested] : []);
        },
      };
    },
  };
  const direct = new File([new Uint8Array([7, 8])], `direct.${extension}`);
  const transfer = new DataTransfer();
  transfer.items.add(new File([], "folder"));
  transfer.items.add(direct);
  Object.defineProperty(transfer, "items", {
    value: [
      { kind: "file", webkitGetAsEntry: () => (available ? directory : null), getAsFile: () => null },
      { kind: "file", webkitGetAsEntry: () => null, getAsFile: () => (available ? direct : null) },
    ],
  });
  appRoot
    .querySelector("input")
    .dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  available = false;
  return {
    get readStarted() {
      return readStarted;
    },
    release: () => release(),
  };
};

for (const timing of ["before-commit", "before-frame", "before-task"]) {
  for (const kind of ["pick", "drop"]) {
    for (const extension of ["sfc", "ips"]) {
      test(`folder ${extension} stays before a newer ${kind} during async traversal ${timing}`, async () => {
        let folder;
        if (timing === "before-commit") folder = dropFolder(extension);
        hydrate();
        await expect.poll(() => typeof frame).toBe("function");
        if (timing === "before-frame") folder = dropFolder(extension);
        runFrame();
        if (timing === "before-task") folder = dropFolder(extension);
        runReplayTask();
        await expect.poll(() => folder.readStarted).toBe(true);
        dispatchSelection(kind, `new.${extension}`);
        dispatchSelection("drop", "tail.ips");
        expect(received).toEqual([]);
        folder.release();
        await expect.poll(() => received.length).toBe(3);
        expect(received).toEqual([
          [`folder-first.${extension}`, `folder-second.${extension}`, `direct.${extension}`],
          [`new.${extension}`],
          ["tail.ips"],
        ]);
        expect(
          await Promise.all(receivedFiles[0].map(async (file) => Array.from(new Uint8Array(await file.arrayBuffer())))),
        ).toEqual([
          [1, 2, 3],
          [4, 5, 6],
          [7, 8],
        ]);
        if (extension === "sfc") {
          await expect.poll(() => appRoot.querySelector("#selected-rom").textContent).toBe("new.sfc");
        } else {
          await expect
            .poll(() => Array.from(appRoot.querySelectorAll("li"), (item) => item.textContent))
            .toEqual(["folder-first.ips", "folder-second.ips", "direct.ips", "new.ips", "tail.ips"]);
        }
        dispatchSelection("pick", "live.ips");
        await expect.poll(() => received.length).toBe(4);
        expect(received.at(-1)).toEqual(["live.ips"]);
      });
    }
  }
}
