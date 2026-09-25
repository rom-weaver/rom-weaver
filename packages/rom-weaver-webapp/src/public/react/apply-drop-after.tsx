import { Archive, Disc3, ListChecks } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { PendingIdentifyDrawer } from "../../webapp/components/identify-drawer.tsx";
import { Drawer, DrawerReadout } from "./components/ds/drawer.tsx";
import { ExtractName } from "./components/ds/extraction-tree.tsx";
import { FileCard } from "./components/ds/file-card.tsx";
import { SampleTutorialStart } from "./components/ds/sample-tutorial.tsx";
import { resolveGuidedSampleHref } from "./guided-sample-start.ts";
import { StageStatus } from "./components/ds/staging-meta.tsx";
import { useRomWeaverAssetBaseUrl, useRomWeaverSettings, useUiLocalizer } from "./settings-context.tsx";
import type { PendingDrop } from "./use-unified-apply-drop.ts";

// Bare name, resolved against the app's base at fetch time: a root-absolute
// path breaks any deployment that is not served from the domain root.
export const FIRST_WEAVE_ASSET = "first-weave.zip";

export const usePendingCardMorph = (pendingCount: number, _resolvedCount: number) => {
  const knownCards = useRef(new WeakSet<Element>());
  const sourceRects = useRef<DOMRect[]>([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The count controls the intentional DOM animation lifecycle.
  useLayoutEffect(() => {
    const panel = document.getElementById("rom-weaver-container");
    if (!panel) return;
    const cards = Array.from(panel.querySelectorAll<HTMLElement>(".workflow-file-list > .card.file"));
    if (pendingCount > 0) {
      sourceRects.current = Array.from(panel.querySelectorAll<HTMLElement>(".rw-pending"), (row) =>
        row.getBoundingClientRect(),
      );
      return;
    }

    const sources = sourceRects.current;
    if (sources.length && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      cards
        .filter((card) => !knownCards.current.has(card))
        .forEach((card, index) => {
          const source = sources[Math.min(index, sources.length - 1)];
          if (!source) return;
          const target = card.getBoundingClientRect();
          card.animate(
            [
              {
                opacity: 0.35,
                transform: `translate(${source.left - target.left}px, ${source.top - target.top}px) scale(${source.width / target.width}, ${source.height / target.height})`,
                transformOrigin: "top left",
              },
              { offset: 0.78, opacity: 1, transform: "scale(1.012)", transformOrigin: "top left" },
              { opacity: 1, transform: "none", transformOrigin: "top left" },
            ],
            {
              delay: Math.min(index, 3) * 25,
              duration: 280,
              easing: "cubic-bezier(.2,.8,.2,1)",
              fill: "backwards",
            },
          );
        });
    }
    sourceRects.current = [];
    for (const card of cards) knownCards.current.add(card);
  }, [pendingCount]);
};

const PendingDropCard = ({ drop }: { drop: PendingDrop }) => {
  const localizer = useUiLocalizer();
  const { detailedViewEnabled = false } = useRomWeaverSettings();
  return (
    <FileCard
      className="pending-card"
      meta={
        <StageStatus
          id={`rom-weaver-progress-identify-${drop.id}`}
          label={
            drop.bundle
              ? localizer.message("ui.apply.drop.readingBundle")
              : drop.entryCount === undefined
                ? localizer.message("ui.apply.drop.identifying")
                : localizer.message("ui.apply.drop.identified")
          }
          percent={null}
        />
      }
      name={<ExtractName fileName={drop.name} />}
      stageBar="indeterminate"
    >
      {drop.extracting && detailedViewEnabled ? (
        <Drawer
          bodyClassName="taskbody"
          className="extract-d"
          label={localizer.message("ui.apply.files")}
          labelIcon={<Archive aria-hidden="true" />}
          readouts={
            drop.entryCount === undefined ? undefined : (
              <DrawerReadout>{localizer.message("ui.apply.itemCount", { count: drop.entryCount })}</DrawerReadout>
            )
          }
        >
          <span />
        </Drawer>
      ) : null}
      {drop.kind === "rom" && drop.sheet ? (
        <Drawer className="cue rw-cue-section" label={drop.sheet} labelIcon={<Disc3 aria-hidden="true" />}>
          <span />
        </Drawer>
      ) : null}
      {/* Same drawer order the resolved ROM card uses: sheets, Identify, Checks. */}
      {drop.kind === "rom" ? <PendingIdentifyDrawer /> : null}
      {drop.kind === "rom" ? (
        <Drawer
          bodyClassName="ckrows"
          label={localizer.message("ui.apply.tutorial.checks")}
          labelIcon={<ListChecks aria-hidden="true" />}
        >
          <span />
        </Drawer>
      ) : null}
    </FileCard>
  );
};

export const ApplyDropAfter = ({
  bundlePage,
  downloadHref,
  onLoadApplySample,
  onLoadBundleSample,
  pendingDrops,
  sampleError,
  sampleLoading,
  workflowEmpty,
}: {
  bundlePage: boolean;
  onLoadApplySample: () => void;
  onLoadBundleSample: () => void;
  downloadHref: string;
  pendingDrops: PendingDrop[];
  sampleError: string;
  sampleLoading: boolean;
  workflowEmpty: boolean;
}) => {
  const localizer = useUiLocalizer();
  const assetBaseUrl = useRomWeaverAssetBaseUrl();
  if (pendingDrops.length) {
    return (
      <div className="cards workflow-file-list" id="rom-weaver-pending-drops">
        {pendingDrops.map((drop) => (
          <div className="rw-pending" key={drop.id}>
            <PendingDropCard drop={drop} />
          </div>
        ))}
      </div>
    );
  }
  if (!workflowEmpty) return null;
  return (
    <SampleTutorialStart
      downloadHref={downloadHref}
      downloadLabel={localizer.message("ui.apply.tutorial.downloadTestBundle")}
      downloadName={FIRST_WEAVE_ASSET}
      error={sampleError}
      guideHref={resolveGuidedSampleHref(assetBaseUrl, bundlePage ? "bundle" : "apply")}
      label={localizer.message(bundlePage ? "ui.apply.tutorial.createBundle" : "ui.apply.tutorial.startApply")}
      loading={sampleLoading}
      onStart={bundlePage ? onLoadBundleSample : onLoadApplySample}
      startAction={bundlePage ? "package" : "apply"}
    />
  );
};
