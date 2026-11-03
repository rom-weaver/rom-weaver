import {
  type BrowserVirtualFileSource,
  getBrowserVirtualFileSource,
} from "../../workers/protocol/browser-virtual-files.ts";
import { readTextFromBrowserVfs } from "./workflow-runtime-vfs-cleanup.ts";

// Read a staged input's text whether it lives on OPFS or as an in-memory virtual file. File/Blob cue
// sources are served as virtual files (never written to OPFS), so the OPFS VFS `stat`/`read` returns
// nothing for them - the registry is the only place their bytes exist on the main thread.
const virtualSourceToText = async (source: BrowserVirtualFileSource): Promise<string> => {
  if (source instanceof Uint8Array) return new TextDecoder().decode(source);
  if (source instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(source));
  return source.text();
};

const readStagedCueText = async (cuePath: string): Promise<string> => {
  const virtualSource = getBrowserVirtualFileSource(cuePath);
  if (virtualSource) return virtualSourceToText(virtualSource);
  return readTextFromBrowserVfs(cuePath);
};

export { readStagedCueText };
