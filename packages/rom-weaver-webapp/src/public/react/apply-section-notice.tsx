import { Notice } from "./components/ds/feedback.tsx";
import type { NoticeState } from "./patcher-ui-state.ts";

export const SectionNotice = ({
  id,
  onDismiss,
  state,
}: {
  id?: string;
  onDismiss?: () => void;
  state: NoticeState;
}) => {
  if (!state.visible) return null;
  return (
    <Notice
      id={id}
      level={state.level === "warning" ? "warn" : "error"}
      onDismiss={state.dismissible ? onDismiss : undefined}
    >
      {state.message}
    </Notice>
  );
};
