import type { ReactNode } from "react";
import { type DownloadMeta, FileProgress, type FileProgressProps, RunButton } from "./feedback.tsx";
import { StepSection } from "./layout.tsx";
import { OutputCard, type OutputCardProps } from "./output-card.tsx";

type WorkflowOutputStepProps = OutputCardProps & {
  fault?: boolean;
  id?: string;
  info?: ReactNode;
  meta?: ReactNode;
  notice?: ReactNode;
  num: string;
  title: ReactNode;
  woven?: boolean;
};

type OutputRunActionProps = {
  children: ReactNode;
  disabled?: boolean;
  download?: DownloadMeta;
  icon?: ReactNode;
  id?: string;
  onClick?: () => void;
  progress?: FileProgressProps | null;
};

const WorkflowOutputStep = ({
  fault,
  id,
  info,
  meta,
  notice,
  num,
  title,
  woven,
  ...output
}: WorkflowOutputStepProps) => (
  <StepSection fault={fault} id={id} info={info} meta={meta} num={num} title={title} woven={woven}>
    <OutputCard {...output} />
    {notice}
  </StepSection>
);

const OutputRunAction = ({ children, disabled, download, icon, id, onClick, progress }: OutputRunActionProps) => (
  <>
    {progress ? <FileProgress {...progress} run /> : null}
    {progress ? null : (
      <RunButton disabled={disabled} download={download} icon={icon} id={id} onClick={onClick}>
        {children}
      </RunButton>
    )}
  </>
);

export { OutputRunAction, WorkflowOutputStep };
