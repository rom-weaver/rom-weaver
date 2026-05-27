const cx = (...classNames: Array<string | false | null | undefined>) => classNames.filter(Boolean).join(" ");

const buttonClasses = {
  apply:
    "relative !mx-0 inline-flex h-[var(--rom-weaver-control-height)] min-h-[var(--rom-weaver-control-height)] w-full items-center justify-center gap-[7px] overflow-hidden py-0 text-[length:var(--rom-weaver-control-font-size)] leading-[var(--rom-weaver-control-line-height)] disabled:!border-[var(--rom-weaver-color-border-strong)] disabled:!bg-[var(--rom-weaver-color-surface-strong)] disabled:!text-[var(--rom-weaver-color-text-soft)] disabled:!opacity-100 disabled:shadow-[inset_0_1px_0_rgba(255,255,255,.55)]",
  applyProgress:
    "cursor-default opacity-100 disabled:!border-transparent disabled:!bg-[var(--rom-weaver-color-primary)] disabled:!text-white disabled:!opacity-100 disabled:shadow-[0_12px_22px_-15px_var(--rom-weaver-color-primary)]",
  icon: "h-4 w-4 flex-none",
  primary:
    "box-border mx-[5px] my-0 min-w-[120px] rounded-[10px] border border-transparent bg-[var(--rom-weaver-color-primary)] px-5 py-2.5 font-[inherit] text-white shadow-[0_12px_24px_-16px_var(--rom-weaver-color-primary)] outline-none transition-[background-color,transform,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-[.35] not-disabled:cursor-pointer hover:not-disabled:bg-[var(--rom-weaver-color-primary-hover)] hover:not-disabled:shadow-[0_16px_28px_-18px_var(--rom-weaver-color-primary)] active:not-disabled:translate-y-px active:not-disabled:bg-[var(--rom-weaver-color-primary-active)]",
  secondary:
    "mt-2 inline-flex w-full items-center justify-center gap-[7px] rounded-[10px] border border-[var(--rom-weaver-color-border)] !bg-[var(--rom-weaver-color-surface-muted)] !text-[var(--rom-weaver-color-text)] shadow-[0_1px_1px_rgba(0,0,0,.04)] hover:not-disabled:!border-[var(--rom-weaver-color-border-strong)] hover:not-disabled:!bg-[var(--rom-weaver-color-surface)]",
};

const dialogClasses = {
  actions: "mt-4 flex flex-wrap justify-end gap-2",
  backdrop: "fixed inset-0 z-40 bg-[rgba(10,15,20,.62)] backdrop-blur-[3px]",
  body: "mb-4 text-left text-[14px] leading-[1.45] text-[var(--rom-weaver-color-text-soft)]",
  entryButton:
    "block w-full rounded-[8px] border border-transparent bg-transparent px-2 py-1 text-left font-[inherit] text-[var(--rom-weaver-color-text)] [overflow-wrap:anywhere] break-words transition-[background-color,border-color,color] duration-100 hover:border-[var(--rom-weaver-color-border)] hover:bg-[var(--rom-weaver-color-surface-muted)]",
  entryLabel: "block text-[12px] leading-[1.3] [overflow-wrap:anywhere] break-words",
  entryMetadata: "mt-0.5 block text-[10px] font-normal leading-[1.25] opacity-80",
  header:
    "sticky top-0 z-10 -mx-6 -mt-6 mb-5 flex items-center justify-between gap-3 border-b border-[var(--rom-weaver-color-border)] bg-[var(--rom-weaver-color-surface)] p-6 shadow-[0_1px_0_rgba(0,0,0,0.02)]",
  headerActions: "flex flex-wrap items-center justify-end gap-2",
  iconButton:
    "inline-flex h-8 w-8 items-center justify-center rounded-[10px] border border-[var(--rom-weaver-color-border)] bg-[var(--rom-weaver-color-surface)] text-[var(--rom-weaver-color-text)] shadow-[0_2px_6px_rgba(0,0,0,.08)] transition-colors hover:border-[var(--rom-weaver-color-border-strong)] hover:bg-[var(--rom-weaver-color-surface-muted)] focus-visible:shadow-[0_0_0_2px_var(--rom-weaver-color-primary-focus)] max-[641px]:h-9 max-[641px]:w-9",
  iconButtonIcon: "h-4 w-4",
  largePanel:
    "fixed top-1/2 left-1/2 m-0 box-border max-h-[calc(100vh-36px)] w-[min(920px,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-x-hidden overflow-y-auto overscroll-contain rounded-[16px] border border-[var(--rom-weaver-color-border)] bg-[var(--rom-weaver-color-surface)] p-6 align-middle text-[var(--rom-weaver-color-text-soft)] shadow-[0_24px_44px_-22px_rgba(0,0,0,.65)]",
  list: "m-0 max-h-[500px] list-none overflow-y-auto p-0",
  listItem: "p-0",
  message: "text-center",
  panel:
    "fixed top-1/2 left-1/2 m-0 box-border w-[90%] max-w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-[16px] border border-[var(--rom-weaver-color-border)] bg-[var(--rom-weaver-color-surface)] p-6 align-middle text-[var(--rom-weaver-color-text-soft)] shadow-[0_24px_44px_-22px_rgba(0,0,0,.65)] min-[642px]:min-w-[420px]",
  title: "mb-2 text-left text-[18px] font-bold leading-[1.25] text-[var(--rom-weaver-color-text)]",
};

const formClasses = {
  base: "box-border w-full max-w-full rounded-[10px] border border-[var(--rom-weaver-color-border)] bg-[linear-gradient(180deg,oklch(0.972_0.019_304),oklch(0.942_0.022_301))] px-[11px] py-[8px] font-[inherit] text-[var(--rom-weaver-color-text)] shadow-[inset_0_1px_0_oklch(1_0_0_/_0.55)] outline-none transition-[background-color,border-color,box-shadow] duration-150 hover:not-disabled:border-[var(--rom-weaver-color-border-strong)] hover:not-disabled:bg-[linear-gradient(180deg,oklch(0.982_0.024_305),oklch(0.952_0.026_302))] focus:not-disabled:shadow-[0_0_0_2px_var(--rom-weaver-color-primary-focus),inset_0_1px_0_oklch(1_0_0_/_0.64)]",
  checkbox: "styled",
  disabled: "disabled:text-[var(--rom-weaver-color-muted)]",
  file: "empty no-file-selector-button",
  invalid: "aria-[invalid=true]:shadow-[0_0_0_2px_rgba(198,56,77,.32)]",
  nativeFile: "absolute pointer-events-none !h-px !w-px overflow-hidden !p-0 opacity-0",
  select:
    "box-border w-full max-w-full rounded-[10px] border border-[var(--rom-weaver-color-border)] bg-[linear-gradient(180deg,oklch(0.972_0.019_304),oklch(0.942_0.022_301))] px-[11px] py-[8px] pr-[20px] font-[inherit] text-[var(--rom-weaver-color-text)] shadow-[inset_0_1px_0_oklch(1_0_0_/_0.55)] outline-none transition-[background-color,border-color,box-shadow] duration-150 hover:not-disabled:cursor-pointer hover:not-disabled:border-[var(--rom-weaver-color-border-strong)] hover:not-disabled:bg-[linear-gradient(180deg,oklch(0.982_0.024_305),oklch(0.952_0.026_302))] focus:not-disabled:shadow-[0_0_0_2px_var(--rom-weaver-color-primary-focus),inset_0_1px_0_oklch(1_0_0_/_0.64)] disabled:text-[var(--rom-weaver-color-muted)]",
  textarea:
    "box-border w-full max-w-full rounded-[10px] border border-[var(--rom-weaver-color-border)] bg-[linear-gradient(180deg,oklch(0.972_0.019_304),oklch(0.942_0.022_301))] px-[11px] py-[8px] font-[inherit] text-[var(--rom-weaver-color-text)] shadow-[inset_0_1px_0_oklch(1_0_0_/_0.55)] outline-none transition-[background-color,border-color,box-shadow] duration-150 hover:not-disabled:border-[var(--rom-weaver-color-border-strong)] hover:not-disabled:bg-[linear-gradient(180deg,oklch(0.982_0.024_305),oklch(0.952_0.026_302))] focus:not-disabled:shadow-[0_0_0_2px_var(--rom-weaver-color-primary-focus),inset_0_1px_0_oklch(1_0_0_/_0.64)]",
};

const layoutClasses = {
  column: "flex min-h-screen flex-col px-4 pt-4 pb-4 max-[641px]:px-2 max-[641px]:pt-2.5 max-[641px]:pb-3",
  containerInput: "relative min-w-0",
  containerInputFill: "relative min-w-0 w-full",
  footer: "mt-auto px-0 pt-5 pb-1 text-center text-[85%] text-[var(--rom-weaver-color-footer)]",
  footerAction:
    "border-b border-[var(--rom-weaver-color-footer-link-border)] bg-transparent p-0 font-[inherit] text-[var(--rom-weaver-color-footer-link)] no-underline outline-none transition-colors hover:cursor-pointer hover:border-[var(--rom-weaver-color-footer-hover-border)] hover:text-[var(--rom-weaver-color-footer-hover)] focus-visible:border-[var(--rom-weaver-color-footer-hover-border)] focus-visible:text-[var(--rom-weaver-color-footer-hover)]",
  footerAnchor:
    "border-b border-[var(--rom-weaver-color-footer-link-border)] text-[var(--rom-weaver-color-footer-link)] no-underline transition-colors hover:border-[var(--rom-weaver-color-footer-hover-border)] hover:text-[var(--rom-weaver-color-footer-hover)]",
  footerCacheVersion:
    "inline-flex items-center whitespace-nowrap font-['Inter_Tight','Segoe_UI',sans-serif] tabular-nums text-[92%] leading-[1.2] text-[var(--rom-weaver-color-footer-link)]",
  footerIcon: "inline-block h-4 w-4 align-middle",
  footerLinkItem: "inline-flex items-center gap-[3px] whitespace-nowrap",
  footerLinks: "inline-flex flex-wrap items-center justify-center gap-[10px]",
  header: "mb-6 flex items-center justify-center gap-2.5 text-center max-[641px]:mb-3 max-[641px]:gap-1.5",
  messageSelectable: "select-text cursor-text",
  modeTabs:
    "inline-flex flex-none items-center gap-1 rounded-[12px] border border-[rgba(255,255,255,.2)] bg-[rgba(255,255,255,.08)] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,.15)] max-[641px]:w-full max-[641px]:justify-between",
  settingsTrigger:
    "pointer-events-auto relative -top-[10px] translate-x-[9px] inline-flex h-8 w-8 flex-none items-center justify-center rounded-[9px] border border-[var(--rom-weaver-color-border)] bg-[var(--rom-weaver-color-surface-muted)] p-0 text-[var(--rom-weaver-color-text-soft)] shadow-[inset_0_1px_0_rgba(255,255,255,.55)] outline-none transition-[background-color,border-color,color,box-shadow] duration-150 hover:border-[var(--rom-weaver-color-border-strong)] hover:bg-[var(--rom-weaver-color-surface)] hover:text-[var(--rom-weaver-color-text)] focus-visible:shadow-[0_0_0_2px_var(--rom-weaver-color-primary-focus),inset_0_1px_0_rgba(255,255,255,.55)] max-[520px]:-top-[6px] max-[520px]:translate-x-[4px]",
  settingsTriggerIcon: "h-4 w-4",
  spacedStack: "mt-4 text-center",
  switchContainer: "mb-3 flex flex-col items-start justify-start gap-[6px] text-left text-[88%]",
  tab: "tab rounded-[16px] border border-[var(--rom-weaver-color-border)] bg-[var(--rom-weaver-color-surface)] px-4 pt-4 pb-7 shadow-[0_22px_40px_-24px_rgba(0,0,0,.55)] max-[641px]:px-3 max-[641px]:pt-3 max-[641px]:pb-5",
  tabPanelHidden: "hidden",
  tabPanelVisible: "block",
  title:
    "m-0 block text-[28px] font-bold leading-[1.06] tracking-[0.01em] text-[var(--rom-weaver-color-outer-btn)] [text-shadow:0_10px_22px_rgba(7,15,22,.45)] max-[641px]:text-[22px]",
  titleAccent: "text-[var(--rom-weaver-color-primary-hover)] [text-shadow:0_8px_18px_oklch(0.59_0.15_301_/_0.45)]",
  toolHeader: "pointer-events-none relative z-10 h-0 flex justify-end",
  toolPanel: "relative",
  updateBanner:
    "mb-[10px] box-border flex w-full items-center justify-between gap-3 rounded-[12px] border border-[rgba(255,255,255,.18)] bg-[rgba(12,36,40,.62)] px-3 py-2 text-left text-[13px] leading-[1.35] text-[oklch(0.96_0.01_236)] shadow-[0_12px_26px_-20px_rgba(0,0,0,.75)] max-[520px]:flex-col max-[520px]:items-stretch",
  updateBannerAction:
    "inline-flex h-8 flex-none items-center justify-center gap-[7px] rounded-[10px] border border-[rgba(255,255,255,.2)] bg-[var(--rom-weaver-color-primary)] px-3 py-0 font-[inherit] text-[12px] font-bold leading-[1.2] text-white outline-none transition-colors hover:cursor-pointer hover:bg-[var(--rom-weaver-color-primary-hover)] focus-visible:shadow-[0_0_0_2px_var(--rom-weaver-color-primary-focus)] max-[520px]:w-full",
  updateBannerText: "min-w-0 [overflow-wrap:anywhere]",
  wrapper: "box-border mx-auto w-[min(680px,96vw)] flex-none max-[641px]:w-full",
};

const tabClasses = {
  button:
    "m-0 inline-flex items-center justify-center box-border min-w-[96px] rounded-[8px] border border-transparent bg-transparent px-[13px] py-[7px] font-[inherit] text-xs font-semibold leading-[1.2] tracking-[0.01em] text-[oklch(0.93_0.008_236)] outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-[.35] not-disabled:cursor-pointer hover:not-disabled:bg-[rgba(255,255,255,.16)] max-[641px]:h-9 max-[641px]:min-w-0 max-[641px]:flex-1 max-[641px]:px-2 max-[641px]:py-[6px]",
  buttonActive: "active !border-[rgba(255,255,255,.28)] !bg-[rgba(255,255,255,.25)] !text-white",
};

const rowClasses = {
  base: "mb-2 flex flex-wrap items-center justify-between",
  label: "w-[22%] text-right max-[641px]:mb-[3px] max-[641px]:w-full max-[641px]:text-left",
  labelLarge: "w-[70%] text-left max-[641px]:mb-[3px] max-[641px]:w-full",
  message: "mb-2",
  messageHidden: "hidden",
  messageVisible: "block",
  output: "mb-2 flex flex-wrap items-start justify-start",
  outputLabel: "mb-[4px] w-full text-left text-[13px] font-bold leading-[1.3] text-[var(--rom-weaver-color-text-soft)]",
  outputValue: "relative flex w-full min-w-0 items-stretch gap-2",
  source: "flex items-start justify-start",
  sourceLabel: "hidden",
  sourceValue: "w-full min-w-0",
  standaloneValue: "w-[76%] max-[641px]:w-full",
  upload: "mb-2 flex flex-nowrap items-center justify-start gap-2 max-[641px]:flex-wrap max-[641px]:gap-1.5",
  uploadLabel: "hidden",
  uploadValue: "min-w-0 flex-1",
  value: "w-[76%] max-[641px]:w-full",
  valueFill: "w-[76%] min-w-0 max-[641px]:w-full",
  valueLarge: "w-[30%] text-right max-[641px]:w-full max-[641px]:text-left",
  valueTextRight: "text-right max-[641px]:text-left",
};

const textClasses = {
  checksumValue:
    "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-semibold text-[var(--rom-weaver-color-text)]",
  fileInfo:
    "min-w-0 text-[75%] leading-[1.35] [overflow-wrap:anywhere] break-words font-['Inter_Tight','Segoe_UI',sans-serif]",
  metaPanel:
    "mb-2 select-text cursor-text rounded-[10px] border border-[var(--rom-weaver-color-border)] bg-[var(--rom-weaver-color-surface)] px-[10px] py-[8px] font-['Inter_Tight','Segoe_UI',sans-serif] text-[11px] text-[var(--rom-weaver-color-muted)] shadow-[inset_0_1px_0_rgba(255,255,255,.5)]",
  metaRow: "mb-[3px] grid grid-cols-[62px_minmax(0,1fr)] items-baseline gap-x-[8px] last:mb-0",
  metaRowLabel: "w-auto min-w-0 text-left font-semibold tracking-[0.01em] text-[var(--rom-weaver-color-text-soft)]",
  metaRowValue: "min-w-0",
  mono: "font-['Inter_Tight','Segoe_UI',sans-serif] tabular-nums text-xs text-[var(--rom-weaver-color-muted)]",
  muted: "text-[var(--rom-weaver-color-muted)]",
  selectable: "select-text cursor-text",
  truncate: "whitespace-normal overflow-visible text-ellipsis [overflow-wrap:anywhere] break-words",
};

const sectionClasses = {
  header: "mb-1 text-[13px] font-bold leading-[1.3] text-[var(--rom-weaver-color-text-soft)]",
  info: "relative inline-flex items-center",
  infoButton:
    "box-border inline-flex h-[18px] w-[18px] cursor-pointer items-center justify-center rounded-full border border-[var(--rom-weaver-color-border-strong)] bg-[var(--rom-weaver-color-surface)] text-xs font-bold leading-none text-[var(--rom-weaver-color-text-soft)] outline-none transition-colors hover:bg-[var(--rom-weaver-color-surface-muted)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--rom-weaver-color-primary-focus)]",
  infoPanel:
    "absolute left-0 top-[calc(100%+6px)] z-30 box-border rounded-[10px] border border-[var(--rom-weaver-color-border)] bg-[var(--rom-weaver-color-surface)] px-[10px] py-2 text-xs font-normal leading-[1.35] text-[var(--rom-weaver-color-text-soft)] shadow-[0_14px_24px_-16px_rgba(0,0,0,.45)] [overflow-wrap:anywhere]",
  infoPortalPanel: "!fixed z-[70] max-h-[min(320px,calc(100vh-24px))] w-[min(320px,calc(100vw-24px))] overflow-y-auto",
  inputInfoPanel: "w-[min(340px,calc(100vw-48px))]",
  patchInfoPanel: "w-[min(320px,calc(100vw-48px))]",
  timing:
    "inline-flex min-w-0 max-w-full whitespace-normal text-[11px] font-semibold leading-[1.35] text-[var(--rom-weaver-color-muted)] [overflow-wrap:anywhere]",
  timingInline: "flex-[1_1_auto] whitespace-normal [overflow-wrap:anywhere]",
  title: "relative inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-[6px] gap-y-[2px]",
  titleRow: "inline-flex flex-none items-center gap-[6px] whitespace-nowrap",
};

const uploadClasses = {
  button:
    "relative box-border inline-flex h-[var(--rom-weaver-control-height)] min-w-0 flex-[0_0_auto] cursor-pointer items-center justify-center overflow-hidden rounded-[10px] border border-[var(--rom-weaver-color-border)] bg-[var(--rom-weaver-color-surface-muted)] px-[10px] py-0 text-[length:var(--rom-weaver-control-font-size)] leading-[var(--rom-weaver-control-line-height)] text-inherit transition-[background-color,border-color,box-shadow] duration-150 hover:not-disabled:border-[var(--rom-weaver-color-border-strong)] hover:not-disabled:bg-[var(--rom-weaver-color-surface)] disabled:cursor-not-allowed disabled:opacity-[.35]",
  buttonDrag: "shadow-[0_0_0_2px_var(--rom-weaver-color-primary-focus)]",
  buttonIcon: "mr-[6px] h-4 w-4 flex-none",
  buttonIconHidden: "opacity-0",
  buttonInvalid: "!bg-[rgba(220,71,95,.16)] hover:not-disabled:!bg-[rgba(220,71,95,.2)]",
  buttonProgress: "cursor-default text-transparent text-[0px] opacity-100 disabled:opacity-100",
  buttonText: "block min-w-0 [overflow-wrap:anywhere]",
  buttonValid: "!bg-[rgba(63,166,108,.16)] hover:not-disabled:!bg-[rgba(63,166,108,.2)]",
  control: "flex w-full min-w-0 items-center gap-2",
  patchCell:
    "h-[var(--rom-weaver-control-height)] box-border bg-[var(--rom-weaver-color-surface)] py-0 transition-[background-color,box-shadow,border-color] duration-100 group-hover:bg-[var(--rom-weaver-color-surface-muted)] group-hover:shadow-[inset_0_0_0_1px_var(--rom-weaver-color-border)] group-focus-visible:shadow-[inset_0_0_0_2px_var(--rom-weaver-color-primary-focus)] max-[641px]:px-[6px]",
  patchCellDisabled: "opacity-[.6] group-hover:bg-[var(--rom-weaver-color-surface)] group-hover:shadow-none",
  patchCellProgress: "group-hover:bg-[var(--rom-weaver-color-surface)] group-hover:shadow-none",
  patchEmptyCell:
    "relative text-[length:var(--rom-weaver-control-font-size)] leading-[var(--rom-weaver-control-line-height)] text-[var(--rom-weaver-color-muted)] underline underline-offset-2",
  patchLabel: "flex h-full w-full min-w-0 cursor-inherit items-center gap-[6px] [overflow-wrap:anywhere]",
  patchProgressCell: "relative !p-0 text-left no-underline",
  patchRow: "cursor-pointer focus-visible:outline-none",
  patchRowDisabled: "cursor-default",
  patchRowDrag: "[&>td]:shadow-[inset_0_0_0_2px_var(--rom-weaver-color-primary-focus)]",
  romButton:
    "h-[var(--rom-weaver-control-height)] min-h-[var(--rom-weaver-control-height)] w-full whitespace-normal text-center",
  romControl: "flex w-full min-w-0 items-center justify-center gap-2",
};

const progressClasses = {
  applyBar:
    "bg-[linear-gradient(90deg,var(--rom-weaver-color-primary-active)_0%,var(--rom-weaver-color-primary)_56%,var(--rom-weaver-color-primary-hover)_100%)]",
  applyContainer: "items-stretch w-full px-3 py-[5px]",
  applyText: "font-bold tracking-[0.01em]",
  applyTrack: "h-[9px] w-full",
  bar: "relative h-full w-full origin-left overflow-hidden rounded-[999px] bg-[linear-gradient(90deg,var(--rom-weaver-color-primary-active)_0%,var(--rom-weaver-color-primary)_58%,var(--rom-weaver-color-primary-hover)_100%)] shadow-[0_0_0_1px_oklch(1_0_0_/_0.14),0_10px_16px_-12px_var(--rom-weaver-color-primary)] transition-transform duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform before:pointer-events-none before:absolute before:inset-y-0 before:left-[-42%] before:w-[54%] before:content-[''] before:bg-[linear-gradient(90deg,oklch(1_0_0_/_0)_0%,oklch(1_0_0_/_0.52)_52%,oklch(1_0_0_/_0)_100%)] before:mix-blend-screen before:animate-[rom-weaver-progress-thread_1.55s_linear_infinite]",
  barIndeterminate:
    "absolute inset-y-0 left-0 w-[44%] transition-none animate-[rom-weaver-progress-indeterminate_1.2s_cubic-bezier(0.24,1,0.35,1)_infinite]",
  container:
    'pointer-events-auto absolute inset-0 z-[2] m-0 box-border flex h-full min-w-0 cursor-text select-text flex-col justify-center gap-1 overflow-hidden rounded-[10px] border border-[var(--rom-weaver-color-border)] bg-[linear-gradient(180deg,var(--rom-weaver-color-surface-muted),var(--rom-weaver-color-surface))] px-[10px] py-1 font-["Inter_Tight","Segoe_UI",sans-serif] text-[length:var(--rom-weaver-control-font-size)] font-semibold leading-[var(--rom-weaver-control-line-height)] text-[var(--rom-weaver-color-text)] shadow-[inset_0_1px_0_oklch(1_0_0_/_0.5)]',
  text: "flex min-h-[calc(var(--rom-weaver-control-font-size)*var(--rom-weaver-control-line-height))] items-center justify-between gap-2 overflow-hidden whitespace-nowrap text-left font-semibold tracking-[0.01em]",
  track:
    "relative h-[7px] overflow-hidden rounded-[999px] border border-[oklch(0.64_0.058_302_/_0.65)] bg-[linear-gradient(180deg,oklch(0.9_0.045_301),oklch(0.83_0.048_299))] shadow-[inset_0_1px_0_oklch(1_0_0_/_0.46)]",
};

const patchStackClasses = {
  archiveBlock: "block break-words text-[var(--rom-weaver-color-muted)] [overflow-wrap:anywhere] [&_code]:font-inherit",
  button:
    "ml-0 inline-flex h-[24px] w-[24px] min-w-0 items-center justify-center rounded-[8px] border border-transparent bg-transparent p-0 text-[var(--rom-weaver-color-text-soft)] leading-[1.1] transition-[background-color,border-color,color] duration-150 hover:not-disabled:border-[var(--rom-weaver-color-border)] hover:not-disabled:bg-[var(--rom-weaver-color-surface-muted)] hover:not-disabled:text-[var(--rom-weaver-color-text)] disabled:cursor-not-allowed disabled:opacity-[.35] not-disabled:cursor-pointer max-[641px]:h-7 max-[641px]:w-7",
  buttonGap: "ml-0.5",
  buttonIcon: "h-3.5 w-3.5",
  cell: "border border-[var(--rom-weaver-color-border)] bg-[var(--rom-weaver-color-surface)] px-2 py-[7px] align-top shadow-[inset_0_1px_0_oklch(1_0_0_/_0.52)] rounded-[10px] max-[641px]:px-[6px] max-[641px]:py-[6px]",
  controlsCell: "w-20 whitespace-nowrap text-right max-[641px]:w-[74px]",
  controlsCol: "w-20 max-[641px]:w-[74px]",
  details: "mt-0.5 text-[92%] leading-[1.35] text-[var(--rom-weaver-color-muted)]",
  fileBlock: "block [overflow-wrap:anywhere] break-words [&_code]:font-inherit",
  indexCell:
    "w-6 px-1 text-center font-['Inter_Tight','Segoe_UI',sans-serif] tabular-nums text-[75%] leading-[1.35] text-[var(--rom-weaver-color-muted)] align-middle max-[641px]:pr-0",
  indexCol: "w-6",
  nameCell:
    "whitespace-normal text-[75%] leading-[1.35] [overflow-wrap:anywhere] break-words font-['Inter_Tight','Segoe_UI',sans-serif]",
  removeButton:
    "border-[rgba(198,56,77,.35)] bg-[rgba(198,56,77,.1)] text-[var(--rom-weaver-color-danger)] hover:not-disabled:border-[rgba(198,56,77,.55)] hover:not-disabled:bg-[rgba(198,56,77,.2)] hover:not-disabled:text-[var(--rom-weaver-color-danger)]",
  rowValidationInvalid: "[&>td]:border-[rgba(198,56,77,.36)] [&>td]:bg-[rgba(198,56,77,.08)]",
  rowValidationValid: "[&>td]:border-[rgba(63,166,108,.38)] [&>td]:bg-[rgba(63,166,108,.1)]",
  table: "w-full table-fixed bg-transparent [border-collapse:separate] [border-spacing:0_8px]",
  targetChecksum:
    "mt-1 rounded-[8px] border border-[var(--rom-weaver-color-border)] bg-[var(--rom-weaver-color-surface-muted)] px-2 py-1 text-[92%] leading-[1.35] text-[var(--rom-weaver-color-muted)]",
  validation:
    "mt-1 rounded-[8px] border border-[var(--rom-weaver-color-border)] bg-[var(--rom-weaver-color-surface-muted)] px-2 py-1 text-[92%] leading-[1.35] text-[var(--rom-weaver-color-muted)]",
  validationCode: "font-['Inter_Tight','Segoe_UI',sans-serif] tabular-nums text-[95%]",
  validationInvalid: "border-[rgba(198,56,77,.4)] bg-[rgba(198,56,77,.12)] text-[var(--rom-weaver-color-danger)]",
  validationPending: "border-[var(--rom-weaver-color-border)]",
  validationValid: "border-[rgba(63,166,108,.35)] bg-[rgba(63,166,108,.12)] text-[oklch(0.43_0.09_160)]",
};

const noticeClasses = {
  icon: "h-4 w-4 flex-none",
  message:
    "inline-flex select-text items-center gap-[6px] bg-left bg-no-repeat pl-0 text-[var(--rom-weaver-color-danger)] cursor-text",
  startup:
    "items-center justify-center gap-[10px] rounded-[12px] border px-3 py-[10px] text-[13px] font-bold leading-[1.4]",
  startupError: "border-[rgba(198,56,77,.3)] bg-[rgba(198,56,77,.12)] text-[var(--rom-weaver-color-danger)]",
  startupLoading:
    "border-[var(--rom-weaver-color-border)] bg-[var(--rom-weaver-color-surface-muted)] text-[var(--rom-weaver-color-text)]",
  warning: "text-[var(--rom-weaver-color-warning)]",
};

const settingsClasses = {
  actionButton:
    "!m-0 !flex !h-7 !w-7 !min-w-0 items-center justify-center rounded-[9px] !p-0 text-white shadow-none transition-[transform,filter] duration-100 hover:brightness-95 active:translate-y-px active:brightness-90 max-[641px]:!h-8 max-[641px]:!w-8",
  actionDanger: "!bg-[var(--rom-weaver-color-danger)]",
  actionIcon: "h-3 w-3 flex-none",
  actionSuccess: "!bg-[var(--rom-weaver-color-success)]",
  actions: "flex flex-none items-center justify-end gap-1",
  actionWarning: "!bg-[var(--rom-weaver-color-warning)]",
  body: "w-full",
  compressionControl: "compression-control px-[2px] text-left leading-[1.2]",
  compressionRange: "compression-range my-0.5 mb-0 w-full accent-[var(--rom-weaver-color-primary)]",
  compressionScale:
    "compression-scale relative mt-0.5 h-[12px] text-[10px] leading-[1.15] text-[var(--rom-weaver-color-muted)]",
  compressionScaleLabel: "compression-scale-label absolute top-0 block whitespace-nowrap",
  control: "!px-2 !py-1 text-[13px] leading-[1.25]",
  grid: "grid min-w-0 grid-cols-2 gap-x-5 gap-y-0 max-[420px]:gap-x-3 max-[360px]:grid-cols-1",
  header: "mb-2 flex min-w-0 items-start justify-between gap-3",
  infoPanel: "",
  label: "w-[46%] text-left max-[641px]:mb-0.5 max-[641px]:w-full",
  labelLarge: "w-[62%] text-left max-[641px]:mb-0.5 max-[641px]:w-full",
  labelWithInfo: "inline-flex min-w-0 max-w-full flex-wrap items-center gap-1",
  panel: "space-y-2",
  rangeHeader: "mb-0.5 flex items-start justify-between gap-3",
  rangeLabelBlock:
    "min-w-0 px-[2px] text-left text-[13px] font-bold leading-[1.2] text-[var(--rom-weaver-color-text-soft)]",
  rangeRow: "col-span-full mb-1",
  row: "mb-1 flex flex-nowrap items-center gap-1.5 text-[13px] leading-[1.25] max-[641px]:flex-wrap",
  section: "border-t border-[var(--rom-weaver-color-border)] pt-2 first:border-t-0 first:pt-0",
  sectionTitle:
    "m-0 mb-1 text-left text-[11px] font-bold uppercase leading-[1.2] tracking-[0.04em] text-[var(--rom-weaver-color-muted)]",
  title: "m-0 min-w-0 text-left text-[18px] font-bold leading-[1.2] text-[var(--rom-weaver-color-text)]",
  validation: "min-h-4 text-[12px] leading-[1.25] text-[var(--rom-weaver-color-danger)]",
  value: "w-[52%] text-right max-[641px]:w-full max-[641px]:text-left",
  valueLarge: "w-[36%] text-right max-[641px]:w-full max-[641px]:text-left",
};

export {
  buttonClasses,
  cx,
  dialogClasses,
  formClasses,
  layoutClasses,
  noticeClasses,
  patchStackClasses,
  progressClasses,
  rowClasses,
  sectionClasses,
  settingsClasses,
  tabClasses,
  textClasses,
  uploadClasses,
};
