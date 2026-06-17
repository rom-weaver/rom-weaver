import type { LinguiConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";

const config: LinguiConfig = {
  locales: ["en", "es", "de"],
  sourceLocale: "en",
  catalogs: [
    {
      path: "<rootDir>/src/presentation/localization/locales/{locale}",
      include: ["<rootDir>/src"],
    },
  ],
  format: formatter({ lineNumbers: false }),
  compileNamespace: "ts",
};

export default config;
