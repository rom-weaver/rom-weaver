import { Download, Footprints, Gamepad2, GitCompare, ListChecks, Package, Server, Terminal } from "lucide-react";
import { ApplyBandaidIcon } from "../../public/react/components/apply-bandaid-icon.tsx";
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

const INSTALL_METHODS = [
  { name: "npm", slug: "npm", command: "npm install --global rom-weaver" },
  {
    name: "Homebrew",
    slug: "homebrew-macos-arm64intel-linux-arm64x86-64",
    command: "brew install rom-weaver/tap/rom-weaver",
  },
  {
    name: "Scoop",
    slug: "scoop-windows",
    command: "scoop bucket add rom-weaver https://github.com/rom-weaver/scoop-bucket\nscoop install rom-weaver",
  },
  {
    name: "install.sh",
    slug: "install-script-macos-linux",
    command:
      "curl --proto '=https' --tlsv1.2 -LsSf https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/install.sh | sh",
  },
  {
    name: "install.ps1",
    slug: "install-script-windows",
    command: "irm https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/install.ps1 | iex",
  },
  {
    name: "cargo-binstall",
    slug: "cargo-binstall",
    command: "cargo binstall rom-weaver-cli\nrom-weaver man --install\nrom-weaver setup",
  },
  {
    name: "mise",
    slug: "mise",
    command:
      "mise use 'github:rom-weaver/rom-weaver[minimum_release_age=0s]'\nrom-weaver man --install\nrom-weaver setup",
  },
  {
    name: "Cargo",
    slug: "source-install",
    command:
      "git clone https://github.com/rom-weaver/rom-weaver.git\ncd rom-weaver\ncargo install --path crates/rom-weaver-cli --locked\nrom-weaver man --install\nrom-weaver setup",
  },
  { name: "Docker", slug: "run-in-docker", command: "docker run --rm ghcr.io/rom-weaver/rom-weaver-cli:latest --help" },
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
          </div>
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
        <h2 id="home-webapp-title">{localizer.message("ui.home.workflowsTitle")}</h2>
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

      <section aria-labelledby="home-cli-title" className="home-wrap home-section home-cli" id="home-cli">
        <h2 id="home-cli-title">{localizer.message("ui.home.commandLine")}</h2>
        <p className="home-blurb">{localizer.message("ui.home.cliItem1")}</p>
        <div className="home-installs">
          {INSTALL_METHODS.map((method) => (
            <div className="home-install" key={method.name}>
              <a href={`${route("docs")}/install#${method.slug}`}>{method.name}</a>
              <textarea
                aria-label={method.name}
                className="home-install-code"
                defaultValue={method.command}
                readOnly
                rows={method.command.split("\n").length}
              />
            </div>
          ))}
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
