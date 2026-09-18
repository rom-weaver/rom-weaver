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
  primary?: boolean;
  title: string;
};

const ArrowIcon = (): React.ReactElement => (
  <svg
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="2"
    viewBox="0 0 16 16"
  >
    <path d="M3 8h10M9 4l4 4-4 4" />
  </svg>
);

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
    primary: true,
    title: localizer.message("ui.home.flowApply"),
  },
  {
    get: localizer.message("ui.home.flowBundleGet"),
    href: route("bundle-patches"),
    title: localizer.message("ui.home.flowBundle"),
  },
  {
    get: localizer.message("ui.home.flowCreateGet"),
    href: route("create-patch"),
    title: localizer.message("ui.home.flowCreate"),
  },
  {
    get: localizer.message("ui.home.flowTestGet"),
    href: route("test-rom"),
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
          <p className="home-try">
            <span className="home-try-context">{localizer.message("ui.home.tryBefore")} </span>
            <a href={resolveGuidedSampleHref(baseUrl, "apply")}>{localizer.message("ui.home.tryLink")}</a>
            <span className="home-try-context">{localizer.message("ui.home.tryAfter")}</span>
          </p>
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

      <div className="home-wrap home-section">
        <div className="home-flows">
          {flows.map((flow) => (
            <a className={flow.primary ? "home-flow is-primary" : "home-flow"} href={flow.href} key={flow.title}>
              <h3>{flow.title}</h3>
              <p>{flow.get}</p>
              <span className="go">
                <ArrowIcon />
              </span>
            </a>
          ))}
        </div>
      </div>

      <div className="home-wrap home-section home-cli" id="home-cli">
        <h2>{localizer.message("ui.home.commandLine")}</h2>
        <div className="home-actions">
          <a className="btn ghost" href={`${route("docs")}/install`}>
            {localizer.message("ui.home.fullInstallGuide")}
            <ArrowIcon />
          </a>
          <a className="btn ghost" href={`${route("docs")}/cli-get-started`}>
            {localizer.message("ui.home.cliWalkthrough")}
          </a>
          <a className="btn ghost" href={`${route("docs")}/self-hosting`}>
            {localizer.message("ui.home.selfHostingGuide")}
          </a>
        </div>
      </div>

      <div className="home-wrap home-section home-details">
        <a href={`${route("docs")}/supported-formats`}>{localizer.message("ui.home.formatsEyebrow")}</a>
        <p>{localizer.message("ui.home.filesStay")}</p>
        <p>{localizer.message("ui.home.openSource")}</p>
      </div>
    </section>
  );
};

export type { HomePageProps };
export { HomePage };
