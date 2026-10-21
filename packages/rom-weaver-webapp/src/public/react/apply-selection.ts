export const canApplySelection = ({
  patchCount,
  enabledPatchCount,
  cheatsPresent,
  cheatsOn,
}: {
  patchCount: number;
  enabledPatchCount: number;
  cheatsPresent: boolean;
  cheatsOn: boolean;
}): boolean => (patchCount === 0 && !cheatsPresent) || enabledPatchCount > 0 || cheatsOn;
