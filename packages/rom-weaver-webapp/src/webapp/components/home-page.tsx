import { Download, Footprints, Gamepad2, GitCompare, ListChecks, Package, Server, Terminal } from "lucide-react";
import { ApplyBandaidIcon } from "../../public/react/components/apply-bandaid-icon.tsx";
import { HomeLoom } from "./home-loom.tsx";
import { resolveGuidedSampleHref } from "../../public/react/guided-sample-start.ts";
import type { Localizer } from "../../presentation/localization/index.ts";
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

type Flow = {
  get: React.ReactNode;
  href: string;
  icon: React.ReactElement;
  primary?: boolean;
  title: string;
};

/**
 * The four featured workflows. This list MUST NOT depend on
 * settings: the page is prerendered into index.html with defaults, so anything
 * read from storage here renders a different tree on the client and fails
 * hydration. Utility tools are reached from More.
 */
const buildFlows = (route: (slug: string) => string, localizer: Localizer): Flow[] => [
  {
    get: localizer.message("ui.home.flowApplyGet"),
    href: route("apply-patches"),
    icon: <ApplyBandaidIcon />,
    primary: true,
    title: localizer.message("ui.home.flowApply"),
  },
  {
    get: localizer.message("ui.home.flowBundleGet"),
    href: route("bundle-patches"),
    icon: <Package aria-hidden="true" />,
    title: localizer.message("ui.home.flowBundle"),
  },
  {
    get: localizer.message("ui.home.flowCreateGet"),
    href: route("create-patch"),
    icon: <GitCompare aria-hidden="true" />,
    title: localizer.message("ui.home.flowCreate"),
  },
  {
    get: localizer.message("ui.home.flowTestGet"),
    href: route("test-rom"),
    icon: <Gamepad2 aria-hidden="true" />,
    title: localizer.message("ui.home.flowTest"),
  },
];

const HomePage = ({ baseUrl }: HomePageProps): React.ReactElement => {
  const localizer = useUiLocalizer();
  const route = (slug: string) => {
    try {
      return new URL(slug, baseUrl).pathname;
    } catch {
      return `/${slug}`;
    }
  };
  const flows = buildFlows(route, localizer);

  return (
    <section aria-labelledby="home-title" className="home-page" id="panel-home">
      <div className="home-wrap home-hero">
        <div className="home-hero-head">
          <p className="home-eyebrow">{localizer.message("ui.home.eyebrow")}</p>
          <h1 id="home-title">
            {localizer.message("ui.home.title")} <em>{localizer.message("ui.home.titleEmphasis")}</em>
          </h1>
        </div>
        <div className="home-hero-body">
          <p className="home-lede">{localizer.message("ui.home.lede")}</p>
        </div>
        <div className="home-loom">
          <div className="home-loom-frame">
            <span className="home-loom-tag">{localizer.message("ui.home.loomTag")}</span>
            <HomeLoom ariaLabel={localizer.message("ui.home.loomAriaLabel")} />
            <div className="home-loom-legend">
              <span className="row">
                <i style={{ background: "var(--warp-b)" }} />
                <span>
                  <span className="k">{localizer.message("ui.home.loomSource")} </span>
                  {localizer.message("ui.home.loomOriginalRom")}
                  <span className="sum">
                    {" · "}
                    <code>sha1 ✓</code>
                  </span>
                </span>
              </span>
              <span className="row">
                <i style={{ background: "var(--loom-weft-1)" }} />
                <span>
                  <span className="k">{localizer.message("ui.home.loomPatch", { n: 1 })} </span>translation.bps
                </span>
              </span>
              <span className="row">
                <i style={{ background: "var(--loom-weft-2)" }} />
                <span>
                  <span className="k">{localizer.message("ui.home.loomPatch", { n: 2 })} </span>bugfix.ips
                </span>
              </span>
              <span className="row">
                <i style={{ background: "var(--loom-weft-3)" }} />
                <span>
                  <span className="k">{localizer.message("ui.home.loomPatch", { n: 3 })} </span>undub.xdelta
                </span>
              </span>
            </div>
          </div>
        </div>
      </div>

      <section aria-labelledby="home-webapp-title" className="home-wrap home-section home-webapp">
        <h2 id="home-webapp-title">{localizer.message("ui.home.webapp")}</h2>
        <div className="home-flows">
          {flows.map((flow) => (
            <a className={flow.primary ? "home-flow is-primary" : "home-flow"} href={flow.href} key={flow.title}>
              <h3>{flow.title}</h3>
              <p>{flow.get}</p>
              <span className="go">{flow.icon}</span>
            </a>
          ))}
        </div>
        <div className="home-links">
          <a className="home-link" href={`${route("docs")}/supported-formats`}>
            <span>{localizer.message("ui.home.formatsEyebrow")}</span>
            <ListChecks aria-hidden="true" />
          </a>
          <a className="home-link" href={resolveGuidedSampleHref(baseUrl, "apply")}>
            <span>{localizer.message("ui.home.tryLink")}</span>
            <Footprints aria-hidden="true" />
          </a>
        </div>
      </section>

      <section aria-labelledby="home-cli-title" className="home-wrap home-section home-cli" id="home-cli">
        <h2 id="home-cli-title">{localizer.message("ui.home.commandLine")}</h2>
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
