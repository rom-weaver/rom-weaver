import type { MessageId } from "../../presentation/localization/catalog.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import {
  ROM_WEAVER_CHECKSUM_ALGORITHMS,
  ROM_WEAVER_CONTAINER_FORMATS,
  ROM_WEAVER_PATCH_FORMATS,
} from "../../wasm/generated/rom-weaver-format-metadata.ts";

/**
 * The home page below the hero. Each section points somewhere else: the file
 * router to a workflow, the format lists to the reference tables, the FAQ to
 * the docs. Nothing here is interactive beyond links and native disclosure.
 * Sections marked `home-rail` put their heading beside the content on wide
 * screens.
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
const CHECKSUM_ALGORITHMS = ROM_WEAVER_CHECKSUM_ALGORITHMS.map((algorithm) => algorithm.id);

type HomeRoute = {
  body: MessageId;
  secondary?: { go: MessageId; slug: string };
  /** How-to pages linked as plain text links under the body. */
  guides?: readonly { label: MessageId; slug: string }[];
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
    slug: "apply-rom-patches",
    swatch: "weft-1",
    title: "ui.home.routePatch",
  },
  {
    body: "ui.home.routeDiscBody",
    file: "game.chd",
    go: "ui.home.goCompress",
    slug: "compress-files",
    secondary: { go: "ui.home.goExtract", slug: "extract-files" },
    guides: [
      { label: "ui.home.guideChd", slug: "docs/extract-chd" },
      { label: "ui.home.guideRvz", slug: "docs/convert-rvz-to-iso" },
    ],
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
    slug: "create-rom-patch",
    swatch: "weft-2",
    title: "ui.home.routeEdited",
  },
  {
    body: "ui.home.routeCheatsBody",
    file: "game.gba",
    go: "ui.home.goCheats",
    slug: "apply-rom-patches",
    swatch: "weft-3",
    title: "ui.home.routeCheats",
  },
  {
    body: "ui.home.routeTestBody",
    file: "patched-game.nes",
    go: "ui.home.goTest",
    slug: "play-rom",
    swatch: "verified",
    title: "ui.home.routeTest",
  },
  {
    body: "ui.home.routeChecksumBody",
    file: "dump.sfc",
    go: "ui.home.goChecksum",
    slug: "file-checksum",
    swatch: "seam",
    title: "ui.home.routeChecksum",
  },
  {
    body: "ui.home.routeWeaveBody",
    file: "patch-chain.zip",
    go: "ui.home.goWeave",
    slug: "weave-rom-patches",
    swatch: "wefts",
    title: "ui.home.routeWeave",
  },
];

const HomeAbout = (): React.ReactElement => {
  const localizer = useUiLocalizer();
  return (
    <section aria-labelledby="home-about-title" className="home-wrap home-section home-about">
      <div className="home-section-head">
        <h2 id="home-about-title">{localizer.message("ui.home.aboutTitle")}</h2>
        <p className="home-blurb">{localizer.message("ui.home.aboutBody")}</p>
        <p className="home-blurb">{localizer.message("ui.home.aboutAudience")}</p>
      </div>
    </section>
  );
};

type HomeRoutesProps = {
  featuresHref: string;
  route: (slug: string) => string;
};

const HomeRoutes = ({ featuresHref, route }: HomeRoutesProps): React.ReactElement => {
  const localizer = useUiLocalizer();
  return (
    <section aria-labelledby="home-routes-title" className="home-wrap home-section home-routes">
      <div className="home-section-head">
        <h2 id="home-routes-title">{localizer.message("ui.home.routesTitle")}</h2>
        <p className="home-blurb">
          {localizer.message("ui.home.routesDescription")}{" "}
          <a href={featuresHref}>{localizer.message("ui.home.formatsEyebrow")}</a>
        </p>
      </div>
      <ul className="home-route-list">
        {HOME_ROUTES.map((item) => (
          <li className={item.secondary ? "home-route home-route-split" : "home-route"} key={item.file}>
            <p className="home-route-file">
              <i className={`home-swatch home-swatch-${item.swatch}`} />
              <code>
                {item.file.slice(0, item.file.lastIndexOf("."))}
                <wbr />
                {item.file.slice(item.file.lastIndexOf("."))}
              </code>
            </p>
            <h3>{localizer.message(item.title)}</h3>
            <p className="home-route-body">
              {localizer.message(item.body)}
              {/* Inline in the body: the card grid gives each area one element. */}
              {item.guides?.map((guide, index) => (
                <span key={guide.slug}>
                  {index > 0 ? " · " : " "}
                  <a href={route(guide.slug)}>{localizer.message(guide.label)}</a>
                </span>
              ))}
            </p>
            {item.secondary ? (
              <div className="home-route-actions">
                <a className="btn ghost slim home-route-go" href={route(item.slug)}>
                  {localizer.message(item.go)}
                </a>
                <a className="btn ghost slim home-route-go" href={route(item.secondary.slug)}>
                  {localizer.message(item.secondary.go)}
                </a>
              </div>
            ) : (
              <a className="btn ghost slim home-route-go" href={route(item.slug)}>
                {localizer.message(item.go)}
              </a>
            )}
          </li>
        ))}
      </ul>
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
    <section aria-labelledby="home-formats-title" className="home-wrap home-section home-rail home-formats">
      <div className="home-section-head">
        <h2 id="home-formats-title">{localizer.message("ui.home.formatsHeading")}</h2>
        <p className="home-blurb">
          {localizer.message("ui.home.formatsTitle")} <a href={docsHref}>{localizer.message("ui.home.formatsLink")}</a>
        </p>
      </div>
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
  offlineHref: string;
};

const HomeTrust = ({ selfHostingHref, offlineHref }: HomeTrustProps): React.ReactElement => {
  const localizer = useUiLocalizer();
  return (
    <section aria-labelledby="home-trust-title" className="home-wrap home-section home-rail home-trust">
      <div className="home-section-head">
        <h2 id="home-trust-title">{localizer.message("ui.home.trustTitle")}</h2>
        <p className="home-blurb">{localizer.message("ui.home.filesStayDescription")}</p>
      </div>
      <ul className="home-trust-list">
        <li>
          <h3>{localizer.message("ui.home.factOffline")}</h3>
          <p>
            {localizer.message("ui.home.webappItem2")}{" "}
            <a href={offlineHref}>{localizer.message("ui.home.prepareOffline")}</a>
          </p>
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
  { answer: "ui.home.faqFormatsAnswer", question: "ui.home.faqFormatsQuestion" },
  { answer: "ui.home.faqCreateAnswer", question: "ui.home.faqCreateQuestion" },
  { answer: "ui.home.faqDiscAnswer", question: "ui.home.faqDiscQuestion" },
  { answer: "ui.home.faqFreeAnswer", question: "ui.home.faqFreeQuestion" },
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
    <section aria-labelledby="home-faq-title" className="home-wrap home-section home-rail home-faq">
      <div className="home-section-head">
        <h2 id="home-faq-title">{localizer.message("ui.home.faqTitle")}</h2>
        <a className="home-faq-more" href={faqHref}>
          {localizer.message("ui.home.faqMore")}
        </a>
      </div>
      <div>
        {FAQ.map((item) => (
          <details key={item.question}>
            <summary>{localizer.message(item.question)}</summary>
            <p>{localizer.message(item.answer)}</p>
          </details>
        ))}
      </div>
    </section>
  );
};

export { HomeAbout, HomeFaq, HomeFormats, HomeRoutes, HomeTrust };
