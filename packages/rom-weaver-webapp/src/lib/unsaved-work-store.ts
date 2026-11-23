// Workflows that hold work a page reload would lose, but publish no workbench activity.
const workflowsWithWork = new Set<string>();

const setUnsavedWork = (workflowId: string, hasWork: boolean) => {
  if (hasWork) workflowsWithWork.add(workflowId);
  else workflowsWithWork.delete(workflowId);
};

const hasUnsavedWork = () => workflowsWithWork.size > 0;

export { hasUnsavedWork, setUnsavedWork };
