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
  bring: React.ReactNode;
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

const CheckIcon = (): React.ReactElement => (
  <svg
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="1.8"
    viewBox="0 0 20 20"
  >
    <path d="M4 10.5l4 4 8-9" />
  </svg>
);

const CONTAINERS_READ = ["ZIP", "7z", "RAR", "tar", "CHD", "RVZ", "Z3DS", "CSO", "PBP", "GCZ", "WIA", "WBFS"];
const CONTAINERS_WRITE = ["ZIP", "7z", "CHD", "RVZ", "Z3DS"];
const PATCH_FORMATS = ["IPS", "BPS", "UPS", "xdelta", "PPF", "RUP", "BDF", "APS", "DPS", "BSP", "HDiffPatch"];
const CHECKSUMS = ["CRC32", "MD5", "SHA-1", "SHA-256", "BLAKE3"];

/**
 * The four stable workflows, and only those. This list MUST NOT depend on
 * settings: the page is prerendered into index.html with defaults, so anything
 * read from storage here renders a different tree on the client and fails
 * hydration. Identify, Trim and Undo PPF are beta and reached from More.
 */
const buildFlows = (route: (slug: string) => string, localizer: Localizer): Flow[] => [
  {
    bring: localizer.message("ui.home.flowApplyBring"),
    get: localizer.message("ui.home.flowApplyGet"),
    href: route("apply-patch"),
    primary: true,
    title: localizer.message("ui.home.flowApply"),
  },
  {
    bring: (
      <>
        {localizer.message("ui.home.flowBundleBringBefore")} <code>rom-weaver-bundle.json</code>{" "}
        {localizer.message("ui.home.flowBundleBringAfter")}
      </>
    ),
    get: localizer.message("ui.home.flowBundleGet"),
    href: `${route("apply-patch")}?guide=bundle`,
    title: localizer.message("ui.home.flowBundle"),
  },
  {
    bring: localizer.message("ui.home.flowCreateBring"),
    get: localizer.message("ui.home.flowCreateGet"),
    href: route("create-patch"),
    title: localizer.message("ui.home.flowCreate"),
  },
  {
    bring: localizer.message("ui.home.flowTestBring"),
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
          <div className="home-cta">
            <a className="btn primary lg" href={route("apply-patch")}>
              {localizer.message("ui.home.applyPatchCta")}
              <ArrowIcon />
            </a>
            <a className="btn ghost lg" href="#home-cli">
              {localizer.message("ui.home.installCli")}
            </a>
          </div>
          <p className="home-try">
            {localizer.message("ui.home.tryBefore")}{" "}
            <a href={resolveGuidedSampleHref(baseUrl, "apply")}>{localizer.message("ui.home.tryLink")}</a>
            {localizer.message("ui.home.tryAfter")}
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
          <p className="home-loom-caption">{localizer.message("ui.home.loomCaption")}</p>
        </div>
      </div>

      <div className="home-wrap home-section">
        <div className="home-section-head">
          <p className="home-eyebrow">{localizer.message("ui.home.workflowsEyebrow")}</p>
          <h2>{localizer.message("ui.home.workflowsTitle")}</h2>
          <p>{localizer.message("ui.home.workflowsDescription")}</p>
        </div>
        <div className="home-flows">
          {flows.map((flow) => (
            <a className={flow.primary ? "home-flow is-primary" : "home-flow"} href={flow.href} key={flow.title}>
              <h3>
                {flow.title}
                {flow.primary ? <span className="badge">{localizer.message("ui.home.mostUsed")}</span> : null}
              </h3>
              <dl>
                <dt>{localizer.message("ui.home.bring")}</dt>
                <dd>{flow.bring}</dd>
                <dt>{localizer.message("ui.home.get")}</dt>
                <dd>{flow.get}</dd>
              </dl>
              <span className="go">
                {localizer.message("ui.home.openFlow", { flow: flow.title })}
                <ArrowIcon />
              </span>
            </a>
          ))}
        </div>
      </div>

      <div className="home-wrap home-section" id="home-cli">
        <div className="home-section-head">
          <p className="home-eyebrow">{localizer.message("ui.home.frontendsEyebrow")}</p>
          <h2>{localizer.message("ui.home.frontendsTitle")}</h2>
          <p>{localizer.message("ui.home.frontendsDescription")}</p>
        </div>
        <div className="home-fronts">
          <div className="home-front">
            <h3>{localizer.message("ui.home.webapp")}</h3>
            <ul>
              <li>{localizer.message("ui.home.webappItem1")}</li>
              <li>{localizer.message("ui.home.webappItem2")}</li>
              <li>{localizer.message("ui.home.webappItem3")}</li>
              <li>{localizer.message("ui.home.webappItem4")}</li>
            </ul>
            <div className="home-install">
              <span className="k">{localizer.message("ui.home.open")}</span>
              <pre>
                <b>https://</b>rom-weaver.com/apply
              </pre>
            </div>
            <p className="foot">{localizer.message("ui.home.webappFoot")}</p>
            <div className="home-actions">
              <a className="btn ghost" href={`${route("docs")}/self-hosting`}>
                {localizer.message("ui.home.selfHostingGuide")}
                <ArrowIcon />
              </a>
            </div>
          </div>
          <div className="home-front">
            <h3>{localizer.message("ui.home.commandLine")}</h3>
            <ul>
              <li>{localizer.message("ui.home.cliItem1")}</li>
              <li>{localizer.message("ui.home.cliItem2")}</li>
              <li>{localizer.message("ui.home.cliItem3")}</li>
            </ul>
            <div className="home-install">
              <span className="k">{localizer.message("ui.home.installWith")}</span>
              <pre>{`brew install rom-weaver/tap/rom-weaver
npm install --global rom-weaver
cargo install rom-weaver-cli
docker run ghcr.io/rom-weaver/rom-weaver-cli`}</pre>
            </div>
            <p className="foot">{localizer.message("ui.home.cliFoot")}</p>
            <div className="home-actions">
              <a className="btn ghost" href={`${route("docs")}/install`}>
                {localizer.message("ui.home.fullInstallGuide")}
                <ArrowIcon />
              </a>
              <a className="btn ghost" href={`${route("docs")}/cli-get-started`}>
                {localizer.message("ui.home.cliWalkthrough")}
              </a>
            </div>
          </div>
        </div>
      </div>

      <div className="home-wrap home-section">
        <div className="home-section-head">
          <p className="home-eyebrow">{localizer.message("ui.home.formatsEyebrow")}</p>
          <h2>{localizer.message("ui.home.formatsTitle")}</h2>
        </div>
        <div className="home-formats">
          <div className="home-fmt-row">
            <div className="k">
              {localizer.message("ui.home.containers")} <small>{localizer.message("ui.home.reads")}</small>
            </div>
            <div className="home-chips">
              {CONTAINERS_READ.map((name) => (
                <span className="home-chip" key={name}>
                  {name}
                </span>
              ))}
              <span className="more">{localizer.message("ui.home.nestedArchives")}</span>
            </div>
          </div>
          <div className="home-fmt-row">
            <div className="k">
              {localizer.message("ui.home.containers")} <small>{localizer.message("ui.home.writes")}</small>
            </div>
            <div className="home-chips">
              {CONTAINERS_WRITE.map((name) => (
                <span className="home-chip out" key={name}>
                  {name}
                </span>
              ))}
              <span className="more">{localizer.message("ui.home.codecCompressionSettings")}</span>
            </div>
          </div>
          <div className="home-fmt-row">
            <div className="k">
              {localizer.message("ui.home.patches")} <small>{localizer.message("ui.home.readsAndWrites")}</small>
            </div>
            <div className="home-chips">
              {PATCH_FORMATS.map((name) => (
                <span className="home-chip" key={name}>
                  {name}
                </span>
              ))}
              <span className="more">
                <a href={`${route("docs")}/supported-formats`}>{localizer.message("ui.home.fullTable")}</a>
              </span>
            </div>
          </div>
          <div className="home-fmt-row">
            <div className="k">{localizer.message("ui.home.checksums")}</div>
            <div className="home-chips">
              {CHECKSUMS.map((name) => (
                <span className="home-chip" key={name}>
                  {name}
                </span>
              ))}
              <span className="more">{localizer.message("ui.home.copierHeader")}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="home-wrap home-section">
        <div className="home-section-head">
          <p className="home-eyebrow">{localizer.message("ui.home.localFirstEyebrow")}</p>
          <h2>{localizer.message("ui.home.localFirstTitle")}</h2>
        </div>
        <div className="home-promises">
          <div className="home-promise">
            <h3>
              <CheckIcon />
              {localizer.message("ui.home.filesStay")}
            </h3>
            <p>{localizer.message("ui.home.filesStayDescription")}</p>
          </div>
          <div className="home-promise">
            <h3>
              <CheckIcon />
              {localizer.message("ui.home.bundleProof")}
            </h3>
            <p>{localizer.message("ui.home.bundleProofDescription")}</p>
          </div>
          <div className="home-promise">
            <h3>
              <CheckIcon />
              {localizer.message("ui.home.openSource")}
            </h3>
            <p>{localizer.message("ui.home.openSourceDescription")}</p>
          </div>
        </div>
      </div>
    </section>
  );
};

export type { HomePageProps };
export { HomePage };
