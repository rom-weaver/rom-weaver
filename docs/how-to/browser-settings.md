# Set up the browser app

Use Settings to change app preferences, enable beta tools, and prepare local assets for offline use.

<!-- START doctoc -->
## Table of contents

- [Change preferences](#change-preferences)
- [Enable beta tools](#enable-beta-tools)
- [Prepare for offline use](#prepare-for-offline-use)
- [Back up saves and manage storage](#back-up-saves-and-manage-storage)

<!-- END doctoc -->

## Change preferences

Open **Settings** from the app navigation. Change the required values, then select **Save**.

The settings cover language, byte units, guided help, output defaults, compression, and worker threads. Leave automatic thread selection enabled unless you need to limit resource use.

The separate **Theme** and **Accent** controls in the navigation apply changes immediately. Theme offers light, dark, and system appearance; Accent changes the highlight color.

## Enable beta tools

1. Open **Settings**.
2. Select **Enable beta tools (Trim, PPF undo, Save Editor, and cheats)**.
3. Select **Save**.
4. Open the required tool from the app's navigation.

This exposes Trim, PPF Undo, Save Editor, and cheat-code creation on Create. Cheats on Apply do not require this setting.

## Prepare for offline use

1. While online, open **Settings**, select **Keep an offline copy**, then **Save**.
2. Wait for the app's offline download to finish.
3. Reopen **Settings** and select the **Optional ROM databases** you need. These choices download immediately.
4. Open the sample, bundle, or cheat list you plan to use while online.
5. Load a game for each emulator system you need, so its core is cached.

Check the result before relying on it: disconnect your device, reopen rom-weaver, and run a small local job.

Remote bundle links still need network access unless their required files are available locally. Browser storage eviction can remove cached assets.

[Offline behavior](../explanation/local-first.md#offline) explains these limits. [Test a ROM](test-roms-in-browser.md) covers emulator controls.

## Back up saves and manage storage

Before clearing site data, [export emulator saves](test-roms-in-browser.md#export-and-restore-a-save).

Use **Storage** to inspect emulator saves and working files. Clear an **Optional ROM databases** selection in Settings to remove that group's cached data.

Remove only data you no longer need. Browser site-data controls can remove the entire local app cache.

[Privacy](../legal/privacy.md) lists what the browser stores. [Webapp status](../hosting/webapp-runtime-status.md) explains the version and offline status labels.
