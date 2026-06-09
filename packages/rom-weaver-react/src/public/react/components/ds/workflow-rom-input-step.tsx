import type { ComponentProps, ReactNode } from "react";
import { ExtractPanel } from "./extraction-tree.tsx";
import { FileProgress } from "./feedback.tsx";
import { FileCard } from "./file-card.tsx";
import { DropZone, StepSection } from "./layout.tsx";
import { RomInputPanels } from "./rom-input-panels.tsx";

type WorkflowRomInputStepItem = {
  card?: Omit<ComponentProps<typeof FileCard>, "children" | "name"> & {
    children?: ReactNode;
    extract: ComponentProps<typeof ExtractPanel>;
    panels?: ComponentProps<typeof RomInputPanels>;
  };
  id: string;
  progress?: ComponentProps<typeof FileProgress> | null;
};

type WorkflowRomInputStepProps = Omit<ComponentProps<typeof StepSection>, "children"> & {
  afterItems?: ReactNode;
  dropZone?: ComponentProps<typeof DropZone> | null;
  items: WorkflowRomInputStepItem[];
  listId?: string;
  notice?: ReactNode;
};

const WorkflowRomInputStepRow = ({ item }: { item: WorkflowRomInputStepItem }) => {
  if (item.progress) return <FileProgress {...item.progress} />;
  if (!item.card) return null;
  const { children, extract, panels, ...cardProps } = item.card;
  return (
    <FileCard {...cardProps} name={<ExtractPanel {...extract} />}>
      {panels ? <RomInputPanels {...panels} /> : null}
      {children}
    </FileCard>
  );
};

const WorkflowRomInputStep = ({
  afterItems,
  dropZone,
  items,
  listId,
  notice,
  ...stepProps
}: WorkflowRomInputStepProps) => {
  const rows = items.map((item) => <WorkflowRomInputStepRow item={item} key={item.id} />);
  return (
    <StepSection {...stepProps}>
      {listId || rows.length ? (
        <div className="workflow-file-list" id={listId}>
          {rows}
        </div>
      ) : null}
      {afterItems ? <div className="workflow-step-after-items">{afterItems}</div> : null}
      {dropZone ? <DropZone {...dropZone} /> : null}
      {notice}
    </StepSection>
  );
};

export { WorkflowRomInputStep, type WorkflowRomInputStepItem, type WorkflowRomInputStepProps };
