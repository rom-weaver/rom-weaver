import { useSyncExternalStore } from "react";
import {
  Check,
  Copy,
  Download,
  Footprints,
  Gamepad2,
  GitCompare,
  ListChecks,
  Package,
  Server,
  Terminal,
} from "lucide-react";
import { ApplyBandaidIcon } from "../../public/react/components/apply-bandaid-icon.tsx";
import { useClipboardCopy } from "../../public/react/components/ds/use-clipboard-copy.ts";
import { HomeLoom } from "./home-loom.tsx";
import { resolveGuidedSampleHref } from "../../public/react/guided-sample-start.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";

/**
 * The apex route. Every other route is a workflow the visitor has already
 * chosen; this page exists so they can choose one, so it is prose and links
 * rather than fields. The masthead, footer and phone dock belong to the app
 * shell and are deliberately not repeated here.
 */

type HomePageProps = {
  /** Where the app is served. Route links resolve against it so a sub-path deployment keeps its prefix. */
  baseUrl: string;
};

const SHELL_INSTALL = {
  name: "macOS / Linux",
  slug: "install-script-macos-linux",
  command: "sh -c 'curl -fsSL https://rom-weaver.com/install.sh | sh'",
};
const WINDOWS_INSTALL = {
  name: "Windows (PowerShell)",
  slug: "install-script-windows",
  command: "irm https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/install.ps1 | iex",
};

const resolveHomeRoute = (baseUrl: string, slug: string): string => {
  try {
    return new URL(slug, baseUrl).pathname;
  } catch {
    return `/${slug}`;
  }
};

type HomeCapabilitiesProps = {
  baseUrl: string;
  className: string;
  headingId: string;
};

const HomeCapabilities = ({ baseUrl, className, headingId }: HomeCapabilitiesProps): React.ReactElement => {
  const localizer = useUiLocalizer();
  const route = (slug: string) => resolveHomeRoute(baseUrl, slug);

  return (
    <section aria-labelledby={headingId} className={className}>
      <h2 id={headingId}>{localizer.message("ui.home.workflowsTitle")}</h2>
      <p className="home-blurb">{localizer.message("ui.home.workflowsDescription")}</p>
      <div className="home-actions">
        <a className="btn ghost" href={route("create-patch")}>
          <GitCompare aria-hidden="true" />
          {localizer.message("ui.home.flowCreate")}
        </a>
        <a className="btn ghost" href={route("bundle-patches")}>
          <Package aria-hidden="true" />
          {localizer.message("ui.home.flowBundle")}
        </a>
        <a className="btn ghost" href={route("test-rom")}>
          <Gamepad2 aria-hidden="true" />
          {localizer.message("ui.home.flowTest")}
        </a>
        <a className="btn ghost" href={resolveGuidedSampleHref(baseUrl, "apply")}>
          <Footprints aria-hidden="true" />
          {localizer.message("ui.home.tryLink")}
        </a>
      </div>
    </section>
  );
};

const HomePage = ({ baseUrl }: HomePageProps): React.ReactElement => {
  const localizer = useUiLocalizer();
  const windows = useSyncExternalStore(
    () => () => undefined,
    () => /Windows/i.test(navigator.userAgent),
    () => false,
  );
  const install = windows ? WINDOWS_INSTALL : SHELL_INSTALL;
  const { copied, copy } = useClipboardCopy(install.command);
  const route = (slug: string) => resolveHomeRoute(baseUrl, slug);

  return (
    <section aria-labelledby="home-title" className="home-page" id="panel-home">
      <div className="home-wrap home-hero">
        <div className="home-hero-copy">
          <div className="home-hero-head">
            <p className="home-eyebrow">{localizer.message("ui.home.eyebrow")}</p>
            <h1 id="home-title">
              {localizer.message("ui.home.title")} <em>{localizer.message("ui.home.titleEmphasis")}</em>
            </h1>
          </div>
          <div className="home-hero-body">
            <p className="home-lede">{localizer.message("ui.home.lede")}</p>
            <div className="home-actions home-main-actions">
              <a className="btn primary lg" href={route("apply-patches")}>
                <ApplyBandaidIcon />
                {localizer.message("ui.home.applyPatchCta")}
              </a>
              <a className="btn ghost lg" href={`${route("docs")}/supported-formats`}>
                <ListChecks aria-hidden="true" />
                {localizer.message("ui.home.formatsEyebrow")}
              </a>
            </div>
            <p className="home-try">
              {localizer.message("ui.home.tryBefore")}{" "}
              <a href={resolveGuidedSampleHref(baseUrl, "apply")}>{localizer.message("ui.home.tryLink")}</a>
              {localizer.message("ui.home.tryAfter")}
            </p>
            <HomeCapabilities
              baseUrl={baseUrl}
              className="home-hero-capabilities"
              headingId="home-hero-capabilities-title"
            />
          </div>
        </div>
        <div className="home-loom">
          <div className="home-loom-frame">
            <span className="home-loom-tag">{localizer.message("ui.home.loomTag")}</span>
            <div className="home-loom-result">
              <HomeLoom ariaLabel={localizer.message("ui.home.loomAriaLabel")} />
              <span>{localizer.message("ui.home.loomResult")}</span>
            </div>
            <div className="home-loom-legend">
              <span className="row home-loom-disc-flow">
                <i className="home-loom-source-swatch" />
                <span>
                  <span className="k">{localizer.message("ui.home.loomSource")} </span>
                  <code>game.chd</code> → <code>game.iso</code>
                </span>
              </span>
              <span className="row">
                <i style={{ background: "var(--loom-weft-1)" }} />
                <span>
                  <span className="k">{localizer.message("ui.home.loomPatch", { n: 1 })} </span>
                  <code>translation.bps.rar</code> → <code>translation.bps</code>
                </span>
              </span>
              <span className="row">
                <i style={{ background: "var(--loom-weft-2)" }} />
                <span>
                  <span className="k">{localizer.message("ui.home.loomPatch", { n: 2 })} </span>
                  <code>bugfix.ips.zip</code> → <code>bugfix.ips</code>
                </span>
              </span>
              <span className="row">
                <i style={{ background: "var(--loom-weft-3)" }} />
                <span>
                  <span className="k">{localizer.message("ui.home.loomPatch", { n: 3 })} </span>
                  <code>undub.xdelta.7z</code> → <code>undub.xdelta</code>
                </span>
              </span>
              <span className="row home-loom-disc-flow home-loom-output-flow">
                <i className="home-loom-output-swatch" />
                <span>
                  <span className="k">{localizer.message("ui.home.loomOutput")} </span>
                  <code>game.iso</code> → <code>patched-game.chd</code>
                  <span className="sum">
                    {" · "}
                    <code>sha1 ✓</code>
                  </span>
                </span>
              </span>
            </div>
          </div>
          <p className="home-loom-caption">{localizer.message("ui.home.loomCaption")}</p>
        </div>
      </div>

      <HomeCapabilities
        baseUrl={baseUrl}
        className="home-wrap home-section home-webapp"
        headingId="home-webapp-title"
      />

      <section aria-labelledby="home-cli-title" className="home-wrap home-section home-cli" id="home-cli">
        <h2 id="home-cli-title">{localizer.message("ui.home.commandLine")}</h2>
        <p className="home-blurb">{localizer.message("ui.home.cliItem1")}</p>
        <div className="home-install">
          <a href={`${route("docs")}/install#${install.slug}`}>{install.name}</a>
          <div className="home-install-code-wrap">
            <textarea
              aria-label={install.name}
              className="home-install-code"
              key={install.name}
              defaultValue={install.command}
              readOnly
              rows={1}
            />
            <button
              aria-label={`${localizer.message("ui.common.copy")} ${install.name}`}
              className={`home-install-copy${copied ? " copied" : ""}`}
              onClick={copy}
              title={localizer.message("ui.common.copy")}
              type="button"
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            </button>
          </div>
        </div>
        <div className="home-actions">
          <a className="btn ghost" href={`${route("docs")}/install`}>
            <Download aria-hidden="true" />
            {localizer.message("ui.home.fullInstallGuide")}
          </a>
          <a className="btn ghost" href={`${route("docs")}/cli-get-started`}>
            <Terminal aria-hidden="true" />
            {localizer.message("ui.home.cliWalkthrough")}
          </a>
          <a className="btn ghost" href={`${route("docs")}/self-hosting`}>
            <Server aria-hidden="true" />
            {localizer.message("ui.home.selfHostingGuide")}
          </a>
        </div>
      </section>
    </section>
  );
};

export type { HomePageProps };
export { HomePage };
