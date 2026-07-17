import type { MessageId } from "./localization/catalog.ts";
import { createLocalizer, type Localizer } from "./localization/index.ts";

const getSettingsLabel = (key: string, localizer: Localizer = createLocalizer()): string =>
  localizer.message(`settings.${key}` as MessageId);

// Short, section-aware label used inside the grouped settings panel where the
// section header (e.g. "Codecs"/"RVZ") already supplies the redundant context.
const getUiSettingsLabel = (key: string, localizer: Localizer = createLocalizer()): string =>
  localizer.message(`ui.settings.${key}` as MessageId);

export { getSettingsLabel, getUiSettingsLabel };
