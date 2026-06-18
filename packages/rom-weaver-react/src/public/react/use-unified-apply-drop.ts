import { useCallback, useRef, useState } from "react";
import { createLogger } from "../../lib/logging.ts";
import { probeApplyArchiveHasRom } from "./apply-archive-probe.ts";
import { classifyDroppedFiles } from "./file-classification.ts";
import { routeByTypeProbed } from "./unified-drop-routing.ts";

/**
 * Drop orchestration for the Apply tab that makes dropped files appear instantly.
 *
 * Bare ROMs/patches are known from their extension and route immediately. An
 * archive needs a listing to tell a ROM source from a patch container, so it gets
 * a lightweight "identifying…" placeholder the instant it lands — pure UI, not
 * staged — which is dropped once `routeByTypeProbed` resolves its bucket and the
 * real staging card takes over. Both the in-tab dropzone and the page-wide drop
 * forwarder funnel through one `onDrop` so they share placeholder behavior.
 */

const logger = createLogger("unified-apply-drop");

/** A dropped archive awaiting ROM-vs-patch classification, rendered as a placeholder card. */
type PendingDrop = {
  id: string;
  name: string;
};

type UnifiedDropController = {
  provideRomInputFiles?: (files: File[]) => void;
  providePatchInputFiles?: (files: File[]) => void;
};

type UnifiedApplyDrop = {
  pendingDrops: PendingDrop[];
  onDrop: (files: File[], isCancelled?: () => boolean) => void;
};

const useUnifiedApplyDrop = (controller: UnifiedDropController): UnifiedApplyDrop => {
  const [pendingDrops, setPendingDrops] = useState<PendingDrop[]>([]);
  // Monotonic id source — stable React keys without Math.random/Date.now churn.
  const nextIdRef = useRef(0);

  const onDrop = useCallback(
    (files: File[], isCancelled?: () => boolean) => {
      const { archives } = classifyDroppedFiles(files);
      // Show one placeholder per archive immediately; bare files carry no placeholder
      // because their bucket is already known and they stage without a listing wait.
      const pending = archives.map((archive) => {
        nextIdRef.current += 1;
        return { id: `pending-${nextIdRef.current}`, name: archive.name };
      });
      if (pending.length) setPendingDrops((current) => [...current, ...pending]);
      const pendingIds = new Set(pending.map((entry) => entry.id));
      const removePending = () =>
        pendingIds.size
          ? setPendingDrops((current) => current.filter((entry) => !pendingIds.has(entry.id)))
          : undefined;
      logger.trace("unified apply drop received files", {
        archiveCount: archives.length,
        fileCount: files.length,
      });
      void routeByTypeProbed(files, probeApplyArchiveHasRom).then(({ inputs, patches }) => {
        if (isCancelled?.()) {
          removePending();
          return;
        }
        // Stage immediately so extraction starts with no delay, then drop the placeholder — the real
        // staging card replaces it. Staging is never gated on the placeholder.
        if (inputs.length) controller.provideRomInputFiles?.(inputs);
        if (patches.length) controller.providePatchInputFiles?.(patches);
        removePending();
      });
    },
    [controller],
  );

  return { onDrop, pendingDrops };
};

export { type PendingDrop, useUnifiedApplyDrop };
