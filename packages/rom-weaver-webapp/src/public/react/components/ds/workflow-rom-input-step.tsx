import type { ComponentProps, ReactNode } from "react";
import { ExtractDrawer, ExtractName, type ExtractPanelProps } from "./extraction-tree.tsx";
import { FileProgress } from "./feedback.tsx";
import { FileCard } from "./file-card.tsx";
import { DropZone, StepSection } from "./layout.tsx";
import { RomInputPanels } from "./rom-input-panels.tsx";

type WorkflowRomInputStepItem = {
  card?: Omit<ComponentProps<typeof FileCard>, "children" | "name"> & {
    children?: ReactNode;
    extract: ExtractPanelProps & { always?: boolean };
    panels?: ComponentProps<typeof RomInputPanels>;
  };
  id: string;
  progress?: ComponentProps<typeof FileProgress> | null;
};

type WorkflowRomInputStepProps = Omit<ComponentProps<typeof StepSection>, "children"> & {
  afterItems?: ReactNode;
  dropZone?: ComponentProps<typeof DropZone> | null;
  /** Fixture shown in place of the (empty) card list when no ROM is loaded. */
  emptyState?: ReactNode;
  items: WorkflowRomInputStepItem[];
  listId?: string;
  notice?: ReactNode;
};

const WorkflowRomInputStepRow = ({ item }: { item: WorkflowRomInputStepItem }) => {
  if (item.progress) return <FileProgress {...item.progress} />;
  if (!item.card) return null;
  const { children, extract, panels, ...cardProps } = item.card;
  // The name line leads the card header; below it the drawers follow the shared
  // card order - Extract first, then the info panels (Options → sheets → Checks).
  return (
    <FileCard {...cardProps} name={<ExtractName {...extract} />}>
      <ExtractDrawer {...extract} />
      {children}
      {panels ? <RomInputPanels {...panels} /> : null}
    </FileCard>
  );
};

const WorkflowRomInputStep = ({
  afterItems,
  dropZone,
  emptyState,
  items,
  listId,
  notice,
  ...stepProps
}: WorkflowRomInputStepProps) => {
  const rows = items.map((item) => <WorkflowRomInputStepRow item={item} key={item.id} />);
  return (
    <StepSection {...stepProps}>
      {listId || rows.length ? (
        <div className="cards workflow-file-list" id={listId}>
          {rows}
        </div>
      ) : null}
      {rows.length === 0 && emptyState ? emptyState : null}
      {afterItems ? <div className="workflow-step-after-items">{afterItems}</div> : null}
      {dropZone ? <DropZone {...dropZone} /> : null}
      {notice}
    </StepSection>
  );
};

export { WorkflowRomInputStep, type WorkflowRomInputStepItem };
