import { trackSelectionDelivery } from "../../lib/input/selection-delivery.ts";
import { useState, useSyncExternalStore } from "react";
import { Check, Copy, Download, Server, Terminal } from "lucide-react";
import { useClipboardCopy } from "../../public/react/components/ds/use-clipboard-copy.ts";
import { HomeLoom } from "./home-loom.tsx";
import { HomeFaq, HomeFormats, HomeRoutes, HomeTrust } from "./home-sections.tsx";
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
  /** Files chosen in the hero picker; the shell routes them to the workflow that fits. */
  onFiles?: (files: File[]) => void | Promise<void>;
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
    <section aria-labelledby="home-cli-title" className="home-wrap home-section home-rail home-cli" id="home-cli">
      <div className="home-section-head">
        <h2 id="home-cli-title">{localizer.message("ui.home.commandLine")}</h2>
        <p className="home-blurb">{localizer.message("ui.home.cliItem3")}</p>
        <ul className="home-cli-links">
          <li>
            <a href={`${route("docs")}/install`}>
              <Download aria-hidden="true" />
              <span>{localizer.message("ui.home.fullInstallGuide")}</span>
            </a>
          </li>
          <li>
            <a href={`${route("docs")}/cli-get-started`}>
              <Terminal aria-hidden="true" />
              <span>{localizer.message("ui.home.cliWalkthrough")}</span>
            </a>
          </li>
          <li>
            <a href={`${route("docs")}/self-hosting`}>
              <Server aria-hidden="true" />
              <span>{localizer.message("ui.home.selfHostingGuide")}</span>
            </a>
          </li>
        </ul>
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
          <pre className="home-install-code">
            <code>{install.command}</code>
          </pre>
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

const HomePage = ({ baseUrl, onFiles }: HomePageProps): React.ReactElement => {
  const localizer = useUiLocalizer();
  const route = (slug: string) => resolveHomeRoute(baseUrl, slug);

  return (
    <section aria-labelledby="home-title" className="home-page" id="panel-home">
      <div className="home-wrap home-hero">
        <div className="home-hero-copy">
          <h1 id="home-title">
            {localizer.message("ui.home.title")} {localizer.message("ui.home.titleEmphasis")}
          </h1>
          <p className="home-lede">{localizer.message("ui.home.lede")}</p>
          {/* Drops anywhere on the page reach the shell's page-level handler, so this area only
              needs the picker; it is not a `.drop`, which the shell leaves to the zone. */}
          <div className="home-main-actions">
            <label className="btn primary lg home-pick">
              {localizer.message("ui.drop.homeChoose")}
              <input
                className="sr-only"
                id="home-file-input"
                multiple
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = "";
                  if (files.length) trackSelectionDelivery(event.nativeEvent, onFiles?.(files));
                }}
                type="file"
              />
            </label>
            <span className="home-drop-hint">{localizer.message("ui.drop.homeDrop")}</span>
            <p className="home-practice">
              {localizer.message("ui.home.practicePrompt")}{" "}
              <a href={resolveGuidedSampleHref(baseUrl, "apply")}>{localizer.message("ui.home.tryLink")}</a>
            </p>
          </div>
          <ul className="home-facts">
            <li>{localizer.message("ui.home.factNoUpload")}</li>
            <li>{localizer.message("ui.home.factOffline")}</li>
            <li>{localizer.message("ui.home.factNoTelemetry")}</li>
          </ul>
        </div>
        <HomeLoom />
      </div>

      <HomeRoutes featuresHref={`${route("docs")}/features`} route={route} />
      <HomeFormats docsHref={`${route("docs")}/supported-formats`} />
      <HomeTrust
        offlineHref={`${route("docs")}/browser-settings#prepare-for-offline-use`}
        selfHostingHref={`${route("docs")}/self-hosting`}
      />
      <HomeCli route={route} />
      <HomeFaq faqHref={`${route("docs")}/faq`} />
    </section>
  );
};

export type { HomePageProps };
export { HomePage };
