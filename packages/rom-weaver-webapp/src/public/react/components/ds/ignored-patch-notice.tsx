import { useUiLocalizer } from "../../settings-context.tsx";
import { Notice } from "./feedback.tsx";

/**
 * Create and Trim have no patch bucket, so patch files dropped on them are
 * discarded. That used to happen in silence, which reads as a broken drop. Say
 * what was dropped and offer the one-click move to the tab that can use it.
 */
const IgnoredPatchDropNotice = ({
  fileNames,
  onDismiss,
  onOpenApplyTab,
}: {
  fileNames: readonly string[];
  onDismiss: () => void;
  onOpenApplyTab?: () => void;
}) => {
  const localizer = useUiLocalizer();
  if (!fileNames.length) return null;
  return (
    <Notice
      actions={
        onOpenApplyTab ? (
          <button className="btn ghost slim" onClick={onOpenApplyTab} type="button">
            {localizer.message("ui.drop.openApply")}
          </button>
        ) : null
      }
      id="rom-weaver-notice-ignored-patches"
      level="warn"
      onDismiss={onDismiss}
    >
      {localizer.messageCount("ui.drop.ignoredPatches", fileNames.length, {
        names: localizer.formatList([...fileNames]),
      })}
    </Notice>
  );
};

export { IgnoredPatchDropNotice };
