import { useState } from "react";
import { createLogger } from "../../lib/logging.ts";
import type { MessageId } from "../../presentation/localization/catalog.ts";
import { Modal } from "../../public/react/components/ds/modal.tsx";
import { SelectionCheckList, SelectionTree } from "../../public/react/components/ds/selection.tsx";
import {
  countDropEntries,
  isUsableDropFile,
  planDropDestinations,
  planDropRedirect,
} from "../../public/react/drop-destination.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import type { WebappView } from "../webapp-state-types.ts";

/**
 * Asks where a drop goes and, when that page cannot use every file, which files
 * to bring, in one dialog built from the candidate picker's own pieces: a
 * SelectionTree when only the page is in question, otherwise the page as a
 * segmented choice above a SelectionCheckList that pre-checks what it uses.
 */

const logger = createLogger("drop-route-dialog");

type DropRouteRequest = {
  files: File[];
  /** The view the files were dropped on; `home` plans a destination, a workflow plans a redirect. */
  from: WebappView;
  /** Distinguishes requests so each one opens on its first step. */
  id: number;
};

/** `label` names the row; `page` names the destination on the file step that may follow. */
type RouteOption = { label: string; note: string; page: string; view: WebappView };
type RouteQuestion = { options: RouteOption[]; subtitle: string; title: string };

type DropRouteDialogProps = {
  /** The nav label of a workflow that has no route-specific name here. */
  labelFor: (view: WebappView) => string;
  onCancel: () => void;
  onDeliver: (view: WebappView, files: File[]) => void;
  request: DropRouteRequest;
};

const PAGE_NAMES: Partial<Record<WebappView, MessageId>> = {
  creator: "ui.drop.routeCreate",
  patcher: "ui.home.applyPatchCta",
  test: "ui.drop.routeTest",
};

const DropRouteDialog = ({ labelFor, onCancel, onDeliver, request }: DropRouteDialogProps) => {
  const localizer = useUiLocalizer();
  const page = (view: WebappView) => {
    const id = PAGE_NAMES[view];
    return id ? localizer.message(id) : labelFor(view);
  };
  const option = (view: WebappView, note: MessageId, label = page(view)): RouteOption => ({
    label,
    note: localizer.message(note),
    page: page(view),
    view,
  });
  const stay = (note: MessageId) =>
    option(request.from, note, localizer.message("ui.drop.stayOn", { page: page(request.from) }));

  const question = ((): RouteQuestion => {
    const counts = countDropEntries(request.files.map((file) => ({ name: file.name })));
    const ask = (title: MessageId, subtitle: string, options: RouteOption[]) => ({
      options,
      subtitle,
      title: localizer.message(title),
    });
    if (request.from === "home") {
      const plan = planDropDestinations(counts);
      if (plan.mixed) {
        return ask("ui.drop.routeMixedTitle", localizer.message("ui.drop.routeMixedBody"), [
          option("creator", "ui.drop.noteCreateMixed"),
          option("patcher", "ui.drop.noteApplyMixed"),
        ]);
      }
      if (plan.destinations.length > 1) {
        return ask("ui.drop.routeRomTitle", localizer.message("ui.drop.routeRomBody"), [
          option("patcher", "ui.drop.noteApplyRom"),
          option("test", "ui.drop.noteTestRom"),
        ]);
      }
      const [only = "patcher"] = plan.destinations;
      return {
        options: [{ label: page(only), note: "", page: page(only), view: only }],
        subtitle: localizer.message("ui.drop.chooseFilesHint", { page: page(only) }),
        title: page(only),
      };
    }
    const redirect = planDropRedirect(request.from, counts);
    const keepsRoms = counts.roms + counts.unknown > 0;
    if (redirect?.reason === "applyBeforeTest") {
      return ask("ui.drop.applyBeforeTestTitle", localizer.message("ui.drop.applyBeforeTestBody"), [
        option("patcher", "ui.drop.noteApplyFirst"),
        ...(keepsRoms ? [stay("ui.drop.noteTestUnpatched")] : []),
      ]);
    }
    if (redirect?.reason === "romsMakePatch") {
      return ask("ui.drop.romsMakePatchTitle", localizer.message("ui.drop.romsMakePatchBody"), [
        option("creator", "ui.drop.noteCreateRoms"),
        stay("ui.drop.noteStayApply"),
      ]);
    }
    return ask(
      "ui.drop.patchesNeedApplyTitle",
      localizer.message("ui.drop.patchesNeedApplyBody", { page: page(request.from) }),
      [option("patcher", "ui.drop.noteApplyFiles"), ...(keepsRoms ? [stay("ui.drop.noteStayRomOnly")] : [])],
    );
  })();

  const [picked, setPicked] = useState<RouteOption | undefined>(question.options[0]);
  const fitsEvery = (choice: RouteOption) => request.files.every((file) => isUsableDropFile(choice.view, file.name));

  // When every page can use every file, the only question is where to go.
  if (question.options.every(fitsEvery)) {
    return (
      <Modal onClose={onCancel} open subtitle={question.subtitle} title={question.title} variant="select-modal">
        <SelectionTree
          items={question.options.map((choice) => ({
            id: choice.view,
            name: choice.label,
            note: choice.note,
            selectable: true,
          }))}
          onSelect={(id) => {
            logger.debug("drop routed with every file", { count: request.files.length, view: id });
            onDeliver(id as WebappView, request.files);
          }}
        />
      </Modal>
    );
  }
  if (!picked) return null;
  // Otherwise the page and its files are one choice: switching page re-checks the files it uses
  // (the checklist re-seeds when its defaults change), and any file can still be brought along.
  return (
    <Modal onClose={onCancel} open subtitle={question.subtitle} title={question.title} variant="select-modal">
      {question.options.length > 1 ? (
        <fieldset className="seg seg-fit">
          <legend className="sr-only">{question.title}</legend>
          {question.options.map((choice) => (
            <button
              aria-pressed={choice.view === picked.view}
              className="seg-btn"
              key={choice.view}
              onClick={() => setPicked(choice)}
              type="button"
            >
              {choice.label}
            </button>
          ))}
        </fieldset>
      ) : null}
      {picked.note ? <p className="pdesc">{picked.note}</p> : null}
      <SelectionCheckList
        items={request.files.map((file, index) => {
          const usable = isUsableDropFile(picked.view, file.name);
          return {
            defaultSelected: usable || undefined,
            id: String(index),
            name: file.name,
            note: usable ? undefined : localizer.message("ui.drop.notUsedHere", { page: picked.page }),
            selectable: true,
          };
        })}
        onCancel={onCancel}
        onSubmit={(ids) => {
          const files = ids.map((id) => request.files[Number(id)]).filter((file): file is File => !!file);
          logger.debug("drop routed with chosen files", {
            chosen: files.length,
            dropped: request.files.length,
            view: picked.view,
          });
          onDeliver(picked.view, files);
        }}
        submitLabel={(count) => localizer.messageCount("ui.drop.openFiles", count, { page: picked.page })}
      />
    </Modal>
  );
};

export { DropRouteDialog, type DropRouteRequest };
