import { Fragment } from "react";
import { Check } from "lucide-react";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";

/**
 * The hero illustration: the original ROM is the warp, and each patch is a weft
 * woven across it in order. The labels are the real file names an Apply run
 * reads, so the figure doubles as a worked example of a patch chain.
 *
 * The threads are CSS gradients and the weave is a CSS animation, so the
 * prerendered page draws and animates the loom before any script runs, and the
 * figure costs a handful of nodes rather than one per thread.
 */

const LOOM_PATCHES = [
  { archive: ".rar", name: "translation.bps" },
  { archive: ".zip", name: "bugfix.ips" },
  { archive: ".7z", name: "undub.xdelta" },
] as const;

const HomeLoom = (): React.ReactElement => {
  const localizer = useUiLocalizer();
  return (
    <figure className="home-loom">
      <div className="home-loom-frame">
        <p className="home-loom-key home-loom-top">{localizer.message("ui.home.loomOriginal")}</p>
        <p className="home-loom-beam home-loom-top">
          <code>game.chd</code>
        </p>
        <div aria-hidden="true" className="home-loom-bed" />
        {LOOM_PATCHES.map((patch, index) => (
          <Fragment key={patch.name}>
            <p className={`home-loom-label home-loom-row-${index + 1}`}>
              <b>{index + 1}</b>
              <code>
                {patch.name}
                <span className="home-loom-archive">{patch.archive}</span>
              </code>
            </p>
            <div aria-hidden="true" className={`home-loom-band home-loom-row-${index + 1}`} />
          </Fragment>
        ))}
        <p className="home-loom-key home-loom-bottom">{localizer.message("ui.home.loomPatched")}</p>
        <p className="home-loom-beam home-loom-bottom">
          <code>patched-game.chd</code>
          <span className="home-loom-sum">
            <Check aria-hidden="true" />
            {localizer.message("ui.home.loomChecked")}
          </span>
        </p>
      </div>
      <figcaption className="home-loom-caption">{localizer.message("ui.home.loomCaption")}</figcaption>
    </figure>
  );
};

export { HomeLoom };
