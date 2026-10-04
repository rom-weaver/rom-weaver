import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const replaceOnce = (source, marker, replacement, description) => {
  assert.equal(source.split(marker).length, 2, `RetroArch ${description} changed`);
  return source.replace(marker, replacement);
};

const patchDarwinFrontend = (source) => {
  const open = `static bool frontend_darwin_accessibility_speak(int speed,\n      const char* speak_text, int priority)\n{\n`;
  const close = `#if defined(OSX)\n   return accessibility_speak_macos(speed, speak_text, priority);\n#else\n   return false;\n#endif\n}`;
  const guarded = replaceOnce(
    source,
    open,
    `${open}#if defined(HAVE_ACCESSIBILITY)\n`,
    "Darwin accessibility entrypoint",
  );
  return replaceOnce(
    guarded,
    close,
    `${close.slice(0, -1)}#else\n   (void)speed;\n   (void)speak_text;\n   (void)priority;\n   return false;\n#endif\n}`,
    "Darwin accessibility entrypoint end",
  );
};

const patchConfiguration = (source) => {
  const marker = `#if __APPLE__\n   configuration_set_bool(settings,\n         settings->bools.accessibility_enable, RAIsVoiceOverRunning());\n#endif`;
  const replacement = `#if __APPLE__ && defined(HAVE_ACCESSIBILITY) && (defined(HAVE_COCOA) || defined(HAVE_COCOA_METAL) || defined(HAVE_COCOATOUCH))\n   configuration_set_bool(settings,\n         settings->bools.accessibility_enable, RAIsVoiceOverRunning());\n#endif`;
  return replaceOnce(source, marker, replacement, "VoiceOver default guard");
};

const patchVideoDriver = (source) => {
  const marker = `#elif defined(__APPLE__)\n         current_display_server = &dispserv_apple;\n#else\n         current_display_server = &dispserv_null;`;
  const replacement = `#elif defined(__APPLE__) && (defined(HAVE_COCOA) || defined(HAVE_COCOA_METAL) || defined(HAVE_COCOATOUCH))\n         current_display_server = &dispserv_apple;\n#elif defined(__APPLE__)\n         current_display_server = &dispserv_null;\n#else\n         current_display_server = &dispserv_null;`;
  return replaceOnce(source, marker, replacement, "headless display-server fallback");
};

const patchHeadlessDarwinSources = (sourceRoot) => {
  const patches = [
    ["frontend/drivers/platform_darwin.m", patchDarwinFrontend],
    ["configuration.c", patchConfiguration],
    ["gfx/video_driver.c", patchVideoDriver],
  ];
  for (const [relativePath, patch] of patches) {
    const filename = path.join(sourceRoot, relativePath);
    fs.writeFileSync(filename, patch(fs.readFileSync(filename, "utf8")));
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.argv[2], "usage: patch-headless-darwin.mjs RETROARCH_SOURCE_DIR");
  patchHeadlessDarwinSources(process.argv[2]);
}

export { patchConfiguration, patchDarwinFrontend, patchHeadlessDarwinSources, patchVideoDriver };
