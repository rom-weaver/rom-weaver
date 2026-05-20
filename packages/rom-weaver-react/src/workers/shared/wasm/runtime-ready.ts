import type { EmscriptenWorkerModule } from "./emscripten-types.ts";

const waitForRuntimeInitialized = (
  moduleObject: EmscriptenWorkerModule,
  isReady: (moduleObject: EmscriptenWorkerModule) => boolean,
) => {
  if (isReady(moduleObject)) return Promise.resolve(moduleObject);
  return new Promise<EmscriptenWorkerModule>((resolve) => {
    const previousOnRuntimeInitialized = moduleObject.onRuntimeInitialized;
    moduleObject.onRuntimeInitialized = () => {
      if (previousOnRuntimeInitialized) previousOnRuntimeInitialized();
      resolve(moduleObject);
    };
  });
};

export { waitForRuntimeInitialized };
