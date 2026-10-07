import type { MessageId } from "../../presentation/localization/catalog.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import {
  ROM_WEAVER_CONTAINER_FORMATS,
  ROM_WEAVER_PATCH_FORMATS,
} from "../../wasm/generated/rom-weaver-format-metadata.ts";

/**
 * The home page below the hero. Each section points somewhere else: the file
 * router to a workflow, the format lists to the reference tables, the FAQ to
 * the docs. Nothing here is interactive beyond links and native disclosure.
 */

/** One extension per format the Apply route accepts, in registry order. */
const PATCH_EXTENSIONS: readonly string[] = ROM_WEAVER_PATCH_FORMATS.flatMap((format) =>
  format.capabilities.apply ? format.extensions.slice(0, 1) : [],
);
/** One extension per container Extract can open, in registry order. */
const CONTAINER_EXTENSIONS: readonly string[] = ROM_WEAVER_CONTAINER_FORMATS.flatMap((format) =>
  format.capabilities.extract ? format.extensions.slice(0, 1) : [],
);
/** Matches the algorithm list in docs/reference/formats.md#checksum-support. */
const CHECKSUM_ALGORITHMS = ["crc32", "md5", "sha1", "sha256", "blake3", "crc32c", "crc16", "adler32"] as const;

type HomeRoute = {
  body: MessageId;
  file: string;
  go: MessageId;
  slug: string;
  /** The legend swatch class, so rows share the loom's dye language. */
  swatch: string;
  title: MessageId;
};

const HOME_ROUTES: readonly HomeRoute[] = [
  {
    body: "ui.home.routePatchBody",
    file: "translation.bps",
    go: "ui.home.goApply",
    slug: "apply-patches",
    swatch: "weft-1",
    title: "ui.home.routePatch",
  },
  {
    body: "ui.home.routeDiscBody",
    file: "game.chd",
    go: "ui.home.goCompress",
    slug: "compress",
    swatch: "source",
    title: "ui.home.routeDisc",
  },
  {
    body: "ui.home.routeUnknownBody",
    file: "mystery.bin",
    go: "ui.home.goIdentify",
    slug: "identify-rom",
    swatch: "muted",
    title: "ui.home.routeUnknown",
  },
  {
    body: "ui.home.routeEditedBody",
    file: "my-hack.sfc",
    go: "ui.home.goCreate",
    slug: "create-patch",
    swatch: "weft-2",
    title: "ui.home.routeEdited",
  },
  {
    body: "ui.home.routeCheatsBody",
    file: "game.gba",
    go: "ui.home.goCheats",
    slug: "apply-patches",
    swatch: "weft-3",
    title: "ui.home.routeCheats",
  },
  {
    body: "ui.home.routeTestBody",
    file: "patched-game.nes",
    go: "ui.home.goTest",
    slug: "test-rom",
    swatch: "verified",
    title: "ui.home.routeTest",
  },
  {
    body: "ui.home.routeChecksumBody",
    file: "dump.sfc",
    go: "ui.home.goChecksum",
    slug: "checksum",
    swatch: "seam",
    title: "ui.home.routeChecksum",
  },
  {
    body: "ui.home.routeBundleBody",
    file: "patch-chain.zip",
    go: "ui.home.goBundle",
    slug: "bundle-patches",
    swatch: "wefts",
    title: "ui.home.routeBundle",
  },
];

type HomeRoutesProps = {
  featuresHref: string;
  route: (slug: string) => string;
};

const HomeRoutes = ({ featuresHref, route }: HomeRoutesProps): React.ReactElement => {
  const localizer = useUiLocalizer();
  return (
    <section aria-labelledby="home-routes-title" className="home-wrap home-section home-routes">
      <h2 id="home-routes-title">{localizer.message("ui.home.routesTitle")}</h2>
      <p className="home-blurb">
        {localizer.message("ui.home.routesDescription")}{" "}
        <a href={featuresHref}>{localizer.message("ui.home.formatsEyebrow")}</a>
      </p>
      <ul className="home-route-list">
        {HOME_ROUTES.map((item) => (
          <li className="home-route" key={item.file}>
            <div className="home-route-copy">
              <p className="home-route-file">
                <i className={`home-swatch home-swatch-${item.swatch}`} />
                <code>{item.file}</code>
              </p>
              <h3>{localizer.message(item.title)}</h3>
              <p>{localizer.message(item.body)}</p>
            </div>
            <a className="btn ghost slim home-route-go" href={route(item.slug)}>
              {localizer.message(item.go)}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
};

const HomeChain = (): React.ReactElement => {
  const localizer = useUiLocalizer();
  const steps: readonly { body: React.ReactNode; swatch: string; title: MessageId }[] = [
    {
      body: localizer.message("ui.home.chainOpenBody", { file: "game.chd" }),
      swatch: "source",
      title: "ui.home.chainOpen",
    },
    { body: localizer.message("ui.home.chainUnpackBody"), swatch: "weft-1", title: "ui.home.chainUnpack" },
    { body: localizer.message("ui.home.chainApplyBody"), swatch: "wefts", title: "ui.home.chainApply" },
    {
      body: localizer.message("ui.home.chainCompressBody", { file: "patched-game.chd" }),
      swatch: "output",
      title: "ui.home.chainCompress",
    },
    { body: localizer.message("ui.home.chainCheckBody"), swatch: "verified", title: "ui.home.chainCheck" },
  ];
  return (
    <section aria-labelledby="home-chain-title" className="home-wrap home-section home-chain">
      <h2 id="home-chain-title">{localizer.message("ui.home.chainTitle")}</h2>
      <p className="home-blurb">{localizer.message("ui.home.chainDescription")}</p>
      <ol className="home-chain-steps">
        {steps.map((step, index) => (
          <li key={step.title}>
            <span className="home-chain-bar">
              {index + 1}
              <i className={`home-swatch home-swatch-${step.swatch}`} />
            </span>
            <h3>{localizer.message(step.title)}</h3>
            <p>{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
};

type HomeFormatsProps = {
  docsHref: string;
};

const HomeFormats = ({ docsHref }: HomeFormatsProps): React.ReactElement => {
  const localizer = useUiLocalizer();
  const groups: readonly { items: readonly string[]; title: MessageId }[] = [
    { items: PATCH_EXTENSIONS, title: "ui.home.patchFormats" },
    { items: CONTAINER_EXTENSIONS, title: "ui.home.containerFormats" },
    { items: CHECKSUM_ALGORITHMS, title: "ui.home.checksumTypes" },
  ];
  return (
    <section aria-labelledby="home-formats-title" className="home-wrap home-section home-formats">
      <h2 id="home-formats-title">{localizer.message("ui.home.formatsHeading")}</h2>
      <p className="home-blurb">
        {localizer.message("ui.home.formatsTitle")} <a href={docsHref}>{localizer.message("ui.home.formatsLink")}</a>
      </p>
      <div className="home-format-groups">
        {groups.map((group) => (
          <div className="home-format-group" key={group.title}>
            <h3>{localizer.message(group.title, { count: group.items.length })}</h3>
            <p>{group.items.join(" ")}</p>
          </div>
        ))}
      </div>
    </section>
  );
};

type HomeTrustProps = {
  selfHostingHref: string;
};

const HomeTrust = ({ selfHostingHref }: HomeTrustProps): React.ReactElement => {
  const localizer = useUiLocalizer();
  return (
    <section aria-labelledby="home-trust-title" className="home-wrap home-section home-trust">
      <h2 id="home-trust-title">{localizer.message("ui.home.trustTitle")}</h2>
      <p className="home-blurb">{localizer.message("ui.home.filesStayDescription")}</p>
      <ul className="home-trust-list">
        <li>
          <h3>{localizer.message("ui.home.filesStay")}</h3>
          <p>{localizer.message("ui.home.webappItem3")}</p>
        </li>
        <li>
          <h3>{localizer.message("ui.home.factOffline")}</h3>
          <p>{localizer.message("ui.home.webappItem2")}</p>
        </li>
        <li>
          <h3>{localizer.message("ui.home.trustOriginals")}</h3>
          <p>{localizer.message("ui.home.trustOriginalsBody")}</p>
        </li>
        <li>
          <h3>{localizer.message("ui.home.openSource")}</h3>
          <p>
            {localizer.message("ui.home.openSourceDescription")}{" "}
            <a href={selfHostingHref}>{localizer.message("ui.home.selfHostingGuide")}</a>
          </p>
        </li>
      </ul>
    </section>
  );
};

const FAQ: readonly { answer: MessageId; question: MessageId }[] = [
  { answer: "ui.home.faqUploadAnswer", question: "ui.home.faqUploadQuestion" },
  { answer: "ui.home.faqGamesAnswer", question: "ui.home.faqGamesQuestion" },
  { answer: "ui.home.faqArchiveAnswer", question: "ui.home.faqArchiveQuestion" },
  { answer: "ui.home.faqOriginalAnswer", question: "ui.home.faqOriginalQuestion" },
];

type HomeFaqProps = {
  faqHref: string;
};

const HomeFaq = ({ faqHref }: HomeFaqProps): React.ReactElement => {
  const localizer = useUiLocalizer();
  return (
    <section aria-labelledby="home-faq-title" className="home-wrap home-section home-faq">
      <h2 id="home-faq-title">{localizer.message("ui.home.faqTitle")}</h2>
      {FAQ.map((item) => (
        <details key={item.question}>
          <summary>{localizer.message(item.question)}</summary>
          <p>{localizer.message(item.answer)}</p>
        </details>
      ))}
      <p className="home-faq-more">
        <a href={faqHref}>{localizer.message("ui.home.faqMore")}</a>
      </p>
    </section>
  );
};

export { HomeChain, HomeFaq, HomeFormats, HomeRoutes, HomeTrust };
