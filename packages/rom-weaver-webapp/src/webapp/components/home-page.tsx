import { HomeLoom } from "./home-loom.tsx";
import { resolveGuidedSampleHref } from "../../public/react/guided-sample-start.ts";

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
const buildFlows = (route: (slug: string) => string): Flow[] => [
  {
    bring: "A ROM and one or more patches, in any order you choose.",
    get: "The patched ROM with checksums checked. Save the chain as a bundle to replay or share it.",
    href: route("apply"),
    primary: true,
    title: "Apply",
  },
  {
    bring: (
      <>
        A patch chain you have set up in Apply, or a <code>rom-weaver-bundle.json</code> someone sent you.
      </>
    ),
    get: "One file that pins patch order, expected checksums, and output names. Open it and the workflow is ready to run.",
    href: `${route("apply")}?guide=bundle`,
    title: "Bundle",
  },
  {
    bring: "An original file and your modified copy.",
    get: "A patch in the format you choose, small enough to share.",
    href: route("create"),
    title: "Create",
  },
  {
    bring: "A ROM you just patched, or one from disk.",
    get: "It running in EmulatorJS in this tab, so you can check the patch before you save it.",
    href: route("test"),
    title: "Test",
  },
];

const HomePage = ({ baseUrl }: HomePageProps): React.ReactElement => {
  const route = (slug: string) => {
    try {
      return new URL(slug, baseUrl).pathname;
    } catch {
      return `/${slug}`;
    }
  };
  const flows = buildFlows(route);

  return (
    <section aria-labelledby="home-title" className="home-page" id="panel-home">
      <div className="home-wrap home-hero">
        <div className="home-hero-head">
          <p className="home-eyebrow">Local-first ROM and disc image toolkit</p>
          <h1 id="home-title">
            Patch, pack, and prove your ROMs. <em>Nothing leaves your machine.</em>
          </h1>
        </div>
        <div className="home-hero-body">
          <p className="home-lede">
            rom-weaver reads every common cartridge and disc container, chains patches in the order you choose, and
            saves the whole recipe as a bundle: patch order, checksums, and output names, so anyone can replay it
            exactly. Use it in the browser or in the terminal.
          </p>
          <div className="home-cta">
            <a className="btn primary lg" href={route("apply")}>
              Open the webapp
              <ArrowIcon />
            </a>
            <a className="btn ghost lg" href="#home-cli">
              Install the CLI
            </a>
          </div>
          <p className="home-try">
            New here? <a href={resolveGuidedSampleHref(baseUrl, "apply")}>Walk through the sample</a>: a tiny homebrew
            NES ROM and two patches, already in order.
          </p>
        </div>
        <div className="home-loom">
          <div className="home-loom-frame">
            <span className="home-loom-tag">apply · 3 patches · in order</span>
            <HomeLoom />
            <div className="home-loom-legend">
              <span className="row">
                <i style={{ background: "var(--warp-b)" }} />
                <span>
                  <span className="k">source </span>Original ROM
                  <span className="sum">
                    {" · "}
                    <code>sha1 ✓</code>
                  </span>
                </span>
              </span>
              <span className="row">
                <i style={{ background: "var(--loom-weft-1)" }} />
                <span>
                  <span className="k">patch 1 </span>translation.bps
                </span>
              </span>
              <span className="row">
                <i style={{ background: "var(--loom-weft-2)" }} />
                <span>
                  <span className="k">patch 2 </span>bugfix.ips
                </span>
              </span>
              <span className="row">
                <i style={{ background: "var(--loom-weft-3)" }} />
                <span>
                  <span className="k">patch 3 </span>undub.xdelta
                </span>
              </span>
            </div>
          </div>
          <p className="home-loom-caption">
            One pass, no unpacking by hand, no intermediate files. Save it as a bundle and the order is kept for the
            next person.
          </p>
        </div>
      </div>

      <div className="home-wrap home-section">
        <div className="home-section-head">
          <p className="home-eyebrow">Pick a workflow</p>
          <h2>Start from the files on your disk.</h2>
          <p>
            Every workflow takes files you already have and gives back one file you can keep, share, or play. A bundle
            is how a workflow itself gets shared.
          </p>
        </div>
        <div className="home-flows">
          {flows.map((flow) => (
            <a className={flow.primary ? "home-flow is-primary" : "home-flow"} href={flow.href} key={flow.title}>
              <h3>
                {flow.title}
                {flow.primary ? <span className="badge">most used</span> : null}
              </h3>
              <dl>
                <dt>Bring</dt>
                <dd>{flow.bring}</dd>
                <dt>Get</dt>
                <dd>{flow.get}</dd>
              </dl>
              <span className="go">
                Open {flow.title}
                <ArrowIcon />
              </span>
            </a>
          ))}
        </div>
      </div>

      <div className="home-wrap home-section" id="home-cli">
        <div className="home-section-head">
          <p className="home-eyebrow">One engine, two frontends</p>
          <h2>The same Rust core, in a tab or in a shell.</h2>
          <p>Pick the one that fits the job. Output bytes are identical either way.</p>
        </div>
        <div className="home-fronts">
          <div className="home-front">
            <h3>Webapp</h3>
            <ul>
              <li>No install, no account. Open a page and drop files in.</li>
              <li>Install it from the browser menu and it keeps working offline.</li>
              <li>Files are read and written on your device. No upload ever happens.</li>
              <li>Open a bundle link and the patch chain is staged for you.</li>
            </ul>
            <div className="home-install">
              <span className="k">Open</span>
              <pre>
                <b>https://</b>rom-weaver.com/apply
              </pre>
            </div>
            <p className="foot">Want your own copy? Host it yourself from static files or a Docker image.</p>
            <div className="home-actions">
              <a className="btn ghost" href={`${route("docs")}/self-hosting`}>
                Self-hosting guide
                <ArrowIcon />
              </a>
            </div>
          </div>
          <div className="home-front">
            <h3>Command line</h3>
            <ul>
              <li>Native builds for Linux, macOS, and Windows.</li>
              <li>Every command can print line-delimited JSON for scripts.</li>
              <li>Batch a whole folder: convert, verify, and patch in one run.</li>
            </ul>
            <div className="home-install">
              <span className="k">Install with one of</span>
              <pre>{`brew install rom-weaver/tap/rom-weaver
npm install --global rom-weaver
cargo install rom-weaver-cli
docker run ghcr.io/rom-weaver/rom-weaver-cli`}</pre>
            </div>
            <p className="foot">Every install method, with checksums and shell completions, is in the install guide.</p>
            <div className="home-actions">
              <a className="btn ghost" href={`${route("docs")}/install`}>
                Full install guide
                <ArrowIcon />
              </a>
              <a className="btn ghost" href={`${route("docs")}/cli-get-started`}>
                CLI walkthrough
              </a>
            </div>
          </div>
        </div>
      </div>

      <div className="home-wrap home-section">
        <div className="home-section-head">
          <p className="home-eyebrow">What it reads and writes</p>
          <h2>Every console generation brought its own format. Bring all of them.</h2>
        </div>
        <div className="home-formats">
          <div className="home-fmt-row">
            <div className="k">
              Containers <small>reads</small>
            </div>
            <div className="home-chips">
              {CONTAINERS_READ.map((name) => (
                <span className="home-chip" key={name}>
                  {name}
                </span>
              ))}
              <span className="more">and nested archives</span>
            </div>
          </div>
          <div className="home-fmt-row">
            <div className="k">
              Containers <small>writes</small>
            </div>
            <div className="home-chips">
              {CONTAINERS_WRITE.map((name) => (
                <span className="home-chip out" key={name}>
                  {name}
                </span>
              ))}
              <span className="more">with codec-aware compression settings</span>
            </div>
          </div>
          <div className="home-fmt-row">
            <div className="k">
              Patches <small>reads and writes</small>
            </div>
            <div className="home-chips">
              {PATCH_FORMATS.map((name) => (
                <span className="home-chip" key={name}>
                  {name}
                </span>
              ))}
              <span className="more">
                <a href={`${route("docs")}/supported-formats`}>full table</a>
              </span>
            </div>
          </div>
          <div className="home-fmt-row">
            <div className="k">Checksums</div>
            <div className="home-chips">
              {CHECKSUMS.map((name) => (
                <span className="home-chip" key={name}>
                  {name}
                </span>
              ))}
              <span className="more">with copier-header detection and repair</span>
            </div>
          </div>
        </div>
      </div>

      <div className="home-wrap home-section">
        <div className="home-section-head">
          <p className="home-eyebrow">Why local-first</p>
          <h2>Your collection is yours. The tool should act like it.</h2>
        </div>
        <div className="home-promises">
          <div className="home-promise">
            <h3>
              <CheckIcon />
              Files stay on the device
            </h3>
            <p>
              The webapp runs the same engine as the CLI, compiled to WebAssembly and running in worker threads. There
              is no server to send anything to.
            </p>
          </div>
          <div className="home-promise">
            <h3>
              <CheckIcon />
              The bundle is the proof
            </h3>
            <p>
              A bundle records the input checksum, every patch in order, and the expected output. Months later you can
              show where a file came from, or hand the bundle to someone and they get the same bytes.
            </p>
          </div>
          <div className="home-promise">
            <h3>
              <CheckIcon />
              Open source, forever
            </h3>
            <p>AGPL-3.0 licensed. Read the code, build it yourself, or host the webapp on your own domain.</p>
          </div>
        </div>
      </div>
    </section>
  );
};

export type { HomePageProps };
export { HomePage };
