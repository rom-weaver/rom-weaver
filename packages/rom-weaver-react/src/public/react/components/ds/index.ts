/**
 * Dark-pro design-system primitives. Workflow-agnostic, prop-driven building
 * blocks shared by the apply, create, and trim forms and the app shell, so the
 * redesigned UI is composed without duplicating markup.
 */

export { ChecksumList, ChecksumRow } from "./checksum-list.tsx";
export {
  buildOutputCompressionPanel,
  CompressPanelBody,
  getOutputCompressionFormatLabel,
  type OutputCompressionPanelConfig,
} from "./compress-panel.tsx";
export { Drawer, DrawerMark, DrawerReadout } from "./drawer.tsx";
export {
  ExtractDrawer,
  type ExtractionLevel,
  ExtractionTree,
  ExtractName,
  ExtractPanel,
  type ExtractPanelProps,
} from "./extraction-tree.tsx";
export {
  type DownloadMeta,
  FileProgress,
  type FileProgressProps,
  InlineProgress,
  Notice,
  type NoticeLevel,
  ProgressTrack,
  RunButton,
} from "./feedback.tsx";
export { FileCard, type FileState, FileTargetPill, RemoveButton } from "./file-card.tsx";
export { FixesPanel, type FixesPanelProps, type TrimFixDetails } from "./fixes-panel.tsx";
export { DropZone, InfoPopover, NeedsInput, StepSection } from "./layout.tsx";
export { ConfirmDialog, Modal, ModalShell } from "./modal.tsx";
export {
  type FormatOption,
  OutputCard,
  type OutputCardProps,
  type OutputCompressPanel,
  OutputField,
} from "./output-card.tsx";
export { type RomInputInfoPanelProps, RomInputPanels, type RomInputPanelsProps } from "./rom-input-panels.tsx";
export { type SelectionItem, SelectionTree } from "./selection.tsx";
export { type SourceInfoChecksums, SourceInfoList, type SourceInfoProgress } from "./source-info-list.tsx";
export {
  OutputRunAction,
  type OutputRunActionProps,
  WorkflowOutputStep,
  type WorkflowOutputStepProps,
} from "./workflow-output-step.tsx";
export {
  WorkflowRomInputStep,
  type WorkflowRomInputStepItem,
  type WorkflowRomInputStepProps,
} from "./workflow-rom-input-step.tsx";
