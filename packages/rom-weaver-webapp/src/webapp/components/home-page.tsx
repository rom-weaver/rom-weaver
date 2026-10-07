import { useState, useSyncExternalStore } from "react";
import { Check, Copy, Download, Footprints, Server, Stamp, Terminal } from "lucide-react";
import { useClipboardCopy } from "../../public/react/components/ds/use-clipboard-copy.ts";
import { HomeLoom } from "./home-loom.tsx";
import { HomeChain, HomeFaq, HomeFormats, HomeRoutes, HomeTrust } from "./home-sections.tsx";
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

type InstallMethod = {
  command: string;
  id: "brew" | "npm" | "shell" | "windows";
  name: string;
  slug: string;
  /** The segmented-control label; `name` stays the full accessible name. */
  tab: string;
};

const SHELL_INSTALL: InstallMethod = {
  command: "sh -c 'curl -fsSL https://rom-weaver.com/install.sh | sh'",
  id: "shell",
  name: "macOS / Linux",
  slug: "install-script-macos-linux",
  tab: "macOS / Linux",
};
const INSTALL_METHODS: readonly InstallMethod[] = [
  SHELL_INSTALL,
  {
    command: "irm https://raw.githubusercontent.com/rom-weaver/rom-weaver/main/install.ps1 | iex",
    id: "windows",
    name: "Windows (PowerShell)",
    slug: "install-script-windows",
    tab: "Windows",
  },
  {
    command: "brew install rom-weaver/tap/rom-weaver",
    id: "brew",
    name: "Homebrew",
    slug: "homebrew-macos-arm64intel-linux-arm64x86-64",
    tab: "Homebrew",
  },
  { command: "npm install --global rom-weaver", id: "npm", name: "npm", slug: "npm", tab: "npm" },
];

type NavigatorWithPlatformHint = Navigator & { userAgentData?: { platform?: string } };

/**
 * Picks the install tab from the visitor's platform: PowerShell on Windows, the
 * shell script everywhere else. macOS gets the script rather than Homebrew:
 * stock macOS has no `brew`, the page cannot tell whether a visitor installed
 * it, and the script also checks build provenance. Homebrew users pick its tab.
 * The prerendered page has no navigator, so it renders the shell script and the
 * hydrated page switches on Windows.
 */
const detectInstallMethod = (): InstallMethod["id"] => {
  const nav = navigator as NavigatorWithPlatformHint;
  const platform = `${nav.userAgentData?.platform ?? ""} ${nav.userAgent}`;
  if (/Windows/i.test(platform)) return "windows";
  return "shell";
};

const resolveHomeRoute = (baseUrl: string, slug: string): string => {
  try {
    return new URL(slug, baseUrl).pathname;
  } catch {
    return `/${slug}`;
  }
};

type HomeCliProps = {
  route: (slug: string) => string;
};

const HomeCli = ({ route }: HomeCliProps): React.ReactElement => {
  const localizer = useUiLocalizer();
  const detected = useSyncExternalStore(
    () => () => undefined,
    detectInstallMethod,
    (): InstallMethod["id"] => "shell",
  );
  const [picked, setPicked] = useState<InstallMethod["id"] | null>(null);
  const install = INSTALL_METHODS.find((method) => method.id === (picked ?? detected)) ?? SHELL_INSTALL;
  const { copied, copy } = useClipboardCopy(install.command);

  return (
    <section aria-labelledby="home-cli-title" className="home-wrap home-section home-cli" id="home-cli">
      <div className="home-cli-copy">
        <h2 id="home-cli-title">{localizer.message("ui.home.commandLine")}</h2>
        <p className="home-blurb">{localizer.message("ui.home.cliItem3")}</p>
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
      </div>
      <div className="home-install">
        <fieldset className="seg seg-fit home-install-methods">
          <legend className="sr-only">{localizer.message("ui.home.installMethod")}</legend>
          {INSTALL_METHODS.map((method) => (
            <button
              aria-pressed={method.id === install.id}
              className="seg-btn"
              key={method.id}
              onClick={() => setPicked(method.id)}
              type="button"
            >
              {method.tab}
            </button>
          ))}
        </fieldset>
        <div className="home-install-code-wrap">
          <textarea
            aria-label={install.name}
            className="home-install-code"
            key={install.id}
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
        <a className="home-install-doc" href={`${route("docs")}/install#${install.slug}`}>
          {install.name}
        </a>
      </div>
    </section>
  );
};

const HomePage = ({ baseUrl }: HomePageProps): React.ReactElement => {
  const localizer = useUiLocalizer();
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
                <Stamp aria-hidden="true" />
                {localizer.message("ui.home.applyPatchCta")}
              </a>
              <a className="btn ghost lg" href={resolveGuidedSampleHref(baseUrl, "apply")}>
                <Footprints aria-hidden="true" />
                {localizer.message("ui.home.tryLink")}
              </a>
            </div>
            <ul className="home-facts">
              <li>{localizer.message("ui.home.factNoUpload")}</li>
              <li>{localizer.message("ui.home.factOffline")}</li>
              <li>{localizer.message("ui.home.factNoTelemetry")}</li>
            </ul>
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
                <span className="home-loom-flow-copy">
                  <strong className="k">{localizer.message("ui.home.loomSource")}</strong>
                  <code>game.chd</code>
                  <code className="home-loom-flow-result">
                    <strong className="home-loom-flow-action">{localizer.message("ui.home.loomExtract")}</strong>
                    {"game.iso"}
                  </code>
                </span>
              </span>
              <span className="row">
                <i style={{ background: "var(--loom-weft-1)" }} />
                <span className="home-loom-flow-copy">
                  <strong className="k">{localizer.message("ui.home.loomPatch", { n: 1 })}</strong>
                  <code>translation.bps.rar</code>
                  <code className="home-loom-flow-result">
                    <strong className="home-loom-flow-action">{localizer.message("ui.home.loomUnpack")}</strong>
                    {"translation.bps"}
                  </code>
                </span>
              </span>
              <span className="row">
                <i style={{ background: "var(--loom-weft-2)" }} />
                <span className="home-loom-flow-copy">
                  <strong className="k">{localizer.message("ui.home.loomPatch", { n: 2 })}</strong>
                  <code>bugfix.ips.zip</code>
                  <code className="home-loom-flow-result">
                    <strong className="home-loom-flow-action">{localizer.message("ui.home.loomUnpack")}</strong>
                    {"bugfix.ips"}
                  </code>
                </span>
              </span>
              <span className="row">
                <i style={{ background: "var(--loom-weft-3)" }} />
                <span className="home-loom-flow-copy">
                  <strong className="k">{localizer.message("ui.home.loomPatch", { n: 3 })}</strong>
                  <code>undub.xdelta.7z</code>
                  <code className="home-loom-flow-result">
                    <strong className="home-loom-flow-action">{localizer.message("ui.home.loomUnpack")}</strong>
                    {"undub.xdelta"}
                  </code>
                </span>
              </span>
              <span className="row home-loom-disc-flow home-loom-output-flow">
                <i className="home-loom-output-swatch" />
                <span className="home-loom-flow-copy">
                  <strong className="k">{localizer.message("ui.home.loomOutput")}</strong>
                  <code>game.iso</code>
                  <code className="home-loom-flow-result">
                    <strong className="home-loom-flow-action">{localizer.message("ui.home.loomCompress")}</strong>
                    {"patched-game.chd"}
                  </code>
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

      <HomeRoutes featuresHref={`${route("docs")}/features`} route={route} />
      <HomeChain />
      <HomeFormats docsHref={`${route("docs")}/supported-formats`} />
      <HomeTrust selfHostingHref={`${route("docs")}/self-hosting`} />
      <HomeCli route={route} />
      <HomeFaq faqHref={`${route("docs")}/faq`} />
    </section>
  );
};

export type { HomePageProps };
export { HomePage };
