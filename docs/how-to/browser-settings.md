# Set up the browser app

Set preferences, enable beta tools, and prepare offline assets in **Settings**.

<!-- START doctoc -->
## Table of contents

- [Change preferences](#change-preferences)
- [Enable beta tools](#enable-beta-tools)
- [Prepare for offline use](#prepare-for-offline-use)
- [Back up saves and manage storage](#back-up-saves-and-manage-storage)

<!-- END doctoc -->

## Change preferences

Open **Settings** from navigation, or **Menu** → **Settings** at the bottom-right on a phone. Change preferences, then select **Save**.

Settings covers language, byte units, output defaults, compression, and the practice-run links. **Show practice-run links** adds links such as **Patch a practice ROM** below empty drop zones for [practice runs](../reference/guided-runs.md). **Advanced** exposes worker threads, codecs, and RVZ block size. Keep automatic thread selection unless limiting resources.

On phones, leave Settings with bottom-right **Close**, a right swipe from the left edge, or the browser's back gesture.

Navigation’s separate **Theme** (light, dark, or system) and **Accent** (highlight color) controls apply immediately, as do the Theme and Accent choices inside the Settings dialog. **Optional ROM databases** download or delete immediately, and **Advanced** changes persist as you make them. Every other setting waits for **Save**.

## Enable beta tools

1. Open **Settings**.
2. Select **Enable beta tools (Trim and Save Editor)**.
3. Select **Save**.
4. Open the required tool from the app's navigation.

Only Trim and Save Editor require this setting; PPF Undo and cheats in Apply, Create, and Identify do not.

## Prepare for offline use

1. While online, open **Settings**, select **Keep an offline copy**, then **Save**.
2. Wait for the app's offline download to finish.
3. Reopen **Settings** and select the **Optional ROM databases** you need. These choices download immediately.

**Offline active** confirms the app, every emulator core, and the **Optional ROM databases** you selected are cached. Keep ROMs and patches locally. Browser-menu installation does not verify these resources.

Before relying on offline use, disconnect, reopen rom-weaver, and run a small local job.

Remote weaves need network access unless their files are local. Browser storage eviction can remove cached assets.

[Offline behavior](../explanation/local-first.md#offline) explains these limits. [Test a ROM](test-roms-in-browser.md) covers emulator controls.

## Back up saves and manage storage

Before clearing site data, [export emulator saves](test-roms-in-browser.md#export-and-restore-a-save).

Inspect saves in **Saves & storage**; enable **Advanced** to include working files. Clear an **Optional ROM databases** selection in Settings to remove that group's cached data.

Remove only unneeded data: browser site-data controls can erase the entire app cache.

See [Privacy](../legal/privacy.md) for stored data and [Webapp status](../hosting/webapp-runtime-status.md) for version/offline labels.
