/* rom-weaver - loom workbench prototype.
   Static demo driver: i18n, theming, mode tabs, scenario engine with a
   simulated job run, dialogs, and the inspector. Every scenario (empty,
   drag-over, staging, ready, running, error, complete) renders in every
   mode (apply, create, trim). No app code is shared. */
(() => {
  "use strict";

  /* ════════ i18n ════════ */
  const CATALOGS = {
    en: {
      "mode.apply": "Apply", "mode.create": "Create", "mode.trim": "Trim",
      "theme.toLight": "Switch to light theme", "theme.toDark": "Switch to dark theme",
      "tools.log": "Log",
      "log.empty": "No {level}-level entries", "log.emptyFilter": "No lines match “{q}”", "log.filter": "Filter", "log.filterLabel": "Filter log",
      "common.copy": "Copy", "common.cancel": "Cancel", "common.close": "Close",
      "common.dismiss": "Dismiss", "common.remove": "Remove", "common.retry": "Retry",
      "update.ready": "Update ready", "update.whatsNew": "What’s new", "update.reload": "Reload",
      "update.dialogTitle": "Update", "update.note": "Reloading swaps the cached app. Running jobs are finished first.",
      "update.later": "Later", "update.reloadNow": "Reload now",
      "wakelock.text": "Screen stays awake while a job is running.",
      "confirm.title": "Remove all inputs?", "confirm.confirm": "Remove all",
      "confirm.body": "This clears every staged ROM and patch from the workbench. Files on disk are not touched.",
      "confirm.trimTitle": "Trim ROM?", "confirm.trimConfirm": "Trim ROM",
      "confirm.trimBody": "Trimming writes a new, smaller ROM - this is permanent. Your original file is left untouched and an untrimmed copy is kept, so you can restore it.",
      "settings.title": "Settings", "settings.save": "Save", "settings.reset": "Reset",
      "settings.general": "General", "settings.language": "Language", "settings.logLevel": "Log level", "settings.units": "Size units",
      "settings.devTools": "Dev tools", "settings.fixes": "Fixes", "settings.fixChecksum": "Fix ROM header",
      "settings.verification": "Verification", "settings.requireInput": "Require input match",
      "settings.requireOutput": "Require output match", "settings.compression": "Compression",
      "settings.defaultCompression": "Default format", "settings.profile": "Level",
      "settings.workerThreads": "Worker threads", "settings.codecs": "Codecs", "settings.rvz": "RVZ",
      "settings.zipCodec": "ZIP", "settings.sevenZipCodec": "7z", "settings.rvzCodec": "RVZ",
      "settings.chdCd": "CD", "settings.chdDvd": "DVD", "settings.rvzBlockSize": "Block size",
      "settings.threadsHint": "“auto” resolves to the browser-reported core count of {n}.",
      "settings.validation": "Worker threads must be “auto” or a number between 1 and 64.",
            "scale.min": "Min", "scale.veryLow": "Very Low", "scale.low": "Low", "scale.medium": "Medium",
      "scale.high": "High", "scale.veryHigh": "Very High", "scale.max": "Max",
      "opts.output": "Options",
      "drawer.tracks": "Tracks & checks", "drawer.extract": "Extract", "drawer.verifications": "Verify", "verify.input": "Input", "verify.output": "Output", "verify.dryRun": "Dry-run", "verify.dryRunDesc": "Apply to a scratch copy and re-hash - no source bytes touched", "verify.dryRunPass": "Passed - scratch output re-hash matches", "verify.dryRunFail": "Failed - scratch output differs",
      "verify.expIn": "Expected input checksum", "verify.expOut": "Expected output checksum", "verify.ckHint": "CRC32, MD5, or SHA-1",
      "info.aria": "More info",
      "info.romInput": "Archives are decompressed and the ROM is located automatically; chd/rvz/z3ds containers are unpacked before patching; nested archives resolve recursively. RetroArch softpatch naming is supported.",
      "info.patches": "Patches apply top to bottom - drag the handle to reorder. Filename hints (crc32 / size) are checked before the run.",
      "info.output": "Set the filename without an extension - the format select controls it. Containers (zip, 7z, chd, rvz) are written directly.",
      "info.outputOptions": "Codec and level defaults come from Settings › Compression; changes here affect only this job.",
      "info.compressType": "Optionally wrap the output in a compressed container - “none” writes the raw file.",
      "info.level": "Profile → level: Min 0/−7 · Medium 5/11 · Max 9/22 (standard / zstd). A codec:level entry in a codec list overrides this.",
      "info.threads": "“auto” resolves to the browser-reported core count of {n}.",
      "info.units": "MB counts in decimal (10⁶ bytes), MiB in binary (2²⁰ bytes). Sizes everywhere follow this choice.",
      "info.fixHeader": "Recalculates internal header checksums after patching so clean dumps verify again.",
      "info.verification": "Block the run when input or output hashes don’t match the patch requirements.",
      "info.zipCodec": "Valid: deflate, zstd, store. zstd writes ZIP-compatible output; store ignores Level.",
      "info.sevenZipCodec": "7z output currently uses LZMA2.",
      "info.rvzCodec": "Default zstd. Optional level: zstd:-7 through zstd:22.",
      "info.chdCd": "Valid: cdlz, cdzl, cdfl. Entries without a level use the Level profile.",
      "info.chdDvd": "Valid: lzma, zlib, huff, flac. huff has no level.",
      "info.rvzBlock": "Default 128 KiB. Larger blocks compress better but seek slower.",
      "info.window": "Diff window for create - larger spans find moved data but use more memory.",
      "info.trimPad": "Byte expected in the tail run; auto detects 0x00 or 0xFF.",
      "info.trimRom": "Tail trim: nds, dsi, srl (0x00 padding) and gba, 3ds (0xFF) - the trailing run is detected and removed; Xbox xiso images (.xiso or .iso) trim their unused tail; GameCube/Wii images (iso, gcm, wbfs, rvz) trim by scrubbing junk blocks during RVZ conversion; the original file is untouched and an untrimmed copy is kept for restore.",
      "info.createOriginal": "The clean, unmodified dump that players already own; its checksum is embedded in the patch as the apply requirement; archives and containers resolve automatically.",
      "info.createModified": "Your edited build - the file the patch should reproduce; only the differences from the original are encoded; the size may differ from the original (growth is supported).",
      "drop.hero": "Drop a ROM or patches", "drop.heroCreate": "Drop the original and modified ROMs",
      "drop.heroTrim": "Drop a ROM to trim", "drop.add": "Replace the ROM or add patches",
      "drop.addCreate": "Add or replace a ROM", "drop.addTrim": "Replace the ROM",
      "drop.original": "Drop the original ROM", "drop.modified": "Drop the modified ROM", "drop.addPatches": "Drop patch files",
      "drop.hint": "click or drop files anywhere on the page - archives, containers, cue sheets and softpatches resolve automatically", "drop.tapAnywhere": "Tap anywhere to choose files",
      "drop.staging": "Reading dropped files…",
      "drop.anywhereShort": "click to browse - or drop files anywhere on the page", "drop.tap": "Tap to choose files", "drop.release": "Release to stage files",
      "step.rom": "ROM", "step.patches": "Patches", "step.apply": "Apply",
      "step.original": "Original", "step.modified": "Modified", "step.patch": "Patch", "step.output": "Output",
      "empty.needsInput": "Add your files in {loc} above to begin", "empty.needsInputNoun": "Add {noun} in {loc} above",
      "step.inputs": "Inputs", "needs.rom": "a ROM", "needs.patches": "patches", "needs.original": "the original ROM", "needs.modified": "the modified ROM", "needs.source": "a ROM",
      "roms.files.one": "{n} file", "roms.files.other": "{n} files", "roms.tracks.one": "{n} track", "roms.tracks.other": "{n} tracks", "roms.track": "Track {n}", "roms.extracting": "Extracting {name}…", "patch.parsing": "Parsing {name}…",
      "patch.target": "Target", "patch.format": "Format", "track.word": "Track",
      "patch.toggle": "Include {name}", "patch.on": "On", "patch.stateOff": "Off",
      "patch.offCount.one": "{n} patch is off - tick it to include it", "patch.offCount.other": "{n} patches are off - tick them to include them",
      "patch.off.one": "{n} disabled", "patch.off.other": "{n} disabled",
      "patch.undo": "Undo-aware re-apply (revalidates patched blocks)",
      "patch.embed": "Embed source crc32 in the output filename",
      "verdict.mismatch": "Mismatch",
      "footer.donate": "Donate",
      "warn.ipsNoChecksum": "IPS carries no embedded checksums - gated by the filename hint only.",
      "cks.label": "Checks", "cue.label": "Cue", "gdi.label": "GDI",
      "variant.asDumped": "File - as dumped", "variant.withHeader": "File - as dumped (with 512 B header)",
      "variant.noHeader": "Without copier header", "variant.autoTrimmed": "Auto-trimmed",
      "req.targetBlockcheck": "target blockcheck", "req.undoData": "undo data", "req.present": "present",
      "req.patchedCrc32": "patched crc32", "req.rebuiltCue": "rebuilt cue", "req.rebuiltGdi": "rebuilt gdi",
      "req.embeddedSizes": "embedded sizes", "req.sizesInOut": "in {in} → out {out}",
      "picker.hint": "The archive contains more than one candidate - pick the ones to stage.",
      "picker.use": "Use selection", "picker.skipped": "skipped",
      "opts.title": "Options", "opts.rom": "Options", "opts.patch": "Options", "opts.window": "Diff window", "opts.trimPad": "Padding byte", "opts.trimVerify": "Verify output after trim",
      "opt.rebuildCue": "Rebuild cue sheet for the patched output", "opt.rebuildCueShort": "rebuild cue",
      "opt.rebuildGdi": "Rebuild .gdi index for the patched output", "opt.rebuildGdiShort": "rebuild gdi",
      "opt.fixHeader": "Fix ROM header before diff (512 B copier header)", "opt.fixHeaderShort": "header fix",
      "opt.autoTrim": "Auto-trim before hashing (→ {size})", "opt.autoTrimShort": "auto-trim",
      "opt.sizeGrowth": "Allow size growth (truncation record)", "opt.sizeGrowthShort": "size growth",
      "opt.sourceWindow": "Source window", "opt.sourceWindowShort": "window",
      "out.placeholder": "Output filename (no extension)",
      "run.apply.one": "Weave {n} patch", "run.apply.other": "Weave {n} patches", "run.applyEmpty": "Weave patches", "run.create": "Create patch", "run.trim": "Trim ROM",
      "running.cancel": "Cancel job", "drop.cancelStage": "Cancel reading", "patch.reorder": "Drag to reorder - arrow keys move",
      "stage.detect": "Detect", "stage.extract": "Extract", "stage.checksum": "Checksum", "stage.apply": "Apply",
      "stage.compress": "Compress", "stage.write": "Write", "stage.verify": "Verify",
      "stage.diff": "Diff", "stage.encode": "Encode", "stage.scan": "Scan", "stage.trim": "Trim",
      "progress.threads": "{n} threads",
      "result.done": "Patched & verified", "result.created": "Patch created & verified", "result.trimmed": "Trimmed & verified",
      "result.patchType": "{t} patch", "result.archive": "{t} archive", "result.raw": "raw {t}",
      "result.records": "{n} delta records",
      "result.download": "Download",
      "fault.remedyK": "Remedy", "fault.copy": "Copy report",
      "fault.apply.title": "Patch target mismatch",
      "fault.apply.body": "“SOTN - Randomizer (v1.8).ppf” was built for Rev 1 - it expects Track 1 CRC32 0xE2B40FA2, but this dump’s Track 1 hashes to 0xACBC1C34 (Rev 0). The patch was not applied.",
      "fault.apply.remedy": "Use a Rev 1 dump - or tick the override to force-apply (undo data still allows rollback).",
      "fault.apply.override": "Apply anyway - skip the target checksum gate (output may be corrupt)",
      "fault.applySingle.title": "Patch target mismatch",
      "fault.applySingle.body": "“Mother 3 Fan Translation v1.3.ips” expects source CRC32 0xA6CAA62E, but “Mother 3 (Japan).gba” hashes to 0x2A2074B6. The patch was not applied.",
      "fault.applySingle.remedy": "Use a clean, unheadered dump - or tick the override below to force-apply.",
      "fault.applySingle.override": "Apply anyway - skip the source checksum gate (output may be corrupt)",
      "input.disc": "Multi-track disc", "input.gdi": "GD-ROM disc", "input.single": "Single file",
      "notice.disc": "<b>Patch order matters</b> - the randomizer rewrites Track 1 blocks before the retranslation’s xdelta.",
      "notice.gdi": "<b>Patch order matters</b> - the framerate restore rewrites Track 3 blocks before the widescreen xdelta.",
      "notice.single": "<b>RetroArch softpatch</b> - “Mother 3 Fan Translation v1.3.ips” matches its ROM by name; order matters when stacking.",
      "create.identical": "Identical to Original - same SHA-1",
      "fault.create.title": "Patch creation failed",
      "fault.create.body": "“Chrono Trigger (USA).sfc” and “Chrono Trigger - Flames of Eternity (v2.5).sfc” are byte-identical (SHA-1 match) - there is nothing to diff.",
      "fault.create.remedy": "Stage the unmodified dump as Original and the hacked build as Modified.",
      "fault.trim.title": "Nothing to trim",
      "fault.trim.body": "No trailing padding found - “Pokemon HeartGold (USA).nds” has no 0x00/0xFF tail run. The ROM is already at minimal size.",
      "fault.trim.remedy": "This dump is already trimmed; re-trimming would only rewrite the file.",
      "status.idle": "idle", "status.staging": "staging", "status.ready": "ready",
      "status.running": "running", "status.failed": "failed", "status.done": "done",
      "status.faultMsg": "{code} at stage {stage}",
      "status.doneMsg": "rom-weaver finished in {t}",
      "trim.detected": "Trailing padding detected", "trim.savings": "{from} → {to} ({p} smaller)",
      "create.swap": "Swap",
      "env.threads": "threads",
      "scenario.empty": "Empty", "scenario.dragging": "Drag-over", "scenario.staging": "Staging",
      "scenario.ready": "Ready", "scenario.running": "Running", "scenario.fault": "Error", "scenario.complete": "Complete",
      "announce.scenario": "Scenario: {name}", "announce.copied": "Copied to clipboard", "announce.reordered": "Patch moved to position {n}",
    },
    es: {
      "mode.apply": "Aplicar", "mode.create": "Crear", "mode.trim": "Recortar",
      "theme.toLight": "Cambiar a tema claro", "theme.toDark": "Cambiar a tema oscuro",
      "tools.log": "Registro",
      "log.empty": "Sin entradas de nivel {level}", "log.emptyFilter": "Ninguna línea coincide con «{q}»", "log.filter": "Filtrar", "log.filterLabel": "Filtrar el registro",
      "common.copy": "Copiar", "common.cancel": "Cancelar", "common.close": "Cerrar",
      "common.dismiss": "Descartar", "common.remove": "Quitar", "common.retry": "Reintentar",
      "update.ready": "Actualización lista", "update.whatsNew": "Novedades", "update.reload": "Recargar",
      "update.dialogTitle": "Actualización", "update.note": "Recargar reemplaza la app en caché. Los trabajos en curso terminan primero.",
      "update.later": "Más tarde", "update.reloadNow": "Recargar ahora",
      "wakelock.text": "La pantalla permanece activa mientras se ejecuta un trabajo.",
      "confirm.title": "¿Quitar todas las entradas?", "confirm.confirm": "Quitar todo",
      "confirm.body": "Esto limpia todos los ROM y parches preparados del banco de trabajo. Los archivos en disco no se tocan.",
      "confirm.trimTitle": "¿Recortar ROM?", "confirm.trimConfirm": "Recortar ROM",
      "confirm.trimBody": "Recortar escribe un ROM nuevo y más pequeño - es permanente. Tu archivo original queda intacto y se conserva una copia sin recortar para restaurarlo.",
      "settings.title": "Ajustes", "settings.save": "Guardar", "settings.reset": "Restablecer",
      "settings.general": "General", "settings.language": "Idioma", "settings.logLevel": "Nivel de registro", "settings.units": "Unidades de tamaño",
      "settings.devTools": "Herramientas dev", "settings.fixes": "Correcciones", "settings.fixChecksum": "Corregir cabecera ROM",
      "settings.verification": "Verificación", "settings.requireInput": "Exigir coincidencia de entrada",
      "settings.requireOutput": "Exigir coincidencia de salida", "settings.compression": "Compresión",
      "settings.defaultCompression": "Formato por defecto", "settings.profile": "Nivel",
      "settings.workerThreads": "Hilos de trabajo", "settings.codecs": "Códecs", "settings.rvz": "RVZ",
      "settings.zipCodec": "ZIP", "settings.sevenZipCodec": "7z", "settings.rvzCodec": "RVZ",
      "settings.chdCd": "CD", "settings.chdDvd": "DVD", "settings.rvzBlockSize": "Tamaño de bloque",
      "settings.threadsHint": "«auto» usa el número de núcleos que reporta el navegador: {n}.",
      "settings.validation": "Los hilos deben ser «auto» o un número entre 1 y 64.",
            "scale.min": "Mín", "scale.veryLow": "Muy bajo", "scale.low": "Bajo", "scale.medium": "Medio",
      "scale.high": "Alto", "scale.veryHigh": "Muy alto", "scale.max": "Máx",
      "opts.output": "Opciones",
      "drawer.tracks": "Pistas y sumas", "drawer.extract": "Extraer", "drawer.verifications": "Verificar", "verify.input": "Entrada", "verify.output": "Salida", "verify.dryRun": "Simulación", "verify.dryRunDesc": "Aplica sobre una copia temporal y re-hashea - sin tocar los bytes de origen", "verify.dryRunPass": "Correcto - el re-hash de la copia coincide", "verify.dryRunFail": "Fallo - la salida de la copia difiere",
      "verify.expIn": "Suma de entrada esperada", "verify.expOut": "Suma de salida esperada", "verify.ckHint": "CRC32, MD5 o SHA-1",
      "info.aria": "Más información",
      "info.romInput": "Los archivos se descomprimen y el ROM se localiza solo; los contenedores chd/rvz/z3ds se desempaquetan antes de parchear; los archivos anidados se resuelven recursivamente. Se admite el softpatch de RetroArch.",
      "info.patches": "Los parches se aplican de arriba abajo - arrastra el asa para reordenar. Las pistas del nombre (crc32 / tamaño) se comprueban antes de ejecutar.",
      "info.output": "Escribe el nombre sin extensión - el selector de formato la controla. Los contenedores (zip, 7z, chd, rvz) se escriben directamente.",
      "info.outputOptions": "Los códecs y niveles por defecto vienen de Ajustes › Compresión; los cambios aquí solo afectan a este trabajo.",
      "info.compressType": "Opcionalmente envuelve la salida en un contenedor comprimido - «none» escribe el archivo tal cual.",
      "info.level": "Perfil → nivel: Mín 0/−7 · Medio 5/11 · Máx 9/22 (estándar / zstd). Una entrada codec:nivel lo anula.",
      "info.threads": "«auto» usa el número de núcleos que reporta el navegador: {n}.",
      "info.units": "MB cuenta en decimal (10⁶ bytes), MiB en binario (2²⁰ bytes). Todos los tamaños siguen esta elección.",
      "info.fixHeader": "Recalcula las sumas de la cabecera tras parchear para que los volcados limpios verifiquen de nuevo.",
      "info.verification": "Bloquea la ejecución si las sumas de entrada o salida no coinciden con los requisitos del parche.",
      "info.zipCodec": "Válidos: deflate, zstd, store. zstd escribe salida compatible con ZIP; store ignora el Nivel.",
      "info.sevenZipCodec": "La salida 7z usa actualmente LZMA2.",
      "info.rvzCodec": "Por defecto zstd. Nivel opcional: zstd:-7 a zstd:22.",
      "info.chdCd": "Válidos: cdlz, cdzl, cdfl. Las entradas sin nivel usan el perfil de Nivel.",
      "info.chdDvd": "Válidos: lzma, zlib, huff, flac. huff no tiene nivel.",
      "info.rvzBlock": "Por defecto 128 KiB. Bloques mayores comprimen mejor pero buscan más lento.",
      "info.window": "Ventana de diff al crear - más grande encuentra datos movidos pero usa más memoria.",
      "info.trimPad": "Byte esperado en la cola; auto detecta 0x00 o 0xFF.",
      "info.trimRom": "Recorte de cola: nds, dsi, srl (relleno 0x00) y gba, 3ds (0xFF) - la cola se detecta y se elimina; las imágenes Xbox xiso (.xiso o .iso) recortan su cola sin usar; las imágenes de GameCube/Wii (iso, gcm, wbfs, rvz) recortan limpiando bloques basura al convertir a RVZ; tu archivo original no se toca y se conserva una copia sin recortar para restaurar.",
      "info.createOriginal": "El volcado limpio y sin modificar que ya tienen los jugadores; su suma se incrusta en el parche como requisito de aplicación; archivos y contenedores se resuelven solos.",
      "info.createModified": "Tu versión modificada - el archivo que el parche debe reproducir; solo se codifican las diferencias con el original; el tamaño puede diferir del original (se admite el crecimiento).",
      "drop.hero": "Suelta un ROM o parches", "drop.heroCreate": "Suelta el ROM original y el modificado",
      "drop.heroTrim": "Suelta un ROM para recortar", "drop.add": "Reemplaza el ROM o añade parches",
      "drop.addCreate": "Añadir o reemplazar un ROM", "drop.addTrim": "Reemplazar el ROM",
      "drop.original": "Suelta el ROM original", "drop.modified": "Suelta el ROM modificado", "drop.addPatches": "Suelta archivos de parche",
      "drop.hint": "haz clic o suelta archivos en cualquier parte de la página - archivos, contenedores, hojas cue y softpatches se resuelven solos", "drop.tapAnywhere": "Toca en cualquier parte para elegir archivos",
      "drop.staging": "Leyendo archivos soltados…",
      "drop.anywhereShort": "haz clic para explorar - o suelta archivos en cualquier parte de la página", "drop.tap": "Toca para elegir archivos", "drop.release": "Suelta para preparar los archivos",
      "step.rom": "ROM", "step.patches": "Parches", "step.apply": "Aplicar",
      "step.original": "Original", "step.modified": "Modificado", "step.patch": "Parche", "step.output": "Salida",
      "empty.needsInput": "Añade tus archivos en {loc} arriba para empezar", "empty.needsInputNoun": "Añade {noun} en {loc} arriba",
      "step.inputs": "Entradas", "needs.rom": "un ROM", "needs.patches": "parches", "needs.original": "el ROM original", "needs.modified": "el ROM modificado", "needs.source": "un ROM",
      "roms.files.one": "{n} archivo", "roms.files.other": "{n} archivos", "roms.tracks.one": "{n} pista", "roms.tracks.other": "{n} pistas", "roms.track": "Pista {n}", "roms.extracting": "Extrayendo {name}…", "patch.parsing": "Analizando {name}…",
      "patch.target": "Destino", "patch.format": "Formato", "track.word": "Pista",
      "patch.toggle": "Incluir {name}", "patch.on": "Sí", "patch.stateOff": "No",
      "patch.offCount.one": "{n} parche está desactivado - márcalo para incluirlo", "patch.offCount.other": "{n} parches están desactivados - márcalos para incluirlos",
      "patch.off.one": "{n} desactivado", "patch.off.other": "{n} desactivados",
      "patch.undo": "Reaplicación con deshacer (revalida los bloques parcheados)",
      "patch.embed": "Incluir el crc32 de origen en el nombre de salida",
      "verdict.mismatch": "Discrepancia",
      "footer.donate": "Donar",
      "warn.ipsNoChecksum": "IPS no incluye sumas de comprobación - solo se valida con la pista del nombre de archivo.",
      "cks.label": "Sumas", "cue.label": "Hoja cue", "gdi.label": "Índice GDI",
      "variant.asDumped": "Archivo - tal como se volcó", "variant.withHeader": "Archivo - tal como se volcó (con cabecera de 512 B)",
      "variant.noHeader": "Sin cabecera de copiador", "variant.autoTrimmed": "Auto-recortado",
      "req.targetBlockcheck": "blockcheck de destino", "req.undoData": "datos de deshacer", "req.present": "presente",
      "req.patchedCrc32": "crc32 parcheado", "req.rebuiltCue": "cue regenerada", "req.rebuiltGdi": "gdi regenerado",
      "req.embeddedSizes": "tamaños integrados", "req.sizesInOut": "entrada {in} → salida {out}",
      "picker.hint": "El archivo contiene más de un candidato - elige cuáles preparar.",
      "picker.use": "Usar selección", "picker.skipped": "omitido",
      "opts.title": "Opciones", "opts.rom": "Opciones", "opts.patch": "Opciones", "opts.window": "Ventana de diff", "opts.trimPad": "Byte de relleno", "opts.trimVerify": "Verificar la salida tras recortar",
      "opt.rebuildCue": "Regenerar la hoja cue para la salida parcheada", "opt.rebuildCueShort": "regenerar cue",
      "opt.rebuildGdi": "Regenerar el índice .gdi para la salida parcheada", "opt.rebuildGdiShort": "regenerar gdi",
      "opt.fixHeader": "Corregir la cabecera ROM antes del diff (cabecera de copiador de 512 B)", "opt.fixHeaderShort": "corregir cabecera",
      "opt.autoTrim": "Auto-recortar antes de hashear (→ {size})", "opt.autoTrimShort": "auto-recorte",
      "opt.sizeGrowth": "Permitir crecimiento de tamaño (registro de truncado)", "opt.sizeGrowthShort": "crecimiento",
      "opt.sourceWindow": "Ventana de origen", "opt.sourceWindowShort": "ventana",
      "out.placeholder": "Nombre de salida (sin extensión)",
      "run.apply.one": "Tejer {n} parche", "run.apply.other": "Tejer {n} parches", "run.applyEmpty": "Tejer parches", "run.create": "Crear parche", "run.trim": "Recortar ROM",
      "running.cancel": "Cancelar trabajo", "drop.cancelStage": "Cancelar lectura", "patch.reorder": "Arrastra para reordenar - las flechas mueven",
      "stage.detect": "Detectar", "stage.extract": "Extraer", "stage.checksum": "Suma", "stage.apply": "Aplicar",
      "stage.compress": "Comprimir", "stage.write": "Escribir", "stage.verify": "Verificar",
      "stage.diff": "Comparar", "stage.encode": "Codificar", "stage.scan": "Escanear", "stage.trim": "Recortar",
      "progress.threads": "{n} hilos",
      "result.done": "Parcheado y verificado", "result.created": "Parche creado y verificado", "result.trimmed": "Recortado y verificado",
      "result.patchType": "parche {t}", "result.archive": "archivo {t}", "result.raw": "{t} sin comprimir",
      "result.records": "{n} registros delta",
      "result.download": "Descargar",
      "fault.remedyK": "Solución", "fault.copy": "Copiar informe",
      "fault.apply.title": "El destino del parche no coincide",
      "fault.apply.body": "«SOTN - Randomizer (v1.8).ppf» se creó para Rev 1 - espera CRC32 de Pista 1 0xE2B40FA2, pero la Pista 1 de este volcado da 0xACBC1C34 (Rev 0). El parche no se aplicó.",
      "fault.apply.remedy": "Usa un volcado Rev 1 - o marca la anulación para forzar (los datos de deshacer permiten revertir).",
      "fault.apply.override": "Aplicar igualmente - omitir la verificación de destino (la salida puede corromperse)",
      "fault.applySingle.title": "El destino del parche no coincide",
      "fault.applySingle.body": "«Mother 3 Fan Translation v1.3.ips» espera CRC32 de origen 0xA6CAA62E, pero «Mother 3 (Japan).gba» da 0x2A2074B6. El parche no se aplicó.",
      "fault.applySingle.remedy": "Usa un volcado limpio sin cabecera - o marca la anulación para forzar la aplicación.",
      "fault.applySingle.override": "Aplicar igualmente - omitir la verificación de origen (la salida puede corromperse)",
      "input.disc": "Disco multipista", "input.gdi": "Disco GD-ROM", "input.single": "Archivo único",
      "notice.disc": "<b>El orden de los parches importa</b> - el randomizer reescribe bloques de la Pista 1 antes del xdelta de la retraducción.",
      "notice.gdi": "<b>El orden de los parches importa</b> - la restauración de framerate reescribe bloques de la Pista 3 antes del xdelta de pantalla ancha.",
      "notice.single": "<b>Softpatch de RetroArch</b> - «Mother 3 Fan Translation v1.3.ips» empareja su ROM por nombre; el orden importa al apilar.",
      "create.identical": "Idéntico al Original - mismo SHA-1",
      "fault.create.title": "Fallo al crear el parche",
      "fault.create.body": "«Chrono Trigger (USA).sfc» y «Chrono Trigger - Flames of Eternity (v2.5).sfc» son idénticos byte a byte (SHA-1 igual) - no hay nada que comparar.",
      "fault.create.remedy": "Pon el volcado sin modificar como Original y la versión modificada como Modificado.",
      "fault.trim.title": "Nada que recortar",
      "fault.trim.body": "No se encontró relleno final - «Pokemon HeartGold (USA).nds» no tiene cola de 0x00/0xFF. El ROM ya está en su tamaño mínimo.",
      "fault.trim.remedy": "Este volcado ya está recortado; volver a recortar solo reescribiría el archivo.",
      "status.idle": "inactivo", "status.staging": "preparando", "status.ready": "listo",
      "status.running": "ejecutando", "status.failed": "fallido", "status.done": "hecho",
      "status.faultMsg": "{code} en la etapa {stage}",
      "status.doneMsg": "rom-weaver terminó en {t}",
      "trim.detected": "Relleno final detectado", "trim.savings": "{from} → {to} ({p} más pequeño)",
      "create.swap": "Intercambiar",
      "env.threads": "hilos",
      "scenario.empty": "Vacío", "scenario.dragging": "Arrastre", "scenario.staging": "Preparando",
      "scenario.ready": "Listo", "scenario.running": "Ejecutando", "scenario.fault": "Error", "scenario.complete": "Completo",
      "announce.scenario": "Escenario: {name}", "announce.copied": "Copiado al portapapeles", "announce.reordered": "Parche movido a la posición {n}",
    },
    de: {
      "mode.apply": "Anwenden", "mode.create": "Erstellen", "mode.trim": "Trimmen",
      "theme.toLight": "Zum hellen Design wechseln", "theme.toDark": "Zum dunklen Design wechseln",
      "tools.log": "Protokoll",
      "log.empty": "Keine {level}-Einträge", "log.emptyFilter": "Keine Zeile passt zu „{q}“", "log.filter": "Filtern", "log.filterLabel": "Protokoll filtern",
      "common.copy": "Kopieren", "common.cancel": "Abbrechen", "common.close": "Schließen",
      "common.dismiss": "Verwerfen", "common.remove": "Entfernen", "common.retry": "Erneut",
      "update.ready": "Update bereit", "update.whatsNew": "Neuigkeiten", "update.reload": "Neu laden",
      "update.dialogTitle": "Update", "update.note": "Neuladen tauscht die zwischengespeicherte App aus. Laufende Jobs werden zuerst beendet.",
      "update.later": "Später", "update.reloadNow": "Jetzt neu laden",
      "wakelock.text": "Der Bildschirm bleibt aktiv, solange ein Job läuft.",
      "confirm.title": "Alle Eingaben entfernen?", "confirm.confirm": "Alle entfernen",
      "confirm.body": "Entfernt alle eingelegten ROMs und Patches von der Werkbank. Dateien auf der Festplatte bleiben unberührt.",
      "confirm.trimTitle": "ROM trimmen?", "confirm.trimConfirm": "ROM trimmen",
      "confirm.trimBody": "Trimmen schreibt ein neues, kleineres ROM - das ist dauerhaft. Deine Originaldatei bleibt unberührt und eine ungetrimmte Kopie wird aufbewahrt, sodass du sie wiederherstellen kannst.",
      "settings.title": "Einstellungen", "settings.save": "Speichern", "settings.reset": "Zurücksetzen",
      "settings.general": "Allgemein", "settings.language": "Sprache", "settings.logLevel": "Protokollstufe", "settings.units": "Größeneinheiten",
      "settings.devTools": "Dev-Werkzeuge", "settings.fixes": "Korrekturen", "settings.fixChecksum": "ROM-Header korrigieren",
      "settings.verification": "Verifizierung", "settings.requireInput": "Eingabe-Übereinstimmung erzwingen",
      "settings.requireOutput": "Ausgabe-Übereinstimmung erzwingen", "settings.compression": "Kompression",
      "settings.defaultCompression": "Standardformat", "settings.profile": "Stufe",
      "settings.workerThreads": "Worker-Threads", "settings.codecs": "Codecs", "settings.rvz": "RVZ",
      "settings.zipCodec": "ZIP", "settings.sevenZipCodec": "7z", "settings.rvzCodec": "RVZ",
      "settings.chdCd": "CD", "settings.chdDvd": "DVD", "settings.rvzBlockSize": "Blockgröße",
      "settings.threadsHint": "„auto“ nutzt die vom Browser gemeldete Kernanzahl: {n}.",
      "settings.validation": "Worker-Threads muss „auto“ oder eine Zahl zwischen 1 und 64 sein.",
            "scale.min": "Min", "scale.veryLow": "Sehr niedrig", "scale.low": "Niedrig", "scale.medium": "Mittel",
      "scale.high": "Hoch", "scale.veryHigh": "Sehr hoch", "scale.max": "Max",
      "opts.output": "Optionen",
      "drawer.tracks": "Tracks & Prüfungen", "drawer.extract": "Entpacken", "drawer.verifications": "Prüfen", "verify.input": "Eingang", "verify.output": "Ausgang", "verify.dryRun": "Probelauf", "verify.dryRunDesc": "Auf eine Kopie anwenden und neu hashen - Quellbytes bleiben unberührt", "verify.dryRunPass": "Bestanden - Scratch-Ausgabe stimmt überein", "verify.dryRunFail": "Fehlgeschlagen - Scratch-Ausgabe weicht ab",
      "verify.expIn": "Erwartete Eingangsprüfsumme", "verify.expOut": "Erwartete Ausgangsprüfsumme", "verify.ckHint": "CRC32, MD5 oder SHA-1",
      "info.aria": "Mehr Infos",
      "info.romInput": "Archive werden entpackt und das ROM automatisch gefunden; chd/rvz/z3ds-Container werden vor dem Patchen ausgepackt; verschachtelte Archive rekursiv aufgelöst. RetroArch-Softpatch-Namen werden unterstützt.",
      "info.patches": "Patches werden von oben nach unten angewendet - zum Umsortieren am Griff ziehen. Dateinamen-Hinweise (crc32 / Größe) werden vor dem Lauf geprüft.",
      "info.output": "Dateiname ohne Endung - das Format-Select steuert sie. Container (zip, 7z, chd, rvz) werden direkt geschrieben.",
      "info.outputOptions": "Codec- und Stufen-Defaults kommen aus Einstellungen › Kompression; Änderungen hier gelten nur für diesen Job.",
      "info.compressType": "Verpackt die Ausgabe optional in einen komprimierten Container - „none“ schreibt die Datei direkt.",
      "info.level": "Profil → Stufe: Min 0/−7 · Mittel 5/11 · Max 9/22 (Standard / zstd). Ein codec:stufe-Eintrag überschreibt dies.",
      "info.threads": "„auto“ nutzt die vom Browser gemeldete Kernanzahl: {n}.",
      "info.units": "MB zählt dezimal (10⁶ Bytes), MiB binär (2²⁰ Bytes). Alle Größen folgen dieser Wahl.",
      "info.fixHeader": "Berechnet Header-Prüfsummen nach dem Patchen neu, damit saubere Dumps wieder verifizieren.",
      "info.verification": "Blockiert den Lauf, wenn Ein- oder Ausgabe-Hashes nicht zu den Patch-Anforderungen passen.",
      "info.zipCodec": "Gültig: deflate, zstd, store. zstd schreibt ZIP-kompatible Ausgabe; store ignoriert die Stufe.",
      "info.sevenZipCodec": "7z-Ausgabe nutzt derzeit LZMA2.",
      "info.rvzCodec": "Standard zstd. Optionale Stufe: zstd:-7 bis zstd:22.",
      "info.chdCd": "Gültig: cdlz, cdzl, cdfl. Einträge ohne Stufe nutzen das Stufen-Profil.",
      "info.chdDvd": "Gültig: lzma, zlib, huff, flac. huff hat keine Stufe.",
      "info.rvzBlock": "Standard 128 KiB. Größere Blöcke komprimieren besser, suchen aber langsamer.",
      "info.window": "Diff-Fenster beim Erstellen - größer findet verschobene Daten, braucht mehr Speicher.",
      "info.trimPad": "Erwartetes Byte im Schwanz; auto erkennt 0x00 oder 0xFF.",
      "info.trimRom": "Tail-Trim: nds, dsi, srl (0x00-Padding) und gba, 3ds (0xFF) - der Füllbereich am Ende wird erkannt und entfernt; Xbox-xiso-Images (.xiso oder .iso) trimmen ihren ungenutzten Schwanz; GameCube/Wii-Images (iso, gcm, wbfs, rvz) trimmen durch Entfernen von Junk-Blöcken bei der RVZ-Konvertierung; die Originaldatei bleibt unberührt, eine ungetrimmte Kopie wird zum Wiederherstellen aufbewahrt.",
      "info.createOriginal": "Der saubere, unveränderte Dump, den Spieler bereits besitzen; seine Prüfsumme wird als Anwendungsvoraussetzung in den Patch eingebettet; Archive und Container werden automatisch aufgelöst.",
      "info.createModified": "Dein bearbeiteter Build - die Datei, die der Patch erzeugen soll; nur die Unterschiede zum Original werden kodiert; die Größe darf vom Original abweichen (Wachstum wird unterstützt).",
      "drop.hero": "ROM oder Patches ablegen", "drop.heroCreate": "Original- und modifiziertes ROM ablegen",
      "drop.heroTrim": "ROM zum Trimmen ablegen", "drop.add": "ROM ersetzen oder Patches hinzufügen",
      "drop.addCreate": "ROM hinzufügen oder ersetzen", "drop.addTrim": "ROM ersetzen",
      "drop.original": "Original-ROM ablegen", "drop.modified": "Modifiziertes ROM ablegen", "drop.addPatches": "Patch-Dateien ablegen",
      "drop.hint": "klicken oder Dateien irgendwo auf der Seite ablegen - Archive, Container, Cue-Sheets und Softpatches werden automatisch aufgelöst", "drop.tapAnywhere": "Irgendwo tippen, um Dateien zu wählen",
      "drop.staging": "Abgelegte Dateien werden gelesen…",
      "drop.anywhereShort": "klicken zum Durchsuchen - oder Dateien irgendwo auf der Seite ablegen", "drop.tap": "Tippen, um Dateien zu wählen", "drop.release": "Loslassen, um Dateien einzulegen",
      "step.rom": "ROM", "step.patches": "Patches", "step.apply": "Anwenden",
      "step.original": "Original", "step.modified": "Modifiziert", "step.patch": "Patch", "step.output": "Ausgabe",
      "empty.needsInput": "Dateien in {loc} oben hinzufügen, um zu starten", "empty.needsInputNoun": "{noun} in {loc} oben hinzufügen",
      "step.inputs": "Eingaben", "needs.rom": "ein ROM", "needs.patches": "Patches", "needs.original": "das Original-ROM", "needs.modified": "das modifizierte ROM", "needs.source": "ein ROM",
      "roms.files.one": "{n} Datei", "roms.files.other": "{n} Dateien", "roms.tracks.one": "{n} Track", "roms.tracks.other": "{n} Tracks", "roms.track": "Track {n}", "roms.extracting": "Entpacke {name}…", "patch.parsing": "Analysiere {name}…",
      "patch.target": "Ziel", "patch.format": "Format", "track.word": "Track",
      "patch.toggle": "{name} einschließen", "patch.on": "An", "patch.stateOff": "Aus",
      "patch.offCount.one": "{n} Patch ist aus - ankreuzen zum Einschließen", "patch.offCount.other": "{n} Patches sind aus - ankreuzen zum Einschließen",
      "patch.off.one": "{n} deaktiviert", "patch.off.other": "{n} deaktiviert",
      "patch.undo": "Undo-fähiges Wiederanwenden (prüft gepatchte Blöcke erneut)",
      "patch.embed": "Quell-crc32 in den Ausgabedateinamen einbetten",
      "verdict.mismatch": "Abweichung",
      "footer.donate": "Spenden",
      "warn.ipsNoChecksum": "IPS enthält keine eingebetteten Prüfsummen - nur durch den Dateinamen-Hinweis abgesichert.",
      "cks.label": "Prüfungen", "cue.label": "Cue", "gdi.label": "GDI",
      "variant.asDumped": "Datei - wie gedumpt", "variant.withHeader": "Datei - wie gedumpt (mit 512-B-Header)",
      "variant.noHeader": "Ohne Copier-Header", "variant.autoTrimmed": "Automatisch getrimmt",
      "req.targetBlockcheck": "Ziel-Blockcheck", "req.undoData": "Undo-Daten", "req.present": "vorhanden",
      "req.patchedCrc32": "gepatchter crc32", "req.rebuiltCue": "neu erzeugtes Cue", "req.rebuiltGdi": "neu erzeugtes GDI",
      "req.embeddedSizes": "eingebettete Größen", "req.sizesInOut": "ein {in} → aus {out}",
      "picker.hint": "Das Archiv enthält mehrere Kandidaten - wähle die einzulegenden Dateien.",
      "picker.use": "Auswahl verwenden", "picker.skipped": "übersprungen",
      "opts.title": "Optionen", "opts.rom": "Optionen", "opts.patch": "Optionen", "opts.window": "Diff-Fenster", "opts.trimPad": "Füllbyte", "opts.trimVerify": "Ausgabe nach dem Trimmen verifizieren",
      "opt.rebuildCue": "Cue-Sheet für die gepatchte Ausgabe neu erzeugen", "opt.rebuildCueShort": "Cue neu",
      "opt.rebuildGdi": ".gdi-Index für die gepatchte Ausgabe neu erzeugen", "opt.rebuildGdiShort": "GDI neu",
      "opt.fixHeader": "ROM-Header vor dem Diff korrigieren (512-B-Copier-Header)", "opt.fixHeaderShort": "Header-Fix",
      "opt.autoTrim": "Vor dem Hashing auto-trimmen (→ {size})", "opt.autoTrimShort": "Auto-Trim",
      "opt.sizeGrowth": "Größenwachstum erlauben (Truncation-Record)", "opt.sizeGrowthShort": "Wachstum",
      "opt.sourceWindow": "Quellfenster", "opt.sourceWindowShort": "Fenster",
      "out.placeholder": "Ausgabedateiname (ohne Endung)",
      "run.apply.one": "{n} Patch verweben", "run.apply.other": "{n} Patches verweben", "run.applyEmpty": "Patches verweben", "run.create": "Patch erstellen", "run.trim": "ROM trimmen",
      "running.cancel": "Job abbrechen", "drop.cancelStage": "Lesen abbrechen", "patch.reorder": "Zum Umsortieren ziehen - Pfeiltasten verschieben",
      "stage.detect": "Erkennen", "stage.extract": "Entpacken", "stage.checksum": "Prüfsumme", "stage.apply": "Anwenden",
      "stage.compress": "Komprimieren", "stage.write": "Schreiben", "stage.verify": "Verifizieren",
      "stage.diff": "Vergleichen", "stage.encode": "Kodieren", "stage.scan": "Scannen", "stage.trim": "Trimmen",
      "progress.threads": "{n} Threads",
      "result.done": "Gepatcht & verifiziert", "result.created": "Patch erstellt & verifiziert", "result.trimmed": "Getrimmt & verifiziert",
      "result.patchType": "{t}-Patch", "result.archive": "{t}-Archiv", "result.raw": "{t} roh",
      "result.records": "{n} Delta-Einträge",
      "result.download": "Herunterladen",
      "fault.remedyK": "Abhilfe", "fault.copy": "Bericht kopieren",
      "fault.apply.title": "Patch-Ziel stimmt nicht überein",
      "fault.apply.body": "„SOTN - Randomizer (v1.8).ppf“ wurde für Rev 1 erstellt - erwartet Track-1-CRC32 0xE2B40FA2, aber Track 1 dieses Dumps ergibt 0xACBC1C34 (Rev 0). Der Patch wurde nicht angewendet.",
      "fault.apply.remedy": "Einen Rev-1-Dump verwenden - oder das Überschreiben aktivieren (Undo-Daten erlauben Rollback).",
      "fault.apply.override": "Trotzdem anwenden - Ziel-Prüfsummen-Gate überspringen (Ausgabe kann defekt sein)",
      "fault.applySingle.title": "Patch-Ziel stimmt nicht überein",
      "fault.applySingle.body": "„Mother 3 Fan Translation v1.3.ips“ erwartet Quell-CRC32 0xA6CAA62E, aber „Mother 3 (Japan).gba“ ergibt 0x2A2074B6. Der Patch wurde nicht angewendet.",
      "fault.applySingle.remedy": "Einen sauberen Dump ohne Header verwenden - oder unten das Überschreiben aktivieren.",
      "fault.applySingle.override": "Trotzdem anwenden - Quell-Prüfsummen-Gate überspringen (Ausgabe kann defekt sein)",
      "input.disc": "Multi-Track-Disc", "input.gdi": "GD-ROM-Disc", "input.single": "Einzeldatei",
      "notice.disc": "<b>Die Patch-Reihenfolge zählt</b> - der Randomizer überschreibt Track-1-Blöcke vor dem xdelta der Neuübersetzung.",
      "notice.gdi": "<b>Die Patch-Reihenfolge zählt</b> - die Framerate-Wiederherstellung überschreibt Track-3-Blöcke vor dem Widescreen-xdelta.",
      "notice.single": "<b>RetroArch-Softpatch</b> - „Mother 3 Fan Translation v1.3.ips“ findet sein ROM über den Namen; beim Stapeln zählt die Reihenfolge.",
      "create.identical": "Identisch mit dem Original - gleicher SHA-1",
      "fault.create.title": "Patch-Erstellung fehlgeschlagen",
      "fault.create.body": "„Chrono Trigger (USA).sfc“ und „Chrono Trigger - Flames of Eternity (v2.5).sfc“ sind byte-identisch (SHA-1 gleich) - es gibt nichts zu vergleichen.",
      "fault.create.remedy": "Den unveränderten Dump als Original und den modifizierten Build als Modifiziert einlegen.",
      "fault.trim.title": "Nichts zu trimmen",
      "fault.trim.body": "Kein Padding am Ende gefunden - „Pokemon HeartGold (USA).nds“ hat keinen 0x00/0xFF-Schwanz. Das ROM ist bereits minimal groß.",
      "fault.trim.remedy": "Dieser Dump ist bereits getrimmt; erneutes Trimmen würde die Datei nur neu schreiben.",
      "status.idle": "inaktiv", "status.staging": "lädt", "status.ready": "bereit",
      "status.running": "läuft", "status.failed": "fehlgeschlagen", "status.done": "fertig",
      "status.faultMsg": "{code} in Phase {stage}",
      "status.doneMsg": "rom-weaver fertig in {t}",
      "trim.detected": "Padding am Ende erkannt", "trim.savings": "{from} → {to} ({p} kleiner)",
      "create.swap": "Tauschen",
      "env.threads": "Threads",
      "scenario.empty": "Leer", "scenario.dragging": "Ziehen", "scenario.staging": "Laden",
      "scenario.ready": "Bereit", "scenario.running": "Läuft", "scenario.fault": "Fehler", "scenario.complete": "Fertig",
      "announce.scenario": "Szenario: {name}", "announce.copied": "In die Zwischenablage kopiert", "announce.reordered": "Patch an Position {n} verschoben",
    },
  };

  const state = {
    locale: localStorage.getItem("rw-locale") || "en",
    units: "MB",
    mode: "apply",
    input: "disc",
    scenario: "ready",
    logLevel: "trace",
    logFilter: "",
    patchToggles: new Set(),
    updateBanner: false,
    wakeLock: false,
    extraPatches: [],
    patchOrder: { disc: null, gdi: null, single: null },
    runTimer: null,
    runStart: 0,
    stagingTimer: null,
    stagingFrom: null,
    createSwapped: false,
  };

  const t = (key, vars) => {
    const catalog = CATALOGS[state.locale] || CATALOGS.en;
    let msg = catalog[key] ?? CATALOGS.en[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) msg = msg.replaceAll(`{${k}}`, String(v));
    return msg;
  };

  const CORES = navigator.hardwareConcurrency || 8;
  const PROFILES = ["min", "veryLow", "low", "medium", "high", "veryHigh", "max"];
  const PLURAL_RULES = {};
  const tCount = (key, n) => {
    PLURAL_RULES[state.locale] = PLURAL_RULES[state.locale] || new Intl.PluralRules(state.locale);
    return t(`${key}.${PLURAL_RULES[state.locale].select(n)}`, { n });
  };
  const fmtNum = (value, digits = 2) =>
    new Intl.NumberFormat(state.locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value);
  /* sizes honour the units setting: MB (decimal, default) or MiB (binary) */
  const fmtSize = (bytes) => {
    const binary = state.units === "MiB";
    const k = binary ? 1024 : 1e3;
    const units = binary ? ["B", "KiB", "MiB", "GiB", "TiB"] : ["B", "kB", "MB", "GB", "TB"];
    let i = 0;
    while (bytes >= k && i < units.length - 1) { bytes /= k; i += 1; }
    return `${fmtNum(bytes, i <= 1 ? 0 : 1)} ${units[i]}`;
  };
  /* reformat a literal size string ("631.1 MiB", "1.18 GiB") to honour the setting */
  const SIZE_UNITS = { B: 1, KB: 1e3, kB: 1e3, KiB: 1024, MB: 1e6, MiB: 1048576, GB: 1e9, GiB: 1073741824 };
  const fmtSizeStr = (s) => {
    const m = /^([\d,.]+)\s*(KiB|MiB|GiB|TiB|kB|KB|MB|GB|TB|B)$/.exec(String(s).trim());
    if (!m) return s;
    return fmtSize(parseFloat(m[1].replace(/,/g, "")) * (SIZE_UNITS[m[2]] ?? 1));
  };
  /* reformat a literal timing ("0.08s") - sub-second reads as ms; the decimal
     separator follows the locale (fmtNum) like every other number */
  const fmtTime = (s) => {
    const m = /^([\d.]+)\s*s$/.exec(String(s).trim());
    if (!m) return s;
    const sec = parseFloat(m[1]);
    return sec > 0 && sec < 1 ? `${Math.round(sec * 1000)}ms` : `${fmtNum(sec, 2)}s`;
  };
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const announce = (msg) => { $("#announcer").textContent = msg; };
  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ════════ demo data ════════ */
  /* Apply works on ONE rom at a time - here a multi-track CD image. */
  const DISC_ROM = {
    name: "Castlevania - Symphony of the Night (USA).cue", tag: "PSX · CD",
    size: "631.1 MiB", time: "3.46s", parts: 2,
    game: "Castlevania - Symphony of the Night (USA)",
    showExtract: true,
    chain: [
      { d: 0, fn: "Castlevania Collection.rar", sz: "498.2 MiB", t: "-" },
      { d: 1, fn: "Castlevania - Symphony of the Night (USA).7z", sz: "412.0 MiB", t: "1.84s" },
      { d: 2, fn: "Castlevania - Symphony of the Night (USA).cue", sz: "1.2 KiB", t: "0.02s" },
      { d: 2, fn: "Castlevania - Symphony of the Night (USA) (Track 1).bin", sz: "593.0 MiB", t: "2.41s" },
      { d: 2, fn: "Castlevania - Symphony of the Night (USA) (Track 2).bin", sz: "38.1 MiB", t: "0.29s" },
    ],
    ckTime: "1.62s",
    id: "SLUS-00067 · NTSC-U · Rev 0", region: "USA",
    options: [{ checked: true, labelKey: "opt.rebuildCue", shortKey: "opt.rebuildCueShort" }],
    tracks: [
      {
        cks: [
          { k: "CRC32", v: "ACBC1C34" },
          { k: "MD5", v: "53FE5E041B7FF7AC791D1AF55C3556D9" },
          { k: "SHA-1", v: "2426AC1D2C24B1C5DA1A1B23E2C0EF66F90E1F36" },
          { copy: "621805568", k: "BYTES", v: "621,805,568" },
        ],
        n: "01", size: "593.0 MiB", start: "00:00:00", type: "MODE2/2352",
      },
      {
        cks: [
          { k: "CRC32", v: "9B0D7F12" },
          { k: "MD5", v: "C2A6F004E20F8B3D9A11FFAD3C8B2E97" },
          { k: "SHA-1", v: "7A40E1D9B7E58F02A6C13D9420B17E83AD55C0F2" },
          { copy: "39952384", k: "BYTES", v: "39,952,384" },
        ],
        n: "02", size: "38.1 MiB", start: "00:02:00", type: "AUDIO",
      },
    ],
    extractTime: "4.56s",
    tasks: [
      { detail: "Castlevania Collection.rar → rar, nested 7z inside", label: "Detected archive", t: "0.04s" },
      { detail: "rar → 7z → cue + 2 bin tracks · 631.1 MiB total", label: "Extracted 4 files", t: "4.56s" },
      { detail: "2 tracks - MODE2/2352 data + audio", label: "Parsed cue sheet", t: "0.02s" },
      { detail: "crc32 + md5 + sha1 single pass @ 412 MiB/s", label: "Hashed 2 tracks", t: "1.62s" },
      { detail: "Track 1 crc32 matches both patches’ requirements", label: "Checked against patches", t: "0.01s" },
    ],
    cue: `FILE "Castlevania - Symphony of the Night (USA) (Track 1).bin" BINARY
  TRACK 01 MODE2/2352
    INDEX 01 00:00:00
FILE "Castlevania - Symphony of the Night (USA) (Track 2).bin" BINARY
  TRACK 02 AUDIO
    INDEX 00 00:00:00
    INDEX 01 00:02:00`,
  };
  const CREATE_ORIGINAL_ROM = {
    name: "Chrono Trigger (USA).sfc", tag: "SFC", size: "4.0 MiB", time: "0.84s",
    game: "Chrono Trigger (USA)",
    chain: [
      { d: 0, fn: "Chrono Trigger (USA).7z", sz: "2.4 MiB", t: "-" },
      { d: 1, fn: "Chrono Trigger (USA).sfc", sz: "4.0 MiB", t: "0.31s" },
    ],
    cks: [
      { k: "CRC32", v: "2D206BF7" },
      { k: "MD5", v: "A2BC447961E52FD2227BAED164F729DC" },
      { k: "SHA-1", v: "DE5822F4F2F7A55ACB8926D4C0EAA63D5D989312" },
          { copy: "4194304", k: "BYTES", v: "4,194,304" },
    ],
    ckVariants: [
      {
        cks: [
          { k: "CRC32", v: "8C124B0D" },
          { k: "MD5", v: "F0A1593C2BD4E87601AC55D9E2330F18" },
          { k: "SHA-1", v: "0B7E2D94C1A6F8E3551D0C2B9A48E761F3D20C55" },
          { copy: "4194816", k: "BYTES", v: "4,194,816" },
        ],
        headKey: "variant.withHeader", size: "4.0 MiB",
      },
      {
        cks: [
          { k: "CRC32", v: "2D206BF7" },
          { k: "MD5", v: "A2BC447961E52FD2227BAED164F729DC" },
          { k: "SHA-1", v: "DE5822F4F2F7A55ACB8926D4C0EAA63D5D989312" },
          { copy: "4194304", k: "BYTES", v: "4,194,304" },
        ],
        headKey: "variant.noHeader", size: "4.0 MiB",
      },
    ],
    ckTime: "0.41s",
    id: "SNS-ACTR-USA · Rev 0",
    options: [{ checked: true, labelKey: "opt.fixHeader", shortKey: "opt.fixHeaderShort" }],
    extractTime: "0.31s",
    tasks: [
      { detail: "Chrono Trigger (USA).7z → archive/7z", label: "Detected archive", t: "0.03s" },
      { detail: "Chrono Trigger (USA).sfc · 4.0 MiB", label: "Extracted 1 file", t: "0.31s" },
      { detail: "512 B copier header removed before hashing", label: "Fixed header", t: "0.01s" },
      { detail: "crc32 + md5 + sha1 single pass", label: "Hashed file", t: "0.41s" },
    ],
  };
  const CREATE_MODIFIED_ROM = {
    name: "Chrono Trigger - Flames of Eternity (v2.5).sfc", tag: "SFC", size: "6.0 MiB", time: "0.59s",
    game: "Modified build",
    chain: [{ d: 0, fn: "Chrono Trigger - Flames of Eternity (v2.5).sfc", sz: "6.0 MiB", t: "0.12s" }],
    cks: [
      { k: "CRC32", v: "5B3FE2A1" },
      { k: "MD5", v: "0F2E9C1A77B44D0190ABCDE1234567FF" },
      { k: "SHA-1", v: "91C2AF0E7D54B3A2C8E1F60D9B374A5C6E80F12D" },
          { copy: "6291456", k: "BYTES", v: "6,291,456" },
    ],
    ckTime: "0.55s",
    tasks: [
      { detail: "rom/sfc - no container", label: "Detected file", t: "0.01s" },
      { detail: "crc32 + md5 + sha1 single pass", label: "Hashed file", t: "0.55s" },
      { detail: "differs from original - 4.0 → 6.0 MiB", label: "Compared with original", t: "0.01s" },
    ],
  };
  const TRIM_ROM = {
    name: "Pokemon HeartGold (USA).nds", tag: "NDS", size: "128.0 MiB", time: "2.31s",
    game: "Pokémon HeartGold Version (USA)",
    chain: [{ d: 0, fn: "Pokemon HeartGold (USA).nds", sz: "128.0 MiB", t: "-" }],
    cks: [
      { k: "CRC32", v: "4DFFB475" },
      { k: "MD5", v: "258E67FE0B6FF67A6A2DCA29E5C7CFF2" },
      { k: "SHA-1", v: "1F1F1C5C4DB2A1E5B79BB2D2E1F8A0B3C4D5E6F7" },
          { copy: "134217728", k: "BYTES", v: "134,217,728" },
    ],
    ckVariants: [
      {
        cks: [
          { k: "CRC32", v: "4DFFB475" },
          { k: "MD5", v: "258E67FE0B6FF67A6A2DCA29E5C7CFF2" },
          { k: "SHA-1", v: "1F1F1C5C4DB2A1E5B79BB2D2E1F8A0B3C4D5E6F7" },
          { copy: "134217728", k: "BYTES", v: "134,217,728" },
        ],
        headKey: "variant.asDumped", size: "128.0 MiB",
      },
      {
        cks: [
          { k: "CRC32", v: "E5A0931C" },
          { k: "MD5", v: "9C44B12E07D8FA3361E5C00A2B87D1F6" },
          { k: "SHA-1", v: "3D81C5F2A99E04B6271FD08C5E4A1B30962D7CE4" },
          { copy: "44040192", k: "BYTES", v: "44,040,192" },
        ],
        headKey: "variant.autoTrimmed", size: "42.0 MiB",
      },
    ],
    ckTime: "2.18s",
    id: "IPKE · NTSC-U", region: "USA",
    tasks: [
      { detail: "rom/nds - no container", label: "Detected file", t: "0.01s" },
      { detail: "crc32 + md5 + sha1 single pass", label: "Hashed file", t: "2.18s" },
      { detail: "0xFF run 86.0 MiB @ 0x02A00000", label: "Scanned tail", t: "0.66s" },
      { detail: "trimmable - 67.2% smaller, checksum recorded for verify", label: "Confirmed candidate", t: "0.01s" },
    ],
  };
  /* multi-part inputs: every patch must name the binary part it rewrites
     (the cue sheet is a text descriptor, never a patch target) */
  const DISC_PATCHES = [
    {
      name: "SOTN - Randomizer (v1.8).ppf", fmt: "PPF", size: "1.3 MiB",
      target: "Castlevania - Symphony of the Night (USA) (Track 1).bin",
      desc: "Item & enemy randomizer with logic-aware seeding; writes undo data for clean re-rolls.",
      verify: {
        input: [{ kKey: "req.targetBlockcheck", v: "@0x9320" }, { kKey: "req.undoData", vKey: "req.present" }],
        output: [{ kKey: "req.patchedCrc32", v: "1B8E04F2" }, { kKey: "req.rebuiltCue", vKey: "roms.tracks.other", vars: { n: 2 } }],
        dryRun: true,
      }, verifyTime: "0.08s",
      extra: [{ k: "File ID", v: "PPF3.0 · imagetype BIN" }],
      tasks: [
        { detail: "ppf v3.0 · imagetype BIN", label: "Detected patch", t: "0.01s" },
        { detail: "1,204 blocks + undo data", label: "Parsed blocks", t: "0.06s" },
        { detail: "Track 1 blockcheck @0x9320", label: "Matched target", t: "0.01s" },
      ],
      undoAware: true,
    },
    {
      name: "SOTN - Retranslation (v2.0).xdelta", fmt: "XDELTA", size: "2.6 MiB",
      target: "Castlevania - Symphony of the Night (USA) (Track 1).bin",
      verify: {
        input: [{ k: "sha1", v: "2426AC1D2C24B1C5DA1A1B23E2C0EF66F90E1F36" }],
        output: [{ k: "sha1", v: "B7E91204C8A3F0512D9E6B47A0C1F38E9D5CE40A" }],
        dryRun: true,
      }, verifyTime: "0.04s",
      options: [{ labelKey: "opt.sourceWindow", options: ["auto (64 MiB)", "32 MiB", "128 MiB"], shortKey: "opt.sourceWindowShort", type: "select" }],
      tasks: [
        { detail: "xdelta3 · VCDIFF window list", label: "Detected patch", t: "0.01s" },
        { detail: "app data: -9 -S djw -B 64MiB", label: "Parsed header", t: "0.02s" },
        { detail: "sha1 2426AC1D… = Track 1", label: "Matched source", t: "0.01s" },
      ],
    },
    /* optional extras shared by the patch author, staged but turned OFF - the
       user ticks them to include them in the weave */
    {
      name: "SOTN - Map Rando Add-on (v0.9).ppf", fmt: "PPF", size: "0.4 MiB", disabled: true,
      target: "Castlevania - Symphony of the Night (USA) (Track 1).bin",
      desc: "Optional companion to the randomizer; shuffles map room connections.",
    },
    {
      name: "SOTN - Alt Soundtrack (v1.1).xdelta", fmt: "XDELTA", size: "31.0 MiB", disabled: true,
      target: "Castlevania - Symphony of the Night (USA) (Track 2).bin",
      desc: "Replaces the Track 2 audio with the arranged OST.",
    },
  ];
  /* single-part input: no ambiguity, so patches carry no Target row */
  const SINGLE_ROM = {
    name: "Mother 3 (Japan).gba", tag: "GBA", size: "32.0 MiB", time: "1.46s",
    game: "Mother 3 (Japan)",
    id: "AGB-A3UJ-JPN", region: "Japan",
    options: [{ checked: false, labelKey: "opt.autoTrim", labelVars: { size: "12.4 MiB" }, shortKey: "opt.autoTrimShort" }],
    chain: [
      { d: 0, fn: "m3-fanpack.rar", sz: "84.3 MiB", t: "-" },
      { d: 1, fn: "patches+roms.7z", sz: "44.6 MiB", t: "0.41s" },
      { d: 2, fn: "mother3.zip", sz: "12.1 MiB", t: "0.22s" },
      { d: 3, fn: "Mother 3 (Japan).gba", sz: "32.0 MiB", t: "0.66s" },
    ],
    cks: [
      { k: "CRC32", v: "A6CAA62E" },
      { k: "MD5", v: "57AC7DC7BD781CABE48F40DAB458AB8C" },
      { k: "SHA-1", v: "2C397F60F25F0B636B5BBEBA1812E5B107D54FBA" },
          { copy: "33554432", k: "BYTES", v: "33,554,432" },
    ],
    ckVariants: [
      {
        cks: [
          { k: "CRC32", v: "A6CAA62E" },
          { k: "MD5", v: "57AC7DC7BD781CABE48F40DAB458AB8C" },
          { k: "SHA-1", v: "2C397F60F25F0B636B5BBEBA1812E5B107D54FBA" },
          { copy: "33554432", k: "BYTES", v: "33,554,432" },
        ],
        headKey: "variant.asDumped", size: "32.0 MiB",
      },
      {
        cks: [
          { k: "CRC32", v: "7C440AE1" },
          { k: "MD5", v: "11D9C2330C8E61BAFB23D87B5E20F8A4" },
          { k: "SHA-1", v: "A93F002B6E1C84D27D550FE3B1A09C47128B66E0" },
          { copy: "13002752", k: "BYTES", v: "13,002,752" },
        ],
        headKey: "variant.autoTrimmed", size: "12.4 MiB",
      },
    ],
    ckTime: "1.12s",
    extractTime: "1.29s",
    tasks: [
      { detail: "m3-fanpack.rar → rar, nested 7z → zip inside", label: "Detected archive", t: "0.02s" },
      { detail: "rar → 7z → zip → Mother 3 (Japan).gba · 32.0 MiB", label: "Extracted 3 layers", t: "1.29s" },
      { detail: "crc32 + md5 + sha1 single pass", label: "Hashed file", t: "1.12s" },
      { detail: "crc32 A6CAA62E matches the translation’s gate", label: "Checked against patches", t: "0.01s" },
    ],
  };
  const SINGLE_PATCHES = [
    {
      name: "Mother 3 Fan Translation v1.3.ips", fmt: "IPS", size: "412 KiB",
      /* ips has no embedded checksum data - the only gate is the filename hint,
         so the card carries the YELLOW weak-verification border */
      warnKey: "warn.ipsNoChecksum",
      options: [{ checked: true, labelKey: "opt.sizeGrowth", shortKey: "opt.sizeGrowthShort" }],
      tasks: [
        { detail: "ips · PATCH magic", label: "Detected patch", t: "0.01s" },
        { detail: "24,310 records · 412 KiB", label: "Parsed records", t: "0.05s" },
        { detail: "name-hint crc32 A6CAA62E matched", label: "Passed gate", t: "0.01s" },
      ],
    },
    {
      name: "Mother 3 - EXP Scaling (v1.2).ups", fmt: "UPS", size: "96 KiB",
      desc: "Optional difficulty tweak; stacks after the translation.",
      verify: {
        input: [{ kKey: "req.embeddedSizes", vKey: "req.sizesInOut", vars: { in: "12.1 MiB", out: "32.0 MiB" } }],
        output: [{ k: "crc32", v: "7C440AE1" }],
        dryRun: true,
      }, verifyTime: "0.03s",
      tasks: [
        { detail: "ups · UPS1 magic", label: "Detected patch", t: "0.01s" },
        { detail: "in 32.0 MiB → out 32.0 MiB", label: "Parsed sizes", t: "0.01s" },
        { detail: "post-translation size check", label: "Passed gate", t: "0.01s" },
      ],
    },
  ];

  /* a Dreamcast GD-ROM: low-density data + audio tracks then the high-density
     data track, indexed by a .gdi file (the Dreamcast analogue of a .cue) */
  const GDI_ROM = {
    name: "Sonic Adventure (USA).gdi", tag: "DC · GD-ROM",
    size: "1.19 GiB", time: "5.1s", parts: 3,
    game: "Sonic Adventure (USA)",
    chain: [
      { d: 0, fn: "Sonic Adventure (USA).7z", sz: "842.0 MiB", t: "-" },
      { d: 1, fn: "Sonic Adventure (USA).gdi", sz: "0.4 KiB", t: "0.01s" },
      { d: 1, fn: "Sonic Adventure (USA) (Track 1).bin", sz: "1.6 MiB", t: "0.04s" },
      { d: 1, fn: "Sonic Adventure (USA) (Track 2).raw", sz: "3.0 MiB", t: "0.06s" },
      { d: 1, fn: "Sonic Adventure (USA) (Track 3).bin", sz: "1.18 GiB", t: "4.92s" },
    ],
    ckTime: "3.18s",
    id: "MK-51000 · NTSC-U · Rev 1", region: "USA",
    options: [{ checked: true, labelKey: "opt.rebuildGdi", shortKey: "opt.rebuildGdiShort" }],
    tracks: [
      {
        cks: [
          { k: "CRC32", v: "7F2D1A0C" },
          { k: "MD5", v: "B1F4C7E0913A52DDA0786C4419FE2B3A" },
          { k: "SHA-1", v: "0C9A22E5F1B3D470A8C1426E9F70D3B1A2E54C08" },
          { copy: "1686528", k: "BYTES", v: "1,686,528" },
        ],
        n: "01", size: "1.6 MiB", start: "00:00:00", type: "MODE1/2352 · low-density",
      },
      {
        cks: [
          { k: "CRC32", v: "C40E9B71" },
          { k: "MD5", v: "F0A3E5C7124B98DD60E1AC4F73B205E9" },
          { k: "SHA-1", v: "9E4D1B07C2A3F5106D8B47E0C19F23A8D5CE40B7" },
          { copy: "3110400", k: "BYTES", v: "3,110,400" },
        ],
        n: "02", size: "3.0 MiB", start: "00:09:53", type: "AUDIO · low-density",
      },
      {
        cks: [
          { k: "CRC32", v: "A18C53F4" },
          { k: "MD5", v: "2D7BAE419FC0518833E6B47A0C1F38E9" },
          { k: "SHA-1", v: "5C0F2B7E91204C8A3F0512D9E6B47A0C1F38E9D5" },
          { copy: "1267261440", k: "BYTES", v: "1,267,261,440" },
        ],
        n: "03", size: "1.18 GiB", start: "10:00:00", type: "MODE1/2352 · high-density",
      },
    ],
    extractTime: "5.03s",
    tasks: [
      { detail: "Sonic Adventure (USA).7z → 7z archive", label: "Detected archive", t: "0.02s" },
      { detail: "7z → .gdi + 3 tracks · 1.19 GiB total", label: "Extracted 4 files", t: "5.03s" },
      { detail: "3 tracks - 2 low-density + 1 high-density", label: "Parsed .gdi index", t: "0.01s" },
      { detail: "crc32 + md5 + sha1 single pass @ 388 MiB/s", label: "Hashed 3 tracks", t: "3.18s" },
      { detail: "Track 3 sha1 matches both patches’ requirements", label: "Checked against patches", t: "0.02s" },
    ],
    gdi: `3
1 0 4 2352 "Sonic Adventure (USA) (Track 1).bin" 0
2 756 0 2352 "Sonic Adventure (USA) (Track 2).raw" 0
3 45000 4 2352 "Sonic Adventure (USA) (Track 3).bin" 0`,
    cue: `FILE "Sonic Adventure (USA) (Track 1).bin" BINARY
  TRACK 01 MODE1/2352
    INDEX 01 00:00:00
FILE "Sonic Adventure (USA) (Track 2).raw" BINARY
  TRACK 02 AUDIO
    INDEX 01 00:00:00`,
  };
  const GDI_PATCHES = [
    {
      name: "Sonic Adventure - 60 FPS Restoration (v1.3).ppf", fmt: "PPF", size: "0.9 MiB",
      target: "Sonic Adventure (USA) (Track 3).bin",
      desc: "Restores the uncapped framerate cut from the US release; writes undo data.",
      verify: {
        input: [{ kKey: "req.targetBlockcheck", v: "@0x1A4C0" }, { kKey: "req.undoData", vKey: "req.present" }],
        output: [{ kKey: "req.patchedCrc32", v: "3D8F1A92" }, { kKey: "req.rebuiltGdi", vKey: "roms.tracks.other", vars: { n: 3 } }],
        dryRun: true,
      }, verifyTime: "0.07s",
      extra: [{ k: "File ID", v: "PPF3.0 · imagetype BIN" }],
      tasks: [
        { detail: "ppf v3.0 · imagetype BIN", label: "Detected patch", t: "0.01s" },
        { detail: "2,108 blocks + undo data", label: "Parsed blocks", t: "0.05s" },
        { detail: "Track 3 blockcheck @0x1A4C0", label: "Matched target", t: "0.01s" },
      ],
      undoAware: true,
    },
    {
      name: "Sonic Adventure - Widescreen (v2.1).xdelta", fmt: "XDELTA", size: "1.4 MiB",
      target: "Sonic Adventure (USA) (Track 3).bin",
      verify: {
        input: [{ k: "sha1", v: "5C0F2B7E91204C8A3F0512D9E6B47A0C1F38E9D5" }],
        output: [{ k: "sha1", v: "A8D5CE40B79E4D1B07C2A3F5106D8B47E0C19F23" }],
        dryRun: true,
      }, verifyTime: "0.05s",
      options: [{ labelKey: "opt.sourceWindow", options: ["auto (64 MiB)", "32 MiB", "128 MiB"], shortKey: "opt.sourceWindowShort", type: "select" }],
      tasks: [
        { detail: "xdelta3 · VCDIFF window list", label: "Detected patch", t: "0.01s" },
        { detail: "app data: -9 -S djw -B 64MiB", label: "Parsed header", t: "0.02s" },
        { detail: "sha1 5C0F2B7E… = Track 3", label: "Matched source", t: "0.01s" },
      ],
    },
  ];

  const APPLY_INPUTS = {
    disc: {
      rom: DISC_ROM,
      patches: DISC_PATCHES,
      romMeta: () => `<span>${tCount("roms.tracks", 2)}</span><span>·</span><span>631.1 MiB</span><span>·</span><span class="t">3.5s</span>`,
      patchMeta: (extra = 0) => `<span>${tCount("roms.files", 2 + extra)}</span><span>·</span><span>3.9 MiB</span>`,
      notice: () => t("notice.disc"),
      readingName: "Castlevania … (Track 1).bin",
      outName: "Castlevania - Symphony of the Night (USA) (Randomized)",
      outFormats: [".chd", ".cue", ".zip", ".7z"],
      targetOptions: [
        "Castlevania - Symphony of the Night (USA) (Track 1).bin",
        "Castlevania - Symphony of the Night (USA) (Track 2).bin",
      ],
      compressSummary: "chd · cdlz,cdzl,cdfl",
      /* 631 MiB CD: extract from nested archive → bins, hash, apply ppf/xdelta,
         recompress to CHD (cdlz,cdzl,cdfl) - the compress stage dominates */
      plan: [
        { dur: 0.21, id: "detect" }, { dur: 2.44, id: "extract" }, { dur: 1.62, id: "checksum" },
        { dur: 0.38, id: "apply" }, { dur: 3.12, id: "compress" }, { dur: 0.96, id: "write" }, { dur: 0.71, id: "verify" },
      ],
      codecField: (disabled) => comboField(t("settings.chdCd"), "chd-cd-codecs", "cdlz,cdzl,cdfl", ["cdlz", "cdzl", "cdfl", "cdzs"], "info.chdCd", disabled),
      faultKey: "fault.apply",
      faultTrace: [
        ["warn", "apply: ppf target gate crc32 E2B40FA2 vs ACBC1C34"],
        ["error", "PATCH_TARGET_MISMATCH: ppf blockcheck failed on Track 1"],
      ],
      applyTrace: [{ lv: "info", msg: "apply: ppf SOTN Randomizer v1.8 → Track 1.bin" }, { lv: "trace", msg: "apply: 1,204 blocks, undo data captured" }],
      out: { meta: () => `<span aria-hidden="true">▾</span> 35.9%`, name: "Castlevania - Symphony of the Night (USA) (Randomized).chd", size: "404.8 MiB" },
      bytesTotal: 631,
      runFile: (idx) => {
        if (idx === 0) return "Castlevania … (USA).7z";
        if (idx <= 2) return "Castlevania … (Track 1).bin";
        if (idx === 3) return "SOTN - Randomizer (v1.8).ppf";
        return "Castlevania … (Randomized).chd";
      },
      seed: [
        { lv: "info", msg: `runtime: wasm32-wasi threads=${CORES} simd=on` },
        { lv: "debug", msg: "opfs: staging root /work mounted" },
        { lv: "trace", msg: "detect: Castlevania Collection.rar → archive/rar" },
        { lv: "trace", msg: "nested: Castlevania … (USA).7z inside rar" },
        { lv: "trace", msg: "cue: 2 tracks - data 593.0 MiB + audio 38.1 MiB" },
        { lv: "debug", msg: "extract: read-on-main, 2 workers" },
        { lv: "trace", msg: "checksum: crc32+md5+sha1 single-pass engine" },
        { lv: "info", msg: "verify: track checksums match patch requirements" },
      ],
    },
    gdi: {
      rom: GDI_ROM,
      patches: GDI_PATCHES,
      romMeta: () => `<span>${tCount("roms.tracks", 3)}</span><span>·</span><span>1.19 GiB</span><span>·</span><span class="t">5.1s</span>`,
      patchMeta: (extra = 0) => `<span>${tCount("roms.files", 2 + extra)}</span><span>·</span><span>2.3 MiB</span>`,
      notice: () => t("notice.gdi"),
      readingName: "Sonic Adventure … (Track 3).bin",
      outName: "Sonic Adventure (USA) (60fps Widescreen)",
      outFormats: [".chd", ".gdi", ".zip", ".7z"],
      targetOptions: [
        "Sonic Adventure (USA) (Track 1).bin",
        "Sonic Adventure (USA) (Track 2).raw",
        "Sonic Adventure (USA) (Track 3).bin",
      ],
      compressSummary: "chd · cdlz,cdzl,cdfl",
      /* 1.19 GiB GD-ROM: extract from 7z → gdi + 3 tracks, hash, apply ppf/xdelta
         to the high-density track, recompress to CHD - compress dominates */
      plan: [
        { dur: 0.24, id: "detect" }, { dur: 5.03, id: "extract" }, { dur: 3.18, id: "checksum" },
        { dur: 0.52, id: "apply" }, { dur: 6.41, id: "compress" }, { dur: 1.88, id: "write" }, { dur: 1.36, id: "verify" },
      ],
      codecField: (disabled) => comboField(t("settings.chdCd"), "chd-cd-codecs", "cdlz,cdzl,cdfl", ["cdlz", "cdzl", "cdfl", "cdzs"], "info.chdCd", disabled),
      faultKey: "fault.apply",
      faultTrace: [
        ["warn", "apply: ppf target gate crc32 9F22A0E1 vs A18C53F4"],
        ["error", "PATCH_TARGET_MISMATCH: ppf blockcheck failed on Track 3"],
      ],
      applyTrace: [{ lv: "info", msg: "apply: ppf SA 60fps v1.3 → Track 3.bin" }, { lv: "trace", msg: "apply: 2,108 blocks, undo data captured" }],
      out: { meta: () => `<span aria-hidden="true">▾</span> 41.2%`, name: "Sonic Adventure (USA) (60fps Widescreen).chd", size: "718.0 MiB" },
      bytesTotal: 1220,
      runFile: (idx) => {
        if (idx === 0) return "Sonic Adventure … (USA).7z";
        if (idx <= 2) return "Sonic Adventure … (Track 3).bin";
        if (idx === 3) return "SA - 60 FPS Restoration (v1.3).ppf";
        return "Sonic Adventure … (60fps Widescreen).chd";
      },
      seed: [
        { lv: "info", msg: `runtime: wasm32-wasi threads=${CORES} simd=on` },
        { lv: "debug", msg: "opfs: staging root /work mounted" },
        { lv: "trace", msg: "detect: Sonic Adventure (USA).7z → archive/7z" },
        { lv: "trace", msg: "gdi: 3 tracks - 2 low-density + high-density 1.18 GiB" },
        { lv: "debug", msg: "extract: read-on-main, 4 workers" },
        { lv: "trace", msg: "checksum: crc32+md5+sha1 single-pass engine" },
        { lv: "info", msg: "verify: track 3 checksum matches patch requirements" },
      ],
    },
    single: {
      rom: SINGLE_ROM,
      patches: SINGLE_PATCHES,
      romMeta: () => `<span>${tCount("roms.files", 1)}</span><span>·</span><span>32.0 MiB</span><span>·</span><span class="t">1.5s</span>`,
      patchMeta: (extra = 0) => `<span>${tCount("roms.files", 2 + extra)}</span><span>·</span><span>508 KiB</span>`,
      notice: () => t("notice.single"),
      readingName: "m3-fanpack.rar",
      outName: "Mother 3 (English) (v1.3)",
      outFormats: [".gba", ".zip", ".7z"],
      compressSummary: "7z · lzma2",
      /* 32 MiB GBA: light extract from nested rar/7z/zip, hash, apply ips,
         repack to 7z (lzma2) - an order of magnitude faster than the disc */
      plan: [
        { dur: 0.05, id: "detect" }, { dur: 0.34, id: "extract" }, { dur: 0.19, id: "checksum" },
        { dur: 0.14, id: "apply" }, { dur: 1.18, id: "compress" }, { dur: 0.08, id: "write" }, { dur: 0.12, id: "verify" },
      ],
      codecField: (disabled) => comboField(t("settings.sevenZipCodec"), "sevenzip-codec", "lzma2", ["lzma2", "lzma", "ppmd", "bzip2", "deflate"], "info.sevenZipCodec", disabled),
      faultKey: "fault.applySingle",
      faultTrace: [
        ["warn", "apply: source gate crc32 A6CAA62E vs 2A2074B6"],
        ["error", "PATCH_TARGET_MISMATCH: ips source checksum gate failed"],
      ],
      applyTrace: [{ lv: "info", msg: "apply: ips Mother 3 v1.3 → gba" }, { lv: "trace", msg: "apply: 24,310 records" }],
      out: { meta: () => `<span aria-hidden="true">▾</span> 61.3%`, name: "Mother 3 (English) (v1.3).7z", size: "12.4 MiB" },
      bytesTotal: 32,
      runFile: (idx) => {
        if (idx <= 1) return "mother3.zip";
        if (idx === 2) return "Mother 3 (Japan).gba";
        if (idx === 3) return "Mother 3 Fan Translation v1.3.ips";
        return "Mother 3 (English) (v1.3).7z";
      },
      seed: [
        { lv: "info", msg: `runtime: wasm32-wasi threads=${CORES} simd=on` },
        { lv: "debug", msg: "opfs: staging root /work mounted" },
        { lv: "trace", msg: "detect: m3-fanpack.rar → archive/rar" },
        { lv: "trace", msg: "nested: 7z → zip → Mother 3 (Japan).gba (depth 3)" },
        { lv: "debug", msg: "extract: read-on-main, 1 worker" },
        { lv: "trace", msg: "checksum: crc32+md5+sha1 single-pass engine" },
        { lv: "info", msg: "verify: input matches patch requirements" },
      ],
    },
  };
  const applyInput = () => APPLY_INPUTS[state.input];

  /* per-mode job configuration: stage plan, fault, result, run telemetry */
  const MODE_CFG = {
    apply: {
      /* apply's stage plan lives on the staged input (APPLY_INPUTS) since a disc
         and a single ROM do measurably different work; read it via jobIO(mode) */
      faultIdx: 3,
      fault: { code: "PATCH_TARGET_MISMATCH", override: true },
      resultKey: "result.done",
      /* the label counts ENABLED patches (base − toggled-off + extras), matching
         the step-header badge and what the weave will actually apply. With
         nothing staged yet there is no count to claim - use the bare verb. */
      runLabel: () => {
        if (state.scenario === "empty" || state.scenario === "dragging") return t("run.applyEmpty");
        return tCount("run.apply", buildPatchItems(applyInput(), false).filter((it) => !it.disabled).length);
      },
    },
    create: {
      plan: [
        { dur: 0.12, id: "detect" }, { dur: 0.74, id: "extract" }, { dur: 0.98, id: "checksum" },
        { dur: 1.62, id: "diff" }, { dur: 0.85, id: "encode" }, { dur: 0.21, id: "write" },
      ],
      faultIdx: 3,
      fault: { code: "PATCH_CREATE_FAILED", key: "fault.create" },
      faultTrace: [
        ["warn", "diff: original == modified (sha1 match)"],
        ["error", "PATCH_CREATE_FAILED: nothing to diff"],
      ],
      resultKey: "result.created",
      outName: "Flames of Eternity (v2.5)",
      out: { meta: () => t("result.records", { n: fmtNum(48213, 0) }), name: "Flames of Eternity (v2.5).bps", size: "1.1 MiB" },
      bytesTotal: 10,
      runFile: (idx) => (idx <= 2 ? "Chrono Trigger (USA).sfc" : "Flames of Eternity (v2.5).sfc"),
      runLabel: () => t("run.create"),
    },
    trim: {
      plan: [
        { dur: 0.08, id: "detect" }, { dur: 2.18, id: "checksum" }, { dur: 0.66, id: "scan" },
        { dur: 0.35, id: "trim" }, { dur: 1.05, id: "write" }, { dur: 0.91, id: "verify" },
      ],
      faultIdx: 2,
      fault: { code: "INVALID_INPUT", key: "fault.trim" },
      faultTrace: [
        ["warn", "scan: no 0x00/0xFF tail run found"],
        ["error", "INVALID_INPUT: nothing to trim"],
      ],
      resultKey: "result.trimmed",
      outName: "Pokemon HeartGold (USA) (Trimmed)",
      out: { meta: () => `<span aria-hidden="true">▾</span> 67.2%`, name: "Pokemon HeartGold (USA) (Trimmed).nds", size: "42.0 MiB" },
      bytesTotal: 128,
      runFile: () => "Pokemon HeartGold (USA).nds",
      runLabel: () => t("run.trim"),
    },
  };
  /* run-telemetry source: apply depends on the staged input, others are fixed */
  const jobIO = (mode) => (mode === "apply" ? applyInput() : MODE_CFG[mode]);
  const stageTraceFor = (mode, stageId) => {
    if (mode === "apply" && stageId === "apply") return applyInput().applyTrace;
    return TRACE_BY_STAGE[stageId] || [];
  };
  const planTotal = (mode) => jobIO(mode).plan.reduce((acc, s) => acc + s.dur, 0);
  const totalLabel = (mode) => `${fmtNum(planTotal(mode), 1)}s`;
  const fmtDur = (dur) => (dur > 0 && dur < 1 ? `${Math.round(dur * 1000)}ms` : `${fmtNum(dur, 2)}s`);

  const MODE_SEEDS = {
    create: [
      { lv: "info", msg: `runtime: wasm32-wasi threads=${CORES} simd=on` },
      { lv: "debug", msg: "opfs: staging root /work mounted" },
      { lv: "trace", msg: "detect: Chrono Trigger (USA).7z → archive/7z" },
      { lv: "trace", msg: "detect: Flames of Eternity (v2.5).sfc → rom/sfc" },
      { lv: "debug", msg: "extract: read-on-main, 1 worker" },
      { lv: "trace", msg: "checksum: crc32+md5+sha1 single-pass engine" },
      { lv: "trace", msg: "diff: inputs ready - 4.0 vs 6.0 MiB" },
    ],
    trim: [
      { lv: "info", msg: `runtime: wasm32-wasi threads=${CORES} simd=on` },
      { lv: "debug", msg: "opfs: staging root /work mounted" },
      { lv: "trace", msg: "detect: Pokemon HeartGold (USA).nds → rom/nds" },
      { lv: "trace", msg: "checksum: crc32+md5+sha1 single-pass engine" },
      { lv: "debug", msg: "scan: sampling tail in 4 MiB windows" },
      { lv: "trace", msg: "scan: tail 0xFF run 86.0 MiB @ 0x02A00000" },
      { lv: "info", msg: "scan: trim candidate confirmed" },
    ],
  };
  /* per-stage trace lines for create/trim; apply's live on its staged input
     (APPLY_INPUTS[…].applyTrace) and are routed there by stageTraceFor */
  const TRACE_BY_STAGE = {
    checksum: [{ lv: "trace", msg: "checksum: hashed @ 412 MiB/s" }],
    compress: [{ lv: "info", msg: "compress: chd cd (cdlz,cdzl,cdfl), 19,584 hunks" }, { lv: "debug", msg: "compress: sync-header FLAC gate active" }],
    detect: [{ lv: "trace", msg: "detect: inputs classified" }],
    diff: [{ lv: "info", msg: "diff: window scan 64 KiB, 8 lanes" }],
    encode: [{ lv: "trace", msg: "encode: bps delta stream, 48,213 records" }],
    extract: [{ lv: "trace", msg: "extract: read-on-main, 2 workers" }],
    scan: [{ lv: "trace", msg: "scan: tail 0xFF run 86.0 MiB @ 0x02A00000" }],
    trim: [{ lv: "info", msg: "trim: cut 86.0 MiB, new size 42.0 MiB" }],
    verify: [{ lv: "info", msg: "verify: output sha1 ✓ · undo map stored" }],
    write: [{ lv: "trace", msg: "write: OPFS sync handle, 4 MiB chunks" }],
  };
  const CHANGELOG = [
    { tag: "feat", text: "Nested archive patches: pick every patch inside 7z/rar stacks in one pass." },
    { tag: "feat", text: "Patch filename requirements - crc32/size hints parsed and pre-verified." },
    { tag: "perf", text: "CHD create now beats chdman on CD images (streaming hunk pipeline)." },
    { tag: "fix", text: "Safari: staged OPFS inputs reuse identical uploads instead of re-copying." },
    { tag: "fix", text: "Worker threads “auto” resolves to all cores in the browser (was capped at 4)." },
  ];

  const ICONS = {
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4.5 12.5 5 5 10-11"/></svg>',
    chev: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="13" height="13" rx="2"/><path d="M16 16v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h3"/></svg>',
    cross: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    drop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
    fault: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 20h19Z"/><path d="M12 9.5V14m0 3.2v.3"/></svg>',
    grip: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
    swap: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 4.5 20 8.5l-4 4M20 8.5H7M8 19.5l-4-4 4-4M4 15.5h13"/></svg>',
    target: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="M12 1.5v4m0 13v4M1.5 12h4m13 0h4"/></svg>',
    weave: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3 3 9l12 12 6-6Z"/><path d="m9 8.5 2 2m-4 1 2 2m3-7 2 2"/></svg>',
    tune: '<svg class="tune" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h11m4 0h1M4 17h1m4 0h11"/><circle cx="17" cy="7" r="2.4"/><circle cx="7" cy="17" r="2.4"/></svg>',
    up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V5m-5.5 5.5L12 5l5.5 5.5"/></svg>',
    /* canonical per-mode action icons, matching the real webapp (band-aid /
       git-compare / scissors) - shared by the nav tabs and the run buttons */
    bandaid: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="8.364" width="9" height="19" rx="4.5" transform="rotate(-45 2 8.364)"/><path d="m11.9 18.264-.354.353a4.5 4.5 0 0 1-6.364 0 4.5 4.5 0 0 1 0-6.364l.354-.353M11.9 5.536l.353-.354a4.5 4.5 0 0 1 6.364 0 4.5 4.5 0 0 1 0 6.364l-.354.354m-8.484 0h0M11.9 9.778h0M14.021 11.9h0M11.9 14.021h0"/></svg>',
    compare: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/></svg>',
    scissors: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>',
    cpu: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M9 2v2m6-2v2M9 20v2m6-2v2M2 9h2m-2 6h2m16-6h2m-2 6h2"/></svg>',
    pulse: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12h4l2.5-7 4 14 2.5-7h6"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  };
  const MODE_ICONS = { apply: ICONS.bandaid, create: ICONS.compare, trim: ICONS.scissors };

  /* a single option toggle, presented as a weighted row inside the tray */
  const toggleRow = (name, label, checked, disabled = "") =>
    `<label class="popt"><input type="checkbox" role="switch" name="${name}"${checked ? " checked" : ""}${disabled} /> <span>${label}</span></label>`;

  /* ════════ shared renderers ════════ */
  const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

  const renderChain = (chain) =>
    `<div class="tree mono">${chain
      .map((lvl) => `<div class="tree-row d${lvl.d}">${lvl.d > 0 ? '<span class="tree-elbow" aria-hidden="true"></span>' : ""}<span class="tree-name">${esc(lvl.fn)}</span><span class="tree-meta"><span class="tree-size">${fmtSizeStr(lvl.sz)}</span><span class="tree-time">${fmtTime(lvl.t)}</span></span></div>`)
      .join("")}</div>`;

  /* the whole row IS the copy button (role=button + aria-label), so the label
     and value are plain spans and the copy glyph is decorative - no dt/dd (they
     can't live in an interactive non-<dl> element) and no nested <button> */
  const renderCkRow = (c) =>
    `<div class="ck mono" data-copy="${esc(c.copy || c.v)}" role="button" tabindex="0" aria-label="${t("common.copy")} ${c.k} ${esc(c.v)}"><span class="ck-k">${c.k}</span><span class="ck-v">${esc(c.v)}${c.exp ? ` <span class="exp">≠ ${esc(c.exp)}</span>` : ""}</span><span class="copy" aria-hidden="true">${ICONS.copy}</span></div>`;

  /* patch verification rows mirror the checksum rows: a label + value, copyable,
     with a pass/fail match mark on the row. label/value come either as raw data
     (hash names like sha1/crc32) or as catalog keys (kKey/vKey + vars) so the
     English-word entries ("undo data", "present", "rebuilt cue") translate */
  const renderReqRow = (c, bad) => {
    const label = c.kKey ? t(c.kKey) : c.k;
    const value = c.vKey ? t(c.vKey, c.vars) : c.v;
    return `<div class="ck req mono${bad ? " bad" : ""}" data-copy="${esc(value)}" role="button" tabindex="0" aria-label="${t("common.copy")} ${esc(label)} ${esc(value)}"><span class="ck-k">${esc(label)}</span><span class="ck-v">${esc(value)}</span><span class="reqstat${bad ? " bad" : ""}" aria-hidden="true">${bad ? ICONS.cross : ICONS.check}</span><span class="copy" aria-hidden="true">${ICONS.copy}</span></div>`;
  };

  /* the dry-run: apply to a scratch copy and re-hash - reports the actual
     pass/fail verdict, not an in-flight progress bar */
  const renderDryRun = (bad = false) =>
    `<div class="dryrun">
      <span class="dryrun-desc">${t("verify.dryRunDesc")}</span>
      <span class="dryrun-verdict ${bad ? "bad" : "ok"}">${bad ? ICONS.cross : ICONS.check}<span>${t(bad ? "verify.dryRunFail" : "verify.dryRunPass")}</span></span>
    </div>`;

  /* shared collapsible drawer: a real <button aria-expanded> header over a
     grid-rows-collapsed body - open/close is pure CSS (.cks rules); the click
     handler in wireDrawers only flips the class + attribute. Replaces the old
     <details>/<summary> + JS height tween. */
  let drawerUid = 0;
  const renderDrawer = (headInner, bodyInner, { open = false, cls = "" } = {}) => {
    const id = `drawer-${++drawerUid}`;
    return `<div class="cks${cls ? ` ${cls}` : ""}${open ? " is-open" : ""}">
      <button class="cks-head" type="button" aria-expanded="${String(!!open)}" aria-controls="${id}">${ICONS.chev}${headInner}</button>
      <div class="cks-body" id="${id}"><div class="cks-inner">${bodyInner}</div></div>
    </div>`;
  };

  /* verifications fold into input / output / dry-run sub-sections, in the same
     grouped language as the track checksum groups */
  const renderVerifyDrawer = (p, opts) => {
    const v = p.verify;
    if (!v) return "";
    const rows = (list, badFirst) => `<div class="ckrows">${list.map((c, i) => renderReqRow(c, badFirst && i === 0)).join("")}</div>`;
    const group = (head, inner) =>
      `<div class="ckgrp"><div class="ck-group-head"><span>${head}</span></div>${inner}</div>`;
    const groups = [];
    if (v.input?.length) groups.push(group(t("verify.input"), rows(v.input, opts.bad)));
    if (v.output?.length) groups.push(group(t("verify.output"), rows(v.output, false)));
    if (v.dryRun) groups.push(group(t("verify.dryRun"), renderDryRun(opts.bad)));
    return renderDrawer(
      `<span class="lab">${t("drawer.verifications")}</span><span class="readouts">${p.verifyTime ? `<span class="rb time mono">${fmtTime(p.verifyTime)}</span>` : ""}<span class="rb-mark ${opts.bad ? "bad" : "ok"}">${opts.bad ? ICONS.cross : ICONS.check}</span></span>`,
      `<div class="trackrows">${groups.join("")}</div>`,
      { open: !!opts.bad },
    );
  };

  const renderChecksums = (rom, open, verdict = "") => {
    /* single-file formats often have checksum variants (headerless, auto-trimmed…) */
    const rows = rom.ckVariants
      ? rom.ckVariants
          .map((g) => `<div class="ckgrp">
              <div class="ck-group-head"><span>${t(g.headKey)} · ${fmtSizeStr(g.size)}</span></div>
              <div class="ckrows">${g.cks.map(renderCkRow).join("")}</div>
            </div>`)
          .join("")
      : rom.cks.map(renderCkRow).join("");
    return renderDrawer(
      `<span class="lab">${t("cks.label")}</span>${rom.ckTime ? `<span class="readouts"><span class="rb time mono">${fmtTime(rom.ckTime)}</span></span>` : ""}`,
      `<div class="ckrows">${rows}</div>`,
      { open: !!open },
    );
  };

  const renderTracksDrawer = (rom, open, verdict = "") => {
    if (!rom.tracks) return "";
    const rows = rom.tracks
      .map((tr) => `<div class="ckgrp">
          <div class="ck-group-head"><span>${t("roms.track", { n: tr.n })} · ${esc(tr.type)} · @${tr.start}</span><span class="tsz mono">${fmtSizeStr(tr.size)}</span></div>
          <div class="ckrows">${tr.cks.map(renderCkRow).join("")}</div>
        </div>`)
      .join("");
    return renderDrawer(
      `<span class="lab">${t("drawer.tracks")}</span><span class="readouts"><span class="rb mono">${tCount("roms.tracks", rom.tracks.length)}</span>${rom.ckTime ? `<span class="rb time mono">${fmtTime(rom.ckTime)}</span>` : ""}</span>`,
      `<div class="trackrows">${rows}</div>`,
      { open: !!open },
    );
  };
  /* the disc index drawer: a .cue sheet for CDs and/or a .gdi index for GD-ROMs.
     when BOTH are present they share one section, split into two labelled
     sub-sections, each with its own copy button (scoped to its .cuebody) */
  const renderCueDrawer = (rom) => {
    const sheets = [
      ...(rom.cue ? [{ labelKey: "cue.label", text: rom.cue }] : []),
      ...(rom.gdi ? [{ labelKey: "gdi.label", text: rom.gdi }] : []),
    ];
    if (!sheets.length) return "";
    const both = sheets.length > 1;
    const label = both ? `${t("cue.label")} / ${t("gdi.label")}` : t(sheets[0].labelKey);
    const bodies = sheets
      .map((s) => `<div class="cue-sub"><div class="cue-sub-head">${both ? `<span class="cue-sub-lab">${t(s.labelKey)}</span>` : ""}<button class="copy cue-copy" type="button" data-copy-cue aria-label="${t("common.copy")} ${t(s.labelKey)}">${ICONS.copy}</button></div><pre class="cue-text mono">${esc(s.text)}</pre></div>`)
      .join("");
    return renderDrawer(`<span class="lab">${label}</span>`, bodies);
  };
  /* extraction is only surfaced where it's the point of the example (a ROM pulled
     out of a nested archive) - not on every card that happens to carry a chain */
  const renderExtractDrawer = (rom) =>
    rom.showExtract && rom.chain && rom.chain.length > 1
      ? renderDrawer(
          `<span class="lab">${t("drawer.extract")}</span><span class="readouts"><span class="rb time mono">${rom.extractTime ? fmtTime(rom.extractTime) : ""}</span></span>`,
          `<div class="taskbody">${renderChain(rom.chain)}</div>`,
        )
      : "";
  const renderRomCard = (rom, idx, opts = {}) => {
    /* the game name leads; the file name + system fold into a Details drawer.
       the verdict rides in the tracks/checksums header, and size lives in the
       extraction header when there is one (else in the compact meta line).
       ROM cards keep the PLAIN card border - verdict borders (green/red/yellow)
       belong to patches, whose verification can pass/warn/fail */
    return `
    <article class="card"${opts.vt ? ` style="view-transition-name: ${opts.vt}"` : ""} aria-label="${esc(rom.name)}">
      <div class="card-top">
        <div class="card-name">
          <div class="nmline"><span class="nm">${esc(rom.name.replace(/\.[^.]+$/, ""))}</span></div>
          <span class="card-meta"><span class="fsize mono">${fmtSizeStr(rom.size)}</span>${rom.tag ? `<span class="meta-fmt mono">${esc(rom.tag)}</span>` : ""}</span>
        </div>
        <div class="card-actions">
          <div class="card-btns">
            <button class="rm" type="button" aria-label="${t("common.remove")} ${esc(rom.name)}">${ICONS.cross}</button>
          </div>
        </div>
      </div>
      ${renderTracksDrawer(rom, !!opts.openChecksums)}
      ${rom.tracks ? "" : renderChecksums(rom, !!opts.openChecksums)}
      ${renderFileOptions(rom, `rom${idx}`, "", "opts.rom")}
      ${renderCueDrawer(rom)}
      ${renderExtractDrawer(rom)}
    </article>`;
  };

  /* per-file options share the output-options component language:
     header + field grid + check row, scaled for cards */
  const renderFileOptions = (item, prefix, extraChecks = "", titleKey = "opts.title", extraShort = "", extraFields = "") => {
    const opts = item.options || [];
    if (!opts.length && !extraChecks && !extraFields) return "";
    /* labels/shorts come from the catalog (labelKey/shortKey + labelVars) so
       per-file option copy translates with the rest of the UI */
    const optLabel = (o) => (o.labelKey ? t(o.labelKey, o.labelVars) : o.label);
    const optShort = (o) => (o.shortKey ? t(o.shortKey) : o.short);
    const summary = [...(extraShort ? [extraShort] : []), ...opts.map(optShort).filter(Boolean)].join(" · ");
    const selects = opts.filter((o) => o.type === "select");
    const checks = opts.filter((o) => o.type !== "select");
    const grid = extraFields + selects
      .map((o, i) =>
        optField(esc(optLabel(o)), `<select class="select mono" name="${prefix}-opt-${i}" aria-label="${esc(optLabel(o))}">${o.options
          .map((v, vi) => `<option${vi === (o.selected || 0) ? " selected" : ""}>${esc(v)}</option>`)
          .join("")}</select>`),
      )
      .join("");
    const checkHtml =
      extraChecks +
      checks.map((o, i) => toggleRow(`${prefix}-chk-${i}`, esc(optLabel(o)), o.checked)).join("");
    return renderDrawer(
      `<span class="lab opts-lab">${t(titleKey)}</span>${summary ? `<span class="readouts"><span class="rb mono">${esc(summary)}</span></span>` : ""}`,
      `<div class="optsbody">
        ${grid ? `<div class="optsgrid">${grid}</div>` : ""}
        ${checkHtml ? `<div class="optschecks">${checkHtml}</div>` : ""}
      </div>`,
      { cls: "optsblock" },
    );
  };

  /* a staging patch keeps a WORKING drag handle + data-pid so it reorders mid-parse
     like a settled card - the id carries the new order into the re-render. ROM reading
     cards pass no pid and stay non-draggable (single ROM, nothing to reorder) */
  const renderReadingCard = (idx, name, labelKey = "roms.extracting", pid = null) => `
    <div class="prog-panel${pid ? " has-handle" : ""}" style="view-transition-name: ${pid ? `vt-${pid}` : "vt-rom"}" aria-busy="true"${pid ? ` data-pid="${pid}"` : ""}>
      <div class="prog">
        <div class="lab"><span class="what mono">${t(labelKey, { name: esc(name) })}</span></div>
        <div class="meter indet live" aria-hidden="true"><div class="fill"></div></div>
        <div class="sub mono"><span>${t("progress.threads", { n: CORES })}</span><span class="run-pct">-</span></div>
      </div>
      <div class="prog-actions">
        ${pid ? `<button class="handle" type="button" data-drag aria-label="${t("patch.reorder")}">${ICONS.grip}</button>` : ""}
        <button class="cancel stage-cancel" type="button" aria-label="${t("drop.cancelStage")}">${ICONS.cross}</button>
      </div>
    </div>`;

  /* optional manual checksum gates - paste an expected input/output digest to
     enforce, alongside the auto verifications */
  const patchVerifyInputs = (idx) =>
    optField(t("verify.expIn"), `<input class="input mono" name="patch-in-ck-${idx}" placeholder="${t("verify.ckHint")}" aria-label="${t("verify.expIn")}" />`) +
    optField(t("verify.expOut"), `<input class="input mono" name="patch-out-ck-${idx}" placeholder="${t("verify.ckHint")}" aria-label="${t("verify.expOut")}" />`);

  /* a patch targets one binary part of a multi-part disc - show just the track
     ("Track 1"), not the whole disc filename, so the target stays compact */
  const trackLabel = (name) => {
    const m = name.match(/\(Track\s*(\d+)\)/i);
    if (m) return `${t("track.word")} ${Number(m[1])}`;
    return name.replace(/\.[^.]+$/, "");
  };
  /* a labelled switch leads the sub-line and toggles a patch on/off - checked =
     enabled. role="switch" announces the on/off state; the accessible name is the
     patch itself (state-neutral + unique) and lives on the INPUT. both state words
     share one grid cell so the label needs no JS update and never shifts the row */
  const patchEnableToggle = (pid, on, name) =>
    `<label class="patch-enable"><input type="checkbox" role="switch" data-enable="${pid}" aria-label="${esc(t("patch.toggle", { name: name.replace(/\.[^.]+$/, "") }))}"${on ? " checked" : ""} /><span class="switch-state" aria-hidden="true"><b class="on">${t("patch.on")}</b><b class="off">${t("patch.stateOff")}</b></span></label>`;
  const renderPatchCard = (p, idx, opts = {}) => {
    const reqDrawer = renderVerifyDrawer(p, opts);
    /* the body (verify + options drawers) collapses behind the name/desc header
       when the patch is disabled - toggled IN PLACE via a class so there's no
       full re-render blink */
    /* the target leads the sub-line: the target ICON sits OUTSIDE the badge (at the
       card's content edge, lining up with the name above), then the track rides a
       small badge - a borderless dropdown when there's more than one part to pick */
    const targetBadge = p.target
      ? `<span class="target-grp${opts.bad ? " bad" : ""}" title="${esc(p.target)}">${ICONS.target}${
          opts.targetOptions
            ? `<select class="meta-target-select mono" name="target-${idx}" aria-label="${t("patch.target")}">${opts.targetOptions
                .map((o) => `<option value="${esc(o)}"${o === p.target ? " selected" : ""}>${esc(trackLabel(o))}</option>`)
                .join("")}</select>`
            : `<span class="meta-target-static mono">${esc(trackLabel(p.target))}</span>`
        }</span>`
      : "";
    const body = `${reqDrawer}
      ${renderFileOptions(p, `patch${idx}`, p.undoAware ? toggleRow(`undo-aware-${idx}`, t("patch.undo"), true) : "", "opts.patch", p.undoAware ? "undo-aware" : "", patchVerifyInputs(idx))}`;
    /* verdict border: red on a failed gate, yellow when the patch can only be
       weakly verified (p.warnKey), green when its verifications passed, plain
       when there's nothing to verify. Disabled cards stay neutral/dashed. */
    const verdict = opts.disabled ? "" : opts.bad ? " bad" : p.warnKey ? " warn" : p.verify ? " ok" : "";
    return `
    <article class="card grabbable${verdict}${opts.disabled ? " is-disabled" : ""}"${opts.pid ? ` data-pid="${opts.pid}" style="view-transition-name: vt-${opts.pid}"` : ""} aria-label="${esc(p.name)}">
      <div class="card-top">
        <div class="card-name">
          <div class="nmline"><span class="nm">${esc(p.name.replace(/\.[^.]+$/, ""))}</span>${!p.target && opts.bad ? `<span class="verdict bad">${ICONS.fault}${t("verdict.mismatch")}</span>` : ""}</div>
          <span class="card-meta">${opts.pid ? patchEnableToggle(opts.pid, !opts.disabled, p.name) : ""}${targetBadge}<span class="fsize mono">${fmtSizeStr(p.size)}</span><span class="meta-fmt mono">${esc(p.fmt.toLowerCase())}</span></span>
        </div>
        <div class="card-actions">
          <div class="card-btns">
            <button class="handle" type="button" data-drag${opts.dragDisabled ? " disabled" : ""} aria-label="${t("patch.reorder")}">${ICONS.grip}</button>
            <button class="rm" type="button" aria-label="${t("common.remove")} ${esc(p.name)}">${ICONS.cross}</button>
          </div>
        </div>
      </div>
      ${p.desc ? `<p class="patch-desc">${esc(p.desc)}</p>` : ""}
      ${p.warnKey && !opts.disabled && !opts.bad ? `<p class="patch-warn">${ICONS.fault}<span>${t(p.warnKey)}</span></p>` : ""}
      <div class="patch-body"><div class="patch-body-inner">${body}</div></div>
    </article>`;
  };

  const HERO_FORMATS = {
    apply: ["ips", "bps", "ups", "xdelta", "ppf", "cue", "zip", "7z", "chd", "rvz"],
    create: ["sfc", "gba", "iso", "bin", "zip", "7z", "chd", "rvz"],
    /* mirrors TrimInputKind in the real app: nds/dsi/srl + gba + 3ds tail trims,
       Xbox xiso, and GC/Wii images that trim by RVZ scrub (iso/gcm/wbfs) */
    trim: ["nds", "dsi", "gba", "3ds", "xiso", "iso", "gcm", "wbfs", "rvz"],
  };
  /* the 0x01 hero leads each mode; create splits original/modified across two
     sections, so its hero asks for the original only */
  const HERO_LABEL = { apply: "drop.hero", create: "drop.original", trim: "drop.heroTrim" };
  const ADD_LABEL = { apply: "drop.add", create: "drop.addCreate", trim: "drop.addTrim" };
  /* 0x01 is the one INPUTS section - the single drop/add surface. the type
     sections below (ROM, Patches, …), when empty, don't present their own drop
     target - they point the user up to 0x01. clicking scrolls to + focuses it. */
  const renderNeedsInput = (nounKey) =>
    `<button class="needs-input" type="button" data-goto-input>
      ${ICONS.up}<span>${t(nounKey ? "empty.needsInputNoun" : "empty.needsInput", { noun: nounKey ? t(nounKey) : "", loc: '<b class="hexref mono">0x01</b>' })}</span>
    </button>`;
  /* the dedicated 0x01 INPUTS step: a hero drop while empty, the staging pill
     while routing, a compact add-row once files are staged. shared by all modes */
  const renderInputsStep = (mode, sc) => {
    const empty = sc === "empty" || sc === "dragging";
    const staging = sc === "staging";
    const woven = sc === "complete" || sc === "running" ? " is-woven" : "";
    return `<section class="step is-input${empty ? " is-empty" : ""}${woven}" aria-label="${t("step.inputs")}">
      ${stepHead("01", "step.inputs", "", "info.romInput")}
      <div class="step-body">${renderDrop(empty ? "hero" : staging ? "staging" : "", mode)}</div>
    </section>`;
  };

  const renderDrop = (variant, mode) => {
    if (variant === "hero" || variant === "dragging") {
      return `<div class="drop hero bare" role="button" tabindex="0" aria-label="${t(HERO_LABEL[mode])}">
        <span class="main">${ICONS.drop}<span>${t(HERO_LABEL[mode])}</span></span>
        <span class="hint fine">${t("drop.hint")}</span>
        <span class="hint coarse">${t("drop.tapAnywhere")}</span>
        <span class="formats" aria-hidden="true">${HERO_FORMATS[mode].map((f) => `<span class="fmt mono">${f}</span>`).join("")}</span>
      </div>`;
    }
    if (variant === "staging") {
      // the brief "deciding which section each file belongs to" phase - styled as
      // the compact add-pill it settles into, so the transition reads as one control
      return `<div class="drop staging" role="status" aria-busy="true" aria-label="${t("drop.staging")}">
        <span class="main btnish"><span class="spinner" aria-hidden="true"></span><span>${t("drop.staging")}</span></span>
      </div>`;
    }
    return `<div class="drop" role="button" tabindex="0" aria-label="${t(ADD_LABEL[mode])}">
      <span class="main btnish">${ICONS.drop}<span>${t(ADD_LABEL[mode])}</span></span>
      <span class="hint fine">${t("drop.anywhereShort")}</span>
      <span class="hint coarse">${t("drop.tap")}</span>
    </div>`;
  };

  /* clickable "i" - self-documenting forms; catalog text is split into bullet
     points (on "; ") to match the real app's info popovers */
  const info = (key, vars) => {
    const points = t(key, vars).split("; ");
    return `<span class="info"><button type="button" class="info-btn" data-info aria-expanded="false" aria-label="${t("info.aria")}">${ICONS.info}</button><span class="info-pop" role="note" hidden><ul class="info-list">${points.map((p) => `<li>${p}</li>`).join("")}</ul></span></span>`;
  };
  const profileOptions = (selected) =>
    PROFILES.map((pr) => `<option${pr === selected ? " selected" : ""}>${t(`scale.${pr}`)}</option>`).join("");

  const stepHead = (num, titleKey, meta, infoKey) =>
    `<div class="step-head"><span class="step-num mono">0x${num}</span><h2 class="step-title">${t(titleKey)}</h2>${infoKey ? info(infoKey) : ""}${meta ? `<span class="step-meta mono">${meta}</span>` : ""}</div>`;

  /* job-surface fragments shared by all three modes */
  const renderRunProg = (mode) => {
    const cfg = MODE_CFG[mode];
    const io = jobIO(mode);
    /* the live run only surfaces what the engine actually reports: the active stage
       (what's happening), the bar, the thread count, and the percentage. there's no
       byte/size/throughput stream, so the bottom row carries threads on the left and
       the percentage on the right - which also lets the percentage sit at the panel's
       right edge (the cancel owns the top-right corner alone) */
    return `<div class="prog-panel runprog" style="view-transition-name: vt-action">
      <div class="prog run-prog">
        <div class="lab"><span class="what run-stage-label">${t(`stage.${io.plan[0].id}`)} - ${esc(io.runFile(0))}</span></div>
        <div class="meter live" aria-hidden="true"><div class="fill run-fill"></div></div>
        <div class="sub mono"><span>${t("progress.threads", { n: CORES })}</span><span class="run-pct">0%</span></div>
      </div>
      <div class="prog-actions"><button class="cancel run-cancel" type="button" aria-label="${t("running.cancel")}">${ICONS.cross}</button></div>
    </div>
    <div class="sr-only run-pbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="${cfg.runLabel()}"></div>`;
  };

  const renderFault = (mode) => {
    const cfg = MODE_CFG[mode];
    const k = mode === "apply" ? applyInput().faultKey : cfg.fault.key;
    return `<div class="fault" role="alert">
      <div class="fault-head">${ICONS.fault}<span class="fault-title">${t(`${k}.title`)}</span><span class="fault-code mono">${cfg.fault.code}</span></div>
      <div class="fault-body">${t(`${k}.body`)}
        <div class="fault-remedy"><span class="k">${t("fault.remedyK")}</span><span class="v">${t(`${k}.remedy`)}</span></div>
      </div>
      <div class="fault-foot">
        <button class="btn slim ghost" type="button" data-copy-report>${ICONS.copy}${t("fault.copy")}</button>
        <button class="btn slim ghost" type="button" data-retry>${t("common.retry")}</button>
      </div>
    </div>
    ${cfg.fault.override ? `<label class="checkrow warn"><input type="checkbox" role="switch" name="checksum-override" /> <span>${t(`${k}.override`)}</span></label>` : ""}`;
  };

  /* what the download button is saving: a patch (create), a container with its
     specific codecs (chd/rvz · cdlz…), an archive (zip/7z), or a raw dump */
  const ARCHIVE_EXTS = new Set(["zip", "7z", "rar", "tar", "gz", "tgz", "bz2"]);
  const outputDesc = (mode) => {
    const io = jobIO(mode);
    const ext = ((io.out.name.match(/\.([^.]+)$/) || [])[1] || "").toLowerCase();
    if (mode === "create") return t("result.patchType", { t: ext });
    if (io.compressSummary) {
      const container = io.compressSummary.split(" · ")[0];
      if (ARCHIVE_EXTS.has(container)) return t("result.archive", { t: container });
      return container;
    }
    if (ARCHIVE_EXTS.has(ext)) return t("result.archive", { t: ext });
    return t("result.raw", { t: ext });
  };
  /* the complete-state per-stage timings + verified mark ride the step header as
     badges (only the meaningful stages - apply/verify · diff/encode · trim · the
     output compress - not detect/extract/checksum/write boilerplate) */
  /* one chip per result stage; the verify stage carries the verified check + accent
     instead of a separate "Verified" badge, so its timing IS the pass signal - and
     three chips (not four) fit one row on a phone */
  const applyDoneMeta = (mode) => {
    const stages = jobIO(mode).plan.filter((s) => RESULT_STAGES.has(s.id));
    return stages
      .map((s, i) => {
        const verified = s.id === "verify";
        // done-chip: chips stagger in as the result lands (chip-in keyframe)
        return `<span class="rb mono done-chip${verified ? " verified" : ""}" style="animation-delay:${0.12 + i * 0.07}s">${verified ? ICONS.check : ""}<span class="k">${t(`stage.${s.id}`)}</span><span class="t">${fmtDur(s.dur)}</span></span>`;
      })
      .join("");
  };
  /* the result IS the download action - a full-width orange button carrying the
     output size + delta, with the total time + thread count on its right */
  const renderResult = (mode) => {
    const cfg = MODE_CFG[mode];
    const out = jobIO(mode).out;
    return `<div class="result" style="view-transition-name: vt-action" aria-label="${t(cfg.resultKey)}">
      <button class="btn primary run download-btn" type="button" aria-label="${t("result.download")} ${esc(out.name)}">
        ${ICONS.download}<span class="dl-kind mono">${esc(outputDesc(mode))}</span><span class="dl-size mono">${fmtSizeStr(out.size)}</span><span class="dl-delta mono">${out.meta()}</span><span class="dl-total mono"><b class="total-time" style="--t: ${Math.round(planTotal(mode) * 100)}; --dec: '${decSep()}'"></b></span>
      </button>
    </div>`;
  };

  const renderRunButton = (mode, disabled) => {
    /* nothing to weave when every staged patch is toggled off */
    const noPatches = mode === "apply" && buildPatchItems(applyInput(), false).every((it) => it.disabled);
    /* vt-action: the button MORPHS into the run-progress panel, which morphs
       into the download button - one continuous action element across the job */
    return `<button class="btn primary run run-btn" type="button" style="view-transition-name: vt-action"${disabled || noPatches ? " disabled" : ""}>${MODE_ICONS[mode]}<span>${MODE_CFG[mode].runLabel()}</span></button>`;
  };

  /* output options: one component for all modes - codec/level/threads plus
     mode-specific fields, stacked label-over-control in a responsive grid */
  const optField = (label, control, infoKey) =>
    `<div class="ofld"><span class="ofld-l">${label}${infoKey ? info(infoKey) : ""}</span>${control}</div>`;
  /* an editable combobox field (input + datalist + chevron) - the codec selectors
     mirror the real app's codec combobox: type a custom list or pick a suggestion */
  const comboField = (label, name, value, suggestions, infoKey, disabled) => {
    const listId = `${name}-list`;
    return optField(
      label,
      `<input class="input mono combo" name="${name}" value="${esc(value)}"${disabled} list="${listId}" aria-label="${esc(label)}" /><datalist id="${listId}">${suggestions.map((s) => `<option value="${esc(s)}"></option>`).join("")}</datalist>`,
      infoKey,
    );
  };
  /* extra entries (the staged input's actual container, e.g. chd) join the base
     list so the select can reflect what the demo job really writes */
  const compressTypeField = (disabled, selected, extra = []) =>
    optField(t("settings.compression"), `<select class="select mono" name="compress-type"${disabled} aria-label="${t("settings.compression")}">${[...new Set(["none", "zip", "7z", ...extra])]
      .map((o) => `<option${o === selected ? " selected" : ""}>${o}</option>`)
      .join("")}</select>`, "info.compressType");
  const levelField = (disabled) =>
    optField(t("settings.profile"), `<select class="select" name="compress-profile"${disabled} aria-label="${t("settings.profile")}">${profileOptions("max")}</select>`, "info.level");
  /* the output options badge shows resolved codec:level pairs (like the real
     app) rather than the profile name - "chd · cdlz,cdzl,cdfl" → "chd cdlz:9,cdzl:9,cdfl:8".
     levels are the Max-profile values per codec (standard 0-9, FLAC 8, zstd 22). */
  const CODEC_MAX = { cdlz: 9, cdzl: 9, cdfl: 8, cdzs: 22, lzma: 9, lzma2: 9, deflate: 9, zstd: 22, bzip2: 9, flac: 8, zlib: 9 };
  /* returns the badge as separate parts - [container, codec:level list] - so they
     render as distinct chips (e.g. `chd` and `cdlz:9,cdzl:9,cdfl:8`) */
  const outputBadge = (compressSummary) => {
    const [container, codecs] = compressSummary.split(" · ");
    if (!codecs) return [container];
    return [container, codecs.split(",").map((c) => `${c}:${CODEC_MAX[c] ?? 9}`).join(",")];
  };
  const renderOutputOptions = (mode, disabled) => {
    let fields = "";
    let checks = "";
    let summary = ["none"];
    if (mode === "apply") {
      const inp = applyInput();
      summary = outputBadge(inp.compressSummary);
      /* the type select mirrors the summary badge - both read the input's container */
      const container = inp.compressSummary.split(" · ")[0];
      fields = compressTypeField(disabled, container, [container]) + inp.codecField(disabled) + levelField(disabled);
    }
    if (mode === "create") {
      fields =
        optField(t("opts.window"), `<input class="input mono" name="diff-window" placeholder="auto (64 KiB)"${disabled} aria-label="${t("opts.window")}" />`, "info.window") +
        compressTypeField(disabled, "none") + levelField(disabled);
      checks = toggleRow("embed-checksum", t("patch.embed"), true, disabled);
    }
    if (mode === "trim") {
      fields =
        optField(t("opts.trimPad"), `<select class="select mono" name="trim-pad"${disabled} aria-label="${t("opts.trimPad")}"><option selected>auto (0xFF)</option><option>0x00</option><option>0xFF</option></select>`, "info.trimPad") +
        compressTypeField(disabled, "none") + levelField(disabled);
      checks = toggleRow("trim-verify", t("opts.trimVerify"), true, disabled);
    }
    return renderDrawer(
      `<span class="lab opts-lab">${t("opts.output")}</span><span class="readouts">${summary.map((s) => `<span class="rb mono">${esc(s)}</span>`).join("")}</span>`,
      `<div class="optsbody">
        <div class="optsgrid">${fields}</div>
        ${checks ? `<div class="optschecks">${checks}</div>` : ""}
      </div>`,
      { cls: "optsblock" },
    );
  };

  /* stages worth a time chip in the result - the mode's core work + compress */
  const RESULT_STAGES = new Set(["apply", "verify", "diff", "encode", "trim", "compress"]);
  /** Last step's action area: run button / live progress / fault / result download.
   *  every state renders in this same slot inside the output card, so the action
   *  keeps one container width (the result no longer breaks out wider on complete). */
  const renderJobAction = (mode, sc) => {
    if (sc === "running") return renderRunProg(mode);
    if (sc === "complete") return renderResult(mode);
    // nothing to weave until inputs are staged
    const blocked = sc === "staging" || sc === "empty" || sc === "dragging";
    return `${sc === "fault" ? renderFault(mode) : ""}${renderRunButton(mode, blocked)}`;
  };

  /* one output card for all three modes: filename + format select, the output
     options drawer, an optional mode-specific row, then the job action slot */
  const OUT_FORMATS = {
    create: { list: [".xdelta", ".bps", ".ips", ".ups", ".ppf"], selected: ".bps", labelKey: "patch.format" },
    trim: { list: [".nds", ".zip", ".7z"], selected: ".nds", labelKey: "step.output" },
  };
  const renderOutCard = (mode, sc, extra = "") => {
    const empty = sc === "empty" || sc === "dragging";
    // output filename + options stay editable at all times except while a job runs
    const outDisabled = sc === "running" ? " disabled" : "";
    const fmts = mode === "apply"
      ? { list: applyInput().outFormats, selected: applyInput().outFormats[0], labelKey: "step.output" }
      : OUT_FORMATS[mode];
    const name = empty ? "" : esc(mode === "apply" ? applyInput().outName : MODE_CFG[mode].outName);
    return `<article class="card outcard">
      <div class="outbar">
        <div class="fname">
          <textarea class="input mono outname" name="${mode}-output-name" rows="1" aria-label="${t("out.placeholder")}" placeholder="${t("out.placeholder")}"${outDisabled}>${name}</textarea>
          <span class="sep"></span>
          <select class="select mono" name="${mode}-output-format" aria-label="${t(fmts.labelKey)}"${outDisabled}>
            ${fmts.list.map((f) => `<option${f === fmts.selected ? " selected" : ""}>${f}</option>`).join("")}
          </select>
        </div>
      </div>
      ${renderOutputOptions(mode, outDisabled)}
      ${extra}
      ${renderJobAction(mode, sc)}
    </article>`;
  };

  /* patch stack ordering: base patches + dropped extras, reordered by the
     persisted per-input order (drag or keyboard) */
  /* a patch is disabled if its author default (p.disabled) is flipped by a user toggle */
  const isPatchOff = (id, dflt) => (!!dflt) !== state.patchToggles.has(`${state.input}:${id}`);
  const buildPatchItems = (inp, bad) => {
    const items = [
      ...inp.patches.map((p, i) => { const id = `base${i}`; const disabled = isPatchOff(id, p.disabled); return { bad: bad && i === 0 && !disabled, id, p, disabled }; }),
      ...state.extraPatches.map((e, i) => ({
        id: `extra${i}`,
        disabled: isPatchOff(`extra${i}`, false),
        p: { fmt: e.fmt, name: e.name, size: e.size, target: inp.targetOptions ? inp.targetOptions[0] : undefined },
      })),
    ];
    const order = state.patchOrder[state.input];
    if (!order) return items;
    const byId = new Map(items.map((it) => [it.id, it]));
    const ordered = order.map((id) => byId.get(id)).filter(Boolean);
    for (const it of items) if (!order.includes(it.id)) ordered.push(it);
    return ordered;
  };

  /* the patches step header lists enabled + disabled file counts as badges; the
     size badge totals ENABLED patches only (disabled ones won't be woven) */
  const parseSizeStr = (s) => {
    const m = String(s).trim().match(/^([\d.,]+)\s*([A-Za-z]+)$/);
    return m ? parseFloat(m[1].replace(/,/g, "")) * (SIZE_UNITS[m[2]] ?? 1) : 0;
  };
  const patchStepMeta = (inp, bad) => {
    const items = buildPatchItems(inp, bad);
    const on = items.filter((it) => !it.disabled);
    const off = items.length - on.length;
    const bytes = on.reduce((sum, it) => sum + parseSizeStr(it.p.size), 0);
    return `<span class="rb mono">${tCount("roms.files", on.length)}</span>`
      + (off ? `<span class="rb mono muted">${tCount("patch.off", off)}</span>` : "")
      + `<span class="rb mono">${fmtSize(bytes)}</span>`;
  };

  /* ════════ mode renderers ════════ */
  const renderApply = (quiet = false) => {
    const sc = state.scenario;
    const mode = "apply";
    const inp = applyInput();
    const body = $("#apply-body");
    body.classList.toggle("quiet", quiet);
    const empty = sc === "empty" || sc === "dragging";
    const running = sc === "running";
    const staging = sc === "staging";
    const bad = sc === "fault";
    // the output card stays visible while empty, but its action is disabled
    // until there's something to weave (renderOutCard handles the controls)
    const woven = sc === "complete" || running ? " is-woven" : "";
    body.innerHTML = `
      ${renderInputsStep(mode, sc)}
      <section class="step${woven}${bad ? " is-fault" : ""}" aria-label="${t("step.rom")}">
        ${stepHead("02", "step.rom", "", "info.romInput")}
        <div class="step-body">
          ${empty
            ? renderNeedsInput("needs.rom")
            : `<div class="cards">${staging ? renderReadingCard(0, inp.readingName) : renderRomCard(inp.rom, 0, { openChecksums: true, vt: "vt-rom" })}</div>`}
        </div>
      </section>
      <section class="step${woven}${bad ? " is-fault" : ""}" aria-label="${t("step.patches")}">
        ${stepHead("03", "step.patches", empty ? "" : patchStepMeta(inp, bad), "info.patches")}
        <div class="step-body">
          ${empty
            ? renderNeedsInput("needs.patches")
            : `${bad ? "" : `<div class="notice warn" role="status">${ICONS.fault}<span class="body">${inp.notice()}</span><button class="x" type="button" aria-label="${t("common.dismiss")}">${ICONS.cross}</button></div>`}
          <div class="cards patch-cards">
            ${buildPatchItems(inp, bad)
              .map((it, i) =>
                staging && it.id === "base1"
                  ? renderReadingCard(i, it.p.name, "patch.parsing", it.id)
                  : renderPatchCard(it.p, i, { bad: it.bad, disabled: it.disabled, dragDisabled: running, pid: it.id, targetOptions: inp.targetOptions }),
              )
              .join("")}
          </div>`}
        </div>
      </section>
      <section class="step${sc === "complete" ? " is-woven" : ""}${bad ? " is-fault" : ""}" aria-label="${t("step.apply")}">
        ${stepHead("04", "step.apply", sc === "complete" ? applyDoneMeta(mode) : "", "info.output")}
        <div class="step-body">${renderOutCard(mode, sc,
          (() => { const off = empty ? 0 : buildPatchItems(inp, bad).filter((it) => it.disabled).length; return `<div class="reveal${off ? " is-open" : ""}"${off ? "" : " hidden"}><p class="patch-off-note" aria-live="polite">${ICONS.fault}<span>${off ? tCount("patch.offCount", off) : ""}</span></p></div>`; })(),
        )}</div>
      </section>`;
  };

  const renderCreate = () => {
    const sc = state.scenario;
    const mode = "create";
    const body = $("#create-body");
    const empty = sc === "empty" || sc === "dragging";
    const running = sc === "running";
    const staging = sc === "staging";
    const bad = sc === "fault";
    const disabled = running || staging ? " disabled" : "";
    const stepsWoven = sc === "complete" || running ? " is-woven" : "";
    /* the swap hinge exchanges which staged file plays Original vs Modified.
       vt names follow the CONTENT (not the slot) so the two cards visibly trade
       places when swapped; the MODIFIED data keeps vt-rom so the staging
       reading-card still settles into it */
    const origRom = state.createSwapped ? CREATE_MODIFIED_ROM : CREATE_ORIGINAL_ROM;
    const modRom = state.createSwapped ? CREATE_ORIGINAL_ROM : CREATE_MODIFIED_ROM;
    const vtFor = (rom) => (rom === CREATE_MODIFIED_ROM ? "vt-rom" : "vt-cr-orig");
    body.innerHTML = `
      ${renderInputsStep(mode, sc)}
      <section class="step${stepsWoven}" aria-label="${t("step.original")}">
        ${stepHead("02", "step.original", "", "info.createOriginal")}
        <div class="step-body">${empty
          ? renderNeedsInput("needs.original")
          : `<div class="cards">${renderRomCard(origRom, 0, { openChecksums: true, vt: vtFor(origRom) })}</div>`}</div>
      </section>
      ${empty ? "" : `<div class="swap-row"><button class="btn swap-btn" type="button"${disabled}>${ICONS.swap}${t("create.swap")}</button></div>`}
      <section class="step${stepsWoven}${bad ? " is-fault" : ""}" aria-label="${t("step.modified")}">
        ${stepHead("03", "step.modified", "", "info.createModified")}
        <div class="step-body">${empty
          ? renderNeedsInput("needs.modified")
          : `<div class="cards">${staging ? renderReadingCard(1, modRom.name) : renderRomCard(bad ? { ...modRom, cks: origRom.cks, game: t("create.identical") } : modRom, 1, { bad, openChecksums: true, vt: vtFor(modRom) })}</div>`}</div>
      </section>
      <section class="step${sc === "complete" ? " is-woven" : ""}${bad ? " is-fault" : ""}" aria-label="${t("step.patch")}">
        ${stepHead("04", "step.patch", sc === "complete" ? applyDoneMeta(mode) : "", "info.output")}
        <div class="step-body">${renderOutCard(mode, sc)}</div>
      </section>`;
  };

  const renderTrim = () => {
    const sc = state.scenario;
    const mode = "trim";
    const body = $("#trim-body");
    const empty = sc === "empty" || sc === "dragging";
    const running = sc === "running";
    const staging = sc === "staging";
    const bad = sc === "fault";
    const woven = sc === "complete" || running ? " is-woven" : "";
    body.innerHTML = `
      ${renderInputsStep(mode, sc)}
      <section class="step${woven}${bad ? " is-fault" : ""}" aria-label="${t("step.rom")}">
        ${stepHead("02", "step.rom", "", "info.trimRom")}
        <div class="step-body">
          ${empty
            ? renderNeedsInput("needs.source")
            : `<div class="cards">${staging ? renderReadingCard(0, TRIM_ROM.name) : renderRomCard(TRIM_ROM, 0, { openChecksums: true, vt: "vt-rom" })}</div>
          ${bad || staging ? "" : `<div class="notice warn" role="status" style="margin-block-start:11px">${ICONS.fault}<span class="body"><b>${t("trim.detected")}</b> - <span class="mono">${t("trim.savings", { from: fmtSizeStr("128.0 MiB"), p: "67.2%", to: fmtSizeStr("42.0 MiB") })}</span></span></div>`}`}
        </div>
      </section>
      <section class="step${sc === "complete" ? " is-woven" : ""}${bad ? " is-fault" : ""}" aria-label="${t("mode.trim")}">
        ${stepHead("03", "mode.trim", sc === "complete" ? applyDoneMeta(mode) : "", "info.output")}
        <div class="step-body">${renderOutCard(mode, sc)}</div>
      </section>`;
  };

  /* ── inspector ── */
  let traceLines = [];
  const LOG_SEVERITY = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
  /* derive a Rust-tracing-style target (module path) from the message's "op:" prefix */
  const CALLER_MAP = {
    runtime: "rom_weaver_wasm::runtime", opfs: "rom_weaver_wasm::opfs", detect: "rom_weaver_app::detect",
    nested: "rom_weaver_containers::archive", cue: "rom_weaver_containers::index", gdi: "rom_weaver_containers::index",
    extract: "rom_weaver_containers::extract", checksum: "rom_weaver_core::checksum", verify: "rom_weaver_app::verify",
    apply: "rom_weaver_patches::apply", diff: "rom_weaver_patches::create", encode: "rom_weaver_patches::create",
    scan: "rom_weaver_app::trim", trim: "rom_weaver_app::trim", write: "rom_weaver_core::io", compress: "rom_weaver_containers::compress",
  };
  const splitTrace = (msg) => {
    const m = msg.match(/^([a-z0-9_]+):\s*(.*)$/i);
    const key = m ? m[1].toLowerCase() : "";
    return { caller: CALLER_MAP[key] || (key ? `rom_weaver::${key}` : "rom_weaver"), message: m ? m[2] : msg };
  };
  const visibleTraceLines = () => {
    const min = LOG_SEVERITY[state.logLevel] ?? 0;
    const q = (state.logFilter || "").trim().toLowerCase();
    return traceLines
      .filter((l) => (LOG_SEVERITY[l.lv] ?? 0) >= min)
      .filter((l) => !q || `${l.lv} ${splitTrace(l.msg).caller} ${l.msg}`.toLowerCase().includes(q));
  };
  const traceLineHtml = (l) => {
    const { caller, message } = splitTrace(l.msg);
    return `<div class="ln"><span class="ts">${l.ts}</span><span class="lv ${l.lv}">${l.lv}</span><span class="caller">${esc(caller)}</span><span class="msg">${esc(message)}</span></div>`;
  };
  /* full rebuild - used when the level/filter changes or a scenario reseeds.
     live lines go through pushTrace's APPEND path instead: the log is a polite
     live region, and rewriting its whole innerHTML would make screen readers
     re-announce every existing line on each new entry */
  const renderTrace = () => {
    const log = $("#trace-log");
    if (!log) return;
    const shown = visibleTraceLines();
    log.innerHTML = shown.length
      ? shown.map(traceLineHtml).join("")
      : `<div class="tracelog-empty">${state.logFilter ? t("log.emptyFilter", { q: esc(state.logFilter) }) : t("log.empty", { level: state.logLevel })}</div>`;
    log.scrollTop = log.scrollHeight;
  };
  let traceClock = 0;
  const pushTrace = (lv, msg) => {
    traceClock += 0.13 + (traceLines.length % 5) * 0.21;
    const line = { lv, msg, ts: traceClock.toFixed(2).padStart(6, "0") };
    traceLines.push(line);
    if (traceLines.length > 60) traceLines = traceLines.slice(-60);
    const log = $("#trace-log");
    if (!log) return;
    const shown = visibleTraceLines();
    if (!shown.includes(line)) return; // filtered out - nothing to show
    log.querySelector(".tracelog-empty")?.remove();
    log.insertAdjacentHTML("beforeend", traceLineHtml(line));
    while (log.children.length > shown.length) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
  };
  const seedTrace = (sc) => {
    traceLines = []; traceClock = 0;
    const log = $("#trace-log");
    if (log) log.innerHTML = ""; // reseed replaces the log wholesale
    const cfg = MODE_CFG[state.mode];
    const seed = state.mode === "apply" ? applyInput().seed : MODE_SEEDS[state.mode];
    const counts = { complete: 7, empty: 1, fault: 7, ready: 7, running: 5, staging: 4 };
    seed.slice(0, counts[sc] ?? 2).forEach((l) => pushTrace(l.lv, l.msg));
    if (sc === "fault") {
      const faultTrace = state.mode === "apply" ? applyInput().faultTrace : cfg.faultTrace;
      faultTrace.forEach(([lv, msg]) => pushTrace(lv, msg));
    }
    if (sc === "complete") {
      jobIO(state.mode).plan.forEach((s) => stageTraceFor(state.mode, s.id).forEach((l) => pushTrace(l.lv, l.msg)));
      pushTrace("info", `done: ${planTotal(state.mode).toFixed(2)}s wall, ${CORES} threads`);
    }
    if (!visibleTraceLines().length) renderTrace(); // nothing passed the filters - show the empty-state line
  };

  /* footer meta: thread count + live memory (when the browser exposes it) */
  const renderEnv = () => {
    $("#sv-threads").textContent = `${CORES} ${t("env.threads")}`;
    const mem = $("#sv-mem");
    if (mem) { const h = readHeap(); mem.hidden = !h; mem.textContent = h || ""; }
  };
  /* live memory: performance.memory is Chrome-only (JS heap). The real app is
     cross-origin isolated for SAB, so it can use the standards-track
     performance.measureUserAgentSpecificMemory() plus wasm Memory.buffer.byteLength.
     Returns "" when unavailable so the footer entry hides. */
  const readHeap = () => {
    const m = performance.memory;
    if (!m) return "";
    const unit = state.units === "MiB" ? "MiB" : "MB";
    const div = state.units === "MiB" ? 1048576 : 1e6;
    return `${(m.usedJSHeapSize / div).toFixed(0)} / ${(m.jsHeapSizeLimit / div).toFixed(0)} ${unit}`;
  };
  setInterval(renderEnv, 2000);

  /* ── status strip + inspector state ── */
  const renderStatus = () => {
    const cfg = MODE_CFG[state.mode];
    const sc = state.scenario;
    const KIND = { complete: "done", dragging: "idle", empty: "idle", fault: "failed", ready: "ready", running: "running", staging: "staging" };
    const kind = KIND[sc] || "idle";
    const msg = (() => {
      // ready shows no message - the state chip already says ready, and the
      // footer never describes the staged ROMs/patches (that's the form's job)
      if (sc === "fault") return t("status.faultMsg", { code: cfg.fault.code, stage: t(`stage.${jobIO(state.mode).plan[cfg.faultIdx].id}`) });
      if (sc === "complete") return t("status.doneMsg", { t: totalLabel(state.mode) });
      if (sc === "staging") return t("drop.staging");
      return "";
    })();
    const cls = kind === "running" || kind === "done" || kind === "failed" || kind === "ready" ? kind : "";
    $("#sv-state").className = `sv-state ${cls}`;
    $("#sv-state-text").textContent = t(`status.${kind}`);
    // running shows no footer message - progress lives in the run panel only
    $("#sv-stage").textContent = msg;
  };

  /* running/failed panel state (drives the live meter weave) */
  const renderPanelState = () => {
    $$(".workflow").forEach((w) => w.classList.remove("running", "failed"));
    const panel = $(`#panel-${state.mode}`);
    panel.classList.toggle("running", state.scenario === "running");
    panel.classList.toggle("failed", state.scenario === "fault");
  };

  /* ════════ simulated run (per-mode plan, class-scoped elements) ════════ */
  const stopRun = () => {
    if (state.runTimer) { cancelAnimationFrame(state.runTimer); state.runTimer = null; }
  };
  const startRun = () => {
    stopRun();
    state.runStart = performance.now();
    let lastStage = -1;
    const runMode = state.mode;
    const cfg = MODE_CFG[runMode];
    const io = jobIO(runMode);
    const total = planTotal(runMode);
    const tick = () => {
      if (state.mode !== runMode || state.scenario !== "running") { stopRun(); return; }
      const elapsed = (performance.now() - state.runStart) / 1000;
      const sim = elapsed * (reducedMotion() ? 3 : 1);
      if (sim >= total) {
        // let the meter visibly reach 100% before the panel morphs into the
        // download button - completion reads as earned, not as a cut
        stopRun();
        const panelEl = $(`#panel-${runMode}`);
        const fillEl = $(".run-fill", panelEl);
        if (fillEl) {
          // glide the last stretch to 100% instead of snapping it
          fillEl.style.transition = "width .24s cubic-bezier(.22, .9, .26, 1)";
          fillEl.style.width = "100%";
          $(".run-pct", panelEl).textContent = "100%";
          $(".run-pbar", panelEl)?.setAttribute("aria-valuenow", "100");
        }
        setTimeout(() => {
          if (state.mode === runMode && state.scenario === "running") setScenario("complete");
        }, reducedMotion() ? 0 : 280);
        return;
      }
      let acc = 0, idx = 0;
      for (let i = 0; i < io.plan.length; i += 1) {
        if (sim < acc + io.plan[i].dur) { idx = i; break; }
        acc += io.plan[i].dur;
      }
      const pct = Math.min(99, Math.round((sim / total) * 100));
      const panel = $(`#panel-${runMode}`);
      const fill = $(".run-fill", panel);
      if (fill) {
        // UNROUNDED width per frame - whole-percent steps land ~90ms apart on
        // a long run and read as stutter; the text/aria keep the rounded value
        fill.style.width = `${Math.min(99.5, (sim / total) * 100)}%`;
        $(".run-pct", panel).textContent = `${pct}%`;
        const stageName = t(`stage.${io.plan[idx].id}`);
        $(".run-stage-label", panel).textContent = `${stageName} - ${io.runFile(idx)}`;
        $(".run-pbar", panel)?.setAttribute("aria-valuenow", String(pct));
      }
      if (idx !== lastStage) {
        lastStage = idx;
        stageTraceFor(runMode, io.plan[idx].id).forEach((l) => pushTrace(l.lv, l.msg));
      }
      state.runTimer = requestAnimationFrame(tick);
    };
    state.runTimer = requestAnimationFrame(tick);
  };

  /* the result total counts up in pure CSS: a registered --t custom property
     animates 0 → centiseconds and CSS counters render "9.44s" (see .total-time
     rules). JS only stamps the target value + the locale's decimal separator. */
  const decSep = () => new Intl.NumberFormat(state.locale).format(1.1).charAt(1);

  /* ════════ drawers + output-name field ════════ */
  /* drawer open/close is pure CSS (grid-rows on .cks-body) - JS only flips the
     state class + aria-expanded */
  const wireDrawers = () => {
    document.addEventListener("input", (e) => {
      if (e.target instanceof HTMLTextAreaElement && e.target.classList.contains("outname")) autoSizeOutname(e.target);
    });
    // the output name is a textarea only so it can grow - a filename must never
    // contain a newline, so Enter is swallowed (paste is sanitized on input)
    document.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target instanceof HTMLTextAreaElement && e.target.classList.contains("outname")) e.preventDefault();
    });
    document.addEventListener("click", (e) => {
      const head = e.target instanceof Element ? e.target.closest(".cks-head") : null;
      if (!head) return;
      const box = head.closest(".cks");
      const open = !box.classList.contains("is-open");
      box.classList.toggle("is-open", open);
      head.setAttribute("aria-expanded", String(open));
    });
  };

  /* ════════ settings dialog ════════ */
  const renderSettings = () => {
    const sel = (label, id, options, selected, infoKey) => `
      <div class="setrow"><span class="slabel"><label for="${id}">${label}</label>${infoKey ? info(infoKey) : ""}</span>
        <select class="select" id="${id}">${options.map((o) => `<option${o === selected ? " selected" : ""}>${o}</option>`).join("")}</select></div>`;
    /* a combo box (editable input + datalist) when `suggestions` is given -
       matching the live UI's codec fields; else a plain text input */
    const txt = (label, id, value, ph, infoKey, suggestions) => {
      const listId = suggestions ? `${id}-list` : "";
      return `<div class="setrow"><span class="slabel"><label for="${id}">${label}</label>${infoKey ? info(infoKey) : ""}</span>
        <input class="input mono${suggestions ? " combo" : ""}" id="${id}" value="${value}" placeholder="${ph || ""}"${listId ? ` list="${listId}"` : ""} />${listId ? `<datalist id="${listId}">${suggestions.map((s) => `<option value="${s}"></option>`).join("")}</datalist>` : ""}</div>`;
    };
    const chk = (label, id, on, infoKey) => `<span class="optrow"><label class="popt"><input type="checkbox" role="switch" id="${id}"${on ? " checked" : ""} /> ${label}</label>${infoKey ? info(infoKey) : ""}</span>`;
    $("#settings-body").innerHTML = `
      <div class="setgroup">
        <div class="gtitle">${t("settings.general")}</div>
        <div class="setrow"><span class="slabel"><label for="set-lang">${t("settings.language")}</label></span>
          <select class="select" id="set-lang">
            <option value="en"${state.locale === "en" ? " selected" : ""}>English</option>
            <option value="es"${state.locale === "es" ? " selected" : ""}>Español</option>
            <option value="de"${state.locale === "de" ? " selected" : ""}>Deutsch</option>
          </select></div>
        ${sel(t("settings.logLevel"), "set-loglevel", ["trace", "debug", "info", "warn", "error"], "info")}
        ${sel(t("settings.units"), "set-units", ["MB", "MiB"], state.units, "info.units")}
        <div class="setchecks">${chk(t("settings.devTools"), "set-devtools", false)}</div>
      </div>
      <div class="setgroup">
        <div class="gtitle">${t("settings.fixes")}</div>
        <div class="setchecks">${chk(t("settings.fixChecksum"), "set-fixheader", true, "info.fixHeader")}</div>
      </div>
      <div class="setgroup">
        <div class="gtitle">${t("settings.verification")}${info("info.verification")}</div>
        <div class="setchecks">
          ${chk(t("settings.requireInput"), "set-require-in", true)}
          ${chk(t("settings.requireOutput"), "set-require-out", true)}
        </div>
      </div>
      <div class="setgroup">
        <div class="gtitle">${t("settings.compression")}</div>
        ${sel(t("settings.defaultCompression"), "set-defcomp", ["zip", "7z", "chd", "rvz", "none"], "7z")}
        <div class="srange">
          <div class="srange-head"><span class="slabel"><label for="set-profile">${t("settings.profile")}</label>${info("info.level")}</span><span class="v" id="set-profile-v">${t("scale.max")}</span></div>
          <input type="range" id="set-profile" min="0" max="6" step="1" value="6" />
          <div class="srange-scale" aria-hidden="true"><span>${t("scale.min")}</span><span>${t("scale.medium")}</span><span>${t("scale.max")}</span></div>
        </div>
        ${txt(t("settings.workerThreads"), "set-threads", "", `auto (${CORES})`, "info.threads")}
        <p class="sethint">${t("settings.threadsHint", { n: CORES })}</p>
      </div>
      <div class="setcols">
        <div class="setgroup">
          <div class="gtitle">${t("settings.codecs")}</div>
          ${txt(t("settings.zipCodec"), "set-zip", "deflate", "", "info.zipCodec", ["deflate", "zstd", "store"])}
          ${txt(t("settings.sevenZipCodec"), "set-7z", "lzma2", "", "info.sevenZipCodec", ["lzma2"])}
          ${txt(t("settings.rvzCodec"), "set-rvzc", "zstd", "", "info.rvzCodec", ["zstd", "zstd:22", "zstd:-7"])}
          ${txt(t("settings.chdCd"), "set-chdcd", "cdlz,cdzl,cdfl", "", "info.chdCd", ["cdlz", "cdzl", "cdfl"])}
          ${txt(t("settings.chdDvd"), "set-chddvd", "lzma,zlib,huff,flac", "", "info.chdDvd", ["lzma", "zlib", "huff", "flac"])}
        </div>
        <div class="setgroup">
          <div class="gtitle">${t("settings.rvz")}</div>
          ${sel(t("settings.rvzBlockSize"), "set-rvzbs", ["128 KiB", "256 KiB", "1 MiB", "2 MiB"], "128 KiB", "info.rvzBlock")}
        </div>
      </div>
      <div class="validation" id="settings-validation" role="alert" hidden>${t("settings.validation")}</div>`;
    $("#set-profile").addEventListener("input", (e) => {
      const labels = PROFILES.map((pr) => t(`scale.${pr}`));
      $("#set-profile-v").textContent = labels[Number(e.target.value)] || "";
    });
    /* language applies on Save, like every other setting (the dialog close handler reads it) */
    $("#set-threads").addEventListener("input", (e) => {
      const v = e.target.value.trim();
      const bad = v !== "" && v !== "auto" && !(/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 64);
      $("#settings-validation").hidden = !bad;
      e.target.setAttribute("aria-invalid", bad ? "true" : "false");
    });
    restoreSettings();
  };

  /* settings persist across reloads (prototype-local) */
  const SETTINGS_KEY = "rw-settings";
  const readSavedSettings = () => {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
  };
  const saveSettings = () => {
    const data = {};
    for (const el of $$("#settings-body input, #settings-body select")) {
      if (!el.id || el.id === "set-lang") continue;
      data[el.id] = el.type === "checkbox" ? el.checked : el.value;
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  };
  const restoreSettings = () => {
    const saved = readSavedSettings();
    for (const [id, value] of Object.entries(saved)) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.type === "checkbox") el.checked = value === true;
      else el.value = String(value);
    }
    $("#set-profile")?.dispatchEvent(new Event("input"));
  };

  /* ════════ scenarios + global render ════════ */
  const SCENARIOS = ["empty", "dragging", "staging", "ready", "running", "fault", "complete"];

  /* output-name fields grow with their content instead of truncating; pasted
     newlines collapse to spaces (a filename can't contain a line break).
     Growth is CSS field-sizing where supported - the JS measure is the fallback */
  const FIELD_SIZING = CSS.supports("field-sizing", "content");
  const autoSizeOutname = (el) => {
    if (/[\r\n]/.test(el.value)) el.value = el.value.replace(/[\r\n]+/g, " ");
    if (FIELD_SIZING) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  const sizeAllOutnames = () => $$(".outname").forEach(autoSizeOutname);

  /* only the VISIBLE panel renders eagerly - rebuilding all three inside a view
     transition's update callback cost ~80ms frames; hidden panels are marked
     dirty and render lazily when their tab is opened (setMode) */
  const PANEL_RENDERERS = { apply: renderApply, create: renderCreate, trim: renderTrim };
  const dirtyPanels = new Set();
  const renderPanels = () => {
    PANEL_RENDERERS[state.mode]();
    for (const m of MODES) if (m !== state.mode) dirtyPanels.add(m);
    dirtyPanels.delete(state.mode);
  };
  const renderAll = () => {
    renderPanels();
    $("#app").classList.toggle("page-dragging", state.scenario === "dragging");
    sizeAllOutnames();
    seedTrace(state.scenario);
    renderEnv();
    renderStatus();
    renderPanelState();
    renderDockScenarios();
    translateStatic();
    if (state.scenario === "running") startRun();
  };

  /* scenario re-renders run inside a view transition so elements that persist
     across states MORPH instead of blinking: the reading card settles into its
     card (vt-rom / vt-<pid>), the live run panel becomes the download button
     (vt-action). Entry animations are suppressed for the duration (vt-quiet) so
     the morph isn't fighting card-in replays. Returns when the DOM is updated. */
  /* entry animations (card-in/panel-in/…) must play ONCE per render, never on a
     display toggle (tab switch un-hides a panel → CSS restarts its animations →
     blink) and never when vt-quiet is removed after a transition (re-enabling a
     suppressed animation starts it). The inline lock survives both; re-renders
     create fresh elements, so genuinely new content still animates in. */
  const ENTRY_ANIMS = new Set(["card-in", "panel-in", "drop-in", "chip-in", "fault-in", "trace-in"]);
  document.addEventListener("animationend", (e) => {
    if (ENTRY_ANIMS.has(e.animationName) && e.target instanceof HTMLElement) e.target.style.animation = "none";
  });
  const lockEntryAnimations = () => {
    // the done-chips are deliberately NOT locked here - their stagger outlives
    // the transition; the animationend listener locks each as it lands
    for (const el of $$(".workflow-body, .card, .notice, .result, .prog-panel, .fault")) {
      el.style.animation = "none";
    }
  };

  const withViewTransition = (update, opts = {}) => {
    if (reducedMotion() || !document.startViewTransition || document.documentElement.dataset.vtOff) {
      update();
      return Promise.resolve();
    }
    // flat: suppress the per-element morph names - a plain crossfade for
    // changes with no real continuity (e.g. switching modes)
    const classes = ["vt-quiet", ...(opts.flat ? ["vt-flat"] : [])];
    document.documentElement.classList.add(...classes);
    const vt = document.startViewTransition(update);
    // a transition interrupted by the next one rejects ready/finished with
    // "Transition was skipped" - that's normal flow here, not an error
    const clear = () => {
      lockEntryAnimations(); // BEFORE un-suppressing, or they'd start now
      document.documentElement.classList.remove(...classes);
    };
    vt.ready.catch(() => {});
    vt.finished.then(clear, clear);
    return vt.updateCallbackDone.catch(() => {});
  };

  /* transitions touching the empty/drag-over layouts have NO element
     continuity - a morph would send the (disabled) run button and cards flying
     across the layout change and float them above the drop veil. Those go FLAT
     (plain crossfade); everything else keeps the morphs. */
  const FLAT_SCENARIOS = new Set(["empty", "dragging"]);
  const setScenario = (sc) => {
    stopRun();
    clearTimeout(state.stagingTimer);
    if (sc === "empty") state.extraPatches = [];
    const prev = state.scenario;
    state.scenario = sc;
    const flat = FLAT_SCENARIOS.has(sc) || FLAT_SCENARIOS.has(prev);
    const done = withViewTransition(renderAll, { flat });
    announce(t("announce.scenario", { name: t(`scenario.${sc}`) }));
    return done;
  };

  const THEME_COLORS = { dark: "#0c0f13", light: "#e8e7e2" };
  const translateStatic = () => {
    document.documentElement.lang = state.locale;
    const theme = document.documentElement.dataset.theme;
    $("#meta-theme")?.setAttribute("content", THEME_COLORS[theme] || THEME_COLORS.dark);
    $$("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
    $$("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
    $$("[data-i18n-ph]").forEach((el) => { el.setAttribute("placeholder", t(el.dataset.i18nPh)); });
    const themeBtn = $("#theme-toggle");
    const dark = document.documentElement.dataset.theme === "dark";
    themeBtn.setAttribute("aria-label", t(dark ? "theme.toLight" : "theme.toDark"));
  };

  const setLocale = (locale) => {
    state.locale = locale;
    localStorage.setItem("rw-locale", locale);
    renderAll();
    renderSettings();
    $$("#dock-locales .dock-btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.locale === locale)));
  };

  /* banner slide open/closed is pure CSS now (.reveal grid-rows + two-beat
     opacity + display allow-discrete) - this only flips the class + hidden.
     Setting hidden during the exit is safe: the display transition keeps the
     element rendered until the collapse finishes. */
  const slideToggle = (el, show) => {
    if (show === el.classList.contains("is-open")) return;
    if (show) el.hidden = false;
    el.classList.toggle("is-open", show);
    if (!show) el.hidden = true;
  };

  /* ════════ patch reorder: pointer drag with FLIP-style shifts ════════ */
  const wireReorder = () => {
    document.addEventListener("pointerdown", (e) => {
      const handle = e.target instanceof Element ? e.target.closest("[data-drag]") : null;
      if (!handle || handle.disabled) return;
      const card = handle.closest("[data-pid]");
      if (!card) return;
      const list = card.parentElement;
      const cards = Array.from(list.querySelectorAll(":scope > [data-pid]"));
      if (cards.length < 2) return;
      e.preventDefault();
      try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic or already-released pointer */ }
      document.body.style.userSelect = "none";
      // on touch, pointer capture alone doesn't stop the page from scrolling -
      // a non-passive touchmove blocker keeps the drag from being cancelled by
      // the browser's scroll gesture (so reordering works on mobile)
      const blockTouchScroll = (ev) => ev.preventDefault();
      window.addEventListener("touchmove", blockTouchScroll, { passive: false });
      // read the REAL list gap - a hardcoded value drifts from the stylesheet
      // (the patch list uses 16px) and left settled cards a few px off after
      // the drag, causing a tiny correction jump on commit
      const GAP = parseFloat(getComputedStyle(list).rowGap) || 13;
      const startY = e.clientY;
      const rects = new Map(cards.map((c) => [c, c.getBoundingClientRect()]));
      const fromIdx = cards.indexOf(card);
      const dragH = rects.get(card).height + GAP;
      card.classList.add("rw-dragging");
      for (const c of cards) if (c !== card) c.classList.add("rw-shifting");
      let toIdx = fromIdx;
      const onMove = (ev) => {
        const dy = ev.clientY - startY;
        card.style.transform = `translateY(${dy}px)`;
        // use the dragged card's leading EDGE, not its centre - the swap fires
        // as soon as that edge reaches a neighbour's midpoint, so a short drag
        // (about half a card) reorders instead of needing to drag fully past it
        const dragTop = rects.get(card).top + dy;
        const dragBottom = rects.get(card).bottom + dy;
        toIdx = fromIdx;
        cards.forEach((c, i) => {
          if (c === card) return;
          const r = rects.get(c);
          const mid = r.top + r.height / 2;
          if (i > fromIdx && dragBottom > mid) toIdx = Math.max(toIdx, i);
          if (i < fromIdx && dragTop < mid) toIdx = Math.min(toIdx, i);
        });
        cards.forEach((c, i) => {
          if (c === card) return;
          let shift = 0;
          if (fromIdx < toIdx && i > fromIdx && i <= toIdx) shift = -dragH;
          else if (toIdx < fromIdx && i >= toIdx && i < fromIdx) shift = dragH;
          c.style.transform = shift ? `translateY(${shift}px)` : "";
        });
      };
      const finish = (commit) => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("touchmove", blockTouchScroll);
        document.body.style.userSelect = "";
        let delta = 0;
        if (commit && toIdx !== fromIdx) {
          const sign = toIdx > fromIdx ? 1 : -1;
          const lo = Math.min(fromIdx, toIdx);
          const hi = Math.max(fromIdx, toIdx);
          for (let i = lo; i <= hi; i += 1) {
            if (i === fromIdx) continue;
            delta += sign * (rects.get(cards[i]).height + GAP);
          }
        }
        card.classList.remove("rw-dragging");
        card.classList.add("rw-settling");
        card.style.transform = `translateY(${delta}px)`;
        window.setTimeout(() => {
          // commit by moving the node - re-rendering would replay entry
          // animations (flicker) and close open drawers
          if (commit && toIdx !== fromIdx) {
            const order = cards.map((c) => c.dataset.pid);
            order.splice(toIdx, 0, order.splice(fromIdx, 1)[0]);
            state.patchOrder[state.input] = order;
            // re-inserting a node restarts its CSS entry animation - suppress it
            card.style.animation = "none";
            list.insertBefore(card, toIdx > fromIdx ? cards[toIdx].nextSibling : cards[toIdx]);
            announce(t("announce.reordered", { n: toIdx + 1 }));
          }
          for (const c of cards) {
            c.classList.remove("rw-shifting", "rw-settling");
            c.style.transform = "";
          }
        }, reducedMotion() ? 0 : 190);
      };
      const onUp = () => finish(true);
      const onCancel = () => finish(false);
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onCancel);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const handle = e.target instanceof Element && e.target.matches("[data-drag]") ? e.target : null;
      if (!handle || handle.disabled) return;
      e.preventDefault();
      const card = handle.closest("[data-pid]");
      const cards = Array.from(card.parentElement.querySelectorAll(":scope > [data-pid]"));
      const idx = cards.indexOf(card);
      const to = e.key === "ArrowUp" ? idx - 1 : idx + 1;
      if (to < 0 || to >= cards.length) return;
      const order = cards.map((c) => c.dataset.pid);
      order.splice(to, 0, order.splice(idx, 1)[0]);
      state.patchOrder[state.input] = order;
      // the cards carry vt-<pid> names - a view transition morphs the swap,
      // replacing the old hand-rolled FLIP measurement/animation
      const list = card.parentElement;
      withViewTransition(() => {
        list.insertBefore(card, e.key === "ArrowUp" ? cards[to] : cards[to].nextSibling);
      }).then(() => {
        handle.focus();
        announce(t("announce.reordered", { n: to + 1 }));
      });
    });
  };

  /* ════════ real drag & drop + click-to-browse ════════ */
  const PATCH_EXTS = new Set(["aps", "bdf", "bps", "ips", "ppf", "rup", "ups", "vcdiff", "xdelta"]);
  const fileExt = (name) => (name.split(".").pop() || "").toLowerCase();
  /* one ring pulse on an element - acknowledges a drop landing / points the eye
     at the 0x01 input. Re-trigger safe (reflow restarts the animation). */
  const pulseTarget = (el) => {
    if (!el || reducedMotion()) return;
    el.classList.remove("pulse-target");
    void el.offsetWidth;
    el.classList.add("pulse-target");
    el.addEventListener("animationend", () => el.classList.remove("pulse-target"), { once: true });
  };
  const stageDroppedFiles = (files) => {
    if (!files.length) return;
    const patchFiles = files.filter((f) => PATCH_EXTS.has(fileExt(f.name)));
    const patchOnly = state.mode === "apply" && patchFiles.length === files.length;
    const patchList = $("#panel-apply .patch-cards");
    for (const f of files.slice(0, 4)) {
      pushTrace("info", `drop: ${f.name} · ${fmtSize(f.size)}${PATCH_EXTS.has(fileExt(f.name)) ? " → patch" : ""}`);
    }
    if (files.length > 4) pushTrace("debug", `drop: +${files.length - 4} more files`);
    if (patchOnly && patchList && state.scenario !== "running") {
      // in-place: append a parsing card, then settle it into a real patch card -
      // no scenario takeover, the rest of the form never re-mounts. The card
      // carries the next extra pid so the settle re-render MORPHS it in place.
      const idx = patchList.querySelectorAll(".card").length;
      patchList.insertAdjacentHTML("beforeend", renderReadingCard(idx, patchFiles[0].name, "patch.parsing", `extra${state.extraPatches.length}`));
      pulseTarget(patchList.lastElementChild);
      clearTimeout(state.stagingTimer);
      state.stagingTimer = setTimeout(() => {
        state.extraPatches = [
          ...state.extraPatches,
          ...patchFiles.slice(0, 3).map((f) => ({ fmt: fileExt(f.name).toUpperCase(), name: f.name, size: fmtSize(f.size) })),
        ].slice(0, 4);
        withViewTransition(() => {
          renderApply(true);
          renderStatus();
        });
      }, reducedMotion() ? 200 : 900);
      announce(t("drop.staging"));
      return;
    }
    state.extraPatches = [];
    state.stagingFrom = state.scenario === "staging" ? state.stagingFrom : state.scenario;
    setScenario("staging").then(() => pulseTarget($(".workflow:not([hidden]) .step.is-input .drop")));
    state.stagingTimer = setTimeout(() => setScenario("ready"), reducedMotion() ? 400 : 1900);
  };
  const wireDnd = () => {
    const isFileDrag = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    let clearTimer;
    document.addEventListener("dragover", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      $("#app").classList.add("page-dragging");
      clearTimeout(clearTimer);
      clearTimer = setTimeout(() => $("#app").classList.remove("page-dragging"), 140);
    });
    document.addEventListener("drop", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      clearTimeout(clearTimer);
      $("#app").classList.remove("page-dragging");
      if (document.querySelector("dialog[open]")) return;
      stageDroppedFiles(Array.from(e.dataTransfer.files || []));
    });
    // click / Enter / Space on any dropzone opens a real picker
    const picker = document.createElement("input");
    picker.type = "file";
    picker.multiple = true;
    picker.hidden = true;
    picker.setAttribute("aria-hidden", "true");
    picker.tabIndex = -1;
    document.body.append(picker);
    picker.addEventListener("change", () => {
      if (picker.files?.length) stageDroppedFiles(Array.from(picker.files));
      picker.value = "";
    });
    // toggle a patch on/off IN PLACE - collapse/expand the card, no full re-render
    document.addEventListener("change", (e) => {
      const cb = e.target instanceof Element ? e.target.closest("[data-enable]") : null;
      if (!cb) return;
      const key = `${state.input}:${cb.dataset.enable}`;
      if (state.patchToggles.has(key)) state.patchToggles.delete(key);
      else state.patchToggles.add(key);
      const card = cb.closest(".card[data-pid]");
      if (card) card.classList.toggle("is-disabled", !cb.checked);
      // update the "N patches off" note in place (no re-render) - slides
      // open/closed instead of popping, like the banners
      const note = $(".workflow:not([hidden]) .patch-off-note");
      if (note) {
        const off = $$(".workflow:not([hidden]) .patch-cards .card.is-disabled").length;
        const span = note.querySelector("span");
        if (off && span) span.textContent = tCount("patch.offCount", off);
        slideToggle(note.closest(".reveal"), off > 0);
      }
      // refresh the patches step-header badges (enabled count / off / enabled size)
      const meta = $(".workflow:not([hidden]) .step-meta:has(.rb)");
      if (meta) meta.innerHTML = patchStepMeta(applyInput(), false);
      // the run button counts enabled patches - keep its label + disabled state in sync
      const runBtn = $(".workflow:not([hidden]) .run-btn");
      if (runBtn) {
        const enabled = buildPatchItems(applyInput(), false).filter((it) => !it.disabled).length;
        runBtn.disabled = enabled === 0;
        const span = runBtn.querySelector("span");
        if (span) span.textContent = MODE_CFG.apply.runLabel();
      }
    });
    document.addEventListener("click", (e) => {
      if (!(e.target instanceof Element)) return;
      // a "needs input" directive adds files just like the 0x01 dropzone - the
      // picked files go through the same stageDroppedFiles auto-sort flow; the
      // 0x01 surface pulses so the eye lands where the files will arrive
      if (e.target.closest("[data-goto-input]")) {
        const dropEl = $(".workflow:not([hidden]) .step.is-input .drop");
        dropEl?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "nearest" });
        pulseTarget(dropEl);
        picker.click();
        return;
      }
      if (e.target.closest(".drop:not(.staging)")) {
        picker.click();
        return;
      }
      // only the file-requesting surfaces (dropzone + "add files" directives,
      // both handled above) open the picker on click - NOT the whole page.
      // Dropping files anywhere on the page still works (the page-wide drop handler).
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target instanceof Element && e.target.classList.contains("drop") && !e.target.classList.contains("staging")) {
        e.preventDefault();
        picker.click();
      }
    });
  };

  /* ════════ tabs ════════ */
  const MODES = ["apply", "create", "trim"];
  /* with CSS anchor positioning the thumb pins itself to the selected tab and
     resize/font-swap reposition natively - this JS measure is only the
     fallback for browsers without anchors. The slide between tabs rides the
     mode-switch view transition either way (vt-thumb). */
  const ANCHORED_THUMB = CSS.supports("anchor-name", "--rw-tab");
  let thumbReady = false;
  const positionThumb = (animate = false) => {
    if (ANCHORED_THUMB) return;
    const sel = $(".mode[aria-selected='true']");
    const thumb = $(".mode-thumb");
    if (!sel || !thumb) return;
    if (!animate) thumb.style.transition = "none";
    thumb.style.left = `${sel.offsetLeft}px`;
    thumb.style.width = `${sel.offsetWidth}px`;
    if (!animate) requestAnimationFrame(() => { thumb.style.transition = ""; });
  };
  const setMode = (mode, focus) => {
    // already on this tab - re-clicking must not replay the transition
    if (thumbReady && mode === state.mode) return;
    const wasRunning = state.scenario === "running";
    stopRun();
    state.mode = mode;
    // the panel swap runs inside a FLAT view transition (plain crossfade - the
    // panels have no real continuity), replacing the old panel-in replay that
    // made every switch blink from opacity 0
    const update = () => {
      $$(".mode").forEach((tab) => {
        const on = tab.dataset.mode === mode;
        tab.setAttribute("aria-selected", String(on));
        tab.tabIndex = on ? 0 : -1;
        if (on && focus) tab.focus();
      });
      // panels render lazily - catch up if this one went stale while hidden
      if (dirtyPanels.has(mode)) {
        PANEL_RENDERERS[mode]();
        dirtyPanels.delete(mode);
        sizeAllOutnames();
      }
      MODES.forEach((m) => { const p = $(`#panel-${m}`); p.hidden = m !== mode; });
    };
    const after = () => {
      positionThumb(thumbReady && !reducedMotion());
      if (location.hash.slice(1) !== mode) {
        if (thumbReady) location.hash = mode;
        else history.replaceState(null, "", `#${mode}`);
      }
      thumbReady = true;
      // the log and status strip mirror the active mode's job
      seedTrace(state.scenario);
      renderStatus();
      renderPanelState();
      if (wasRunning) startRun();
    };
    if (!thumbReady) { update(); after(); return; } // boot paint - no transition
    withViewTransition(update, { flat: true }).then(after);
  };
  const wireTabs = () => {
    $$(".mode").forEach((tab) => tab.addEventListener("click", () => setMode(tab.dataset.mode)));
    $(".mode-rail").addEventListener("keydown", (e) => {
      const order = MODES;
      const cur = order.indexOf(state.mode);
      let next = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (cur + 1) % order.length;
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (cur + order.length - 1) % order.length;
      if (e.key === "Home") next = 0;
      if (e.key === "End") next = order.length - 1;
      if (next >= 0) { e.preventDefault(); setMode(order[next], true); }
    });
    window.addEventListener("resize", positionThumb);
    if (document.fonts?.ready) document.fonts.ready.then(positionThumb);
    window.addEventListener("hashchange", () => {
      const m = location.hash.slice(1);
      if (MODES.includes(m) && m !== state.mode) setMode(m);
    });
  };

  /* ════════ theme ════════ */
  /* every theme change wipes in from the toggle button - the origin is read
     from the button itself, so no click event is needed and ANY caller (the
     toggle, an OS preference change, a future setting) animates identically */
  const setTheme = (next, { persist = true } = {}) => {
    const root = document.documentElement;
    if (root.dataset.theme === next) return;
    if (persist) localStorage.setItem("rw-theme", next);
    const apply = () => { root.dataset.theme = next; translateStatic(); };
    if (!document.startViewTransition || reducedMotion()) { apply(); return; }
    // the wipe must cover EVERYTHING - vt-theme suppresses the per-element
    // morph names so cards don't split into their own crossfading groups.
    // The animation itself is the CSS theme-wipe keyframe; JS only feeds it
    // the circle origin/radius via custom properties.
    const r = $("#theme-toggle").getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const end = Math.hypot(Math.max(cx, innerWidth - cx), Math.max(cy, innerHeight - cy));
    root.style.setProperty("--wipe-x", `${cx}px`);
    root.style.setProperty("--wipe-y", `${cy}px`);
    root.style.setProperty("--wipe-r", `${end}px`);
    root.classList.add("vt-theme");
    const vt = document.startViewTransition(apply);
    vt.ready.catch(() => { /* interrupted - theme still applied */ });
    const unTheme = () => root.classList.remove("vt-theme");
    vt.finished.then(unTheme, unTheme);
  };
  const wireTheme = () => {
    $("#theme-toggle").addEventListener("click", () =>
      setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
    // follow the OS while the user hasn't chosen explicitly - same wipe, no click
    matchMedia("(prefers-color-scheme: light)").addEventListener("change", (e) => {
      if (localStorage.getItem("rw-theme")) return;
      setTheme(e.matches ? "light" : "dark", { persist: false });
    });
  };

  /* ════════ dialogs ════════ */
  let pendingConfirm = null;
  const openConfirm = ({ title, body, confirmLabel, danger = true }, onConfirm) => {
    const dlg = $("#confirm-dialog");
    $("#confirm-title").textContent = title;
    dlg.querySelector(".dlg-copy").textContent = body;
    const btn = dlg.querySelector('button[value="confirm"]');
    btn.textContent = confirmLabel;
    btn.classList.toggle("danger", danger);
    btn.classList.toggle("primary", !danger);
    pendingConfirm = onConfirm;
    dlg.showModal();
  };
  const wireDialog = (dlg) => {
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close("cancel"); });
  };
  const wireDialogs = () => {
    const settings = $("#settings-dialog");
    const confirm = $("#confirm-dialog");
    const update = $("#update-dialog");
    [settings, confirm, update].forEach(wireDialog);
    confirm.addEventListener("close", () => {
      const cb = pendingConfirm;
      pendingConfirm = null;
      if (confirm.returnValue === "confirm" && cb) cb();
    });
    $("#open-settings").addEventListener("click", () => { renderSettings(); settings.showModal(); });
    settings.addEventListener("close", () => {
      if (settings.returnValue !== "save") return;
      saveSettings();
      const units = readSavedSettings()["set-units"];
      let dirty = false;
      if (units && units !== state.units) {
        state.units = units;
        dirty = true;
      }
      const lang = $("#set-lang")?.value;
      if (lang && lang !== state.locale) {
        setLocale(lang); // re-renders everything, units change included
        return;
      }
      if (dirty) renderAll();
    });
    const logDlg = $("#log-dialog");
    wireDialog(logDlg);
    const logLevelSel = $("#log-level");
    if (logLevelSel) logLevelSel.value = state.logLevel;
    const logFilterInput = $("#log-filter");
    $("#open-log").addEventListener("click", () => { renderTrace(); logDlg.showModal(); logFilterInput?.focus(); });
    logLevelSel?.addEventListener("change", () => { state.logLevel = logLevelSel.value; renderTrace(); });
    logFilterInput?.addEventListener("input", () => { state.logFilter = logFilterInput.value; renderTrace(); });
    $("#settings-reset").addEventListener("click", () => {
      localStorage.removeItem(SETTINGS_KEY);
      renderSettings();
      announce(t("settings.reset"));
    });
    $("#changelog").innerHTML = CHANGELOG.map((c) => `<li><span class="cl-tag ${c.tag}">${c.tag}</span><span>${esc(c.text)}</span></li>`).join("");
    $("#update-details").addEventListener("click", () => update.showModal());
    $("#update-reload").addEventListener("click", () => { slideToggle($("#update-banner"), false); state.updateBanner = false; syncDockToggles(); });
    $("#update-dismiss").addEventListener("click", () => { slideToggle($("#update-banner"), false); state.updateBanner = false; syncDockToggles(); });
    $("#wakelock-dismiss").addEventListener("click", () => { slideToggle($("#wakelock-notice"), false); state.wakeLock = false; syncDockToggles(); });
    update.addEventListener("close", () => {
      if (update.returnValue === "reload") { slideToggle($("#update-banner"), false); state.updateBanner = false; syncDockToggles(); }
    });
  };

  /* ════════ copy + run interactions (event delegation) ════════ */
  const flashCopied = (btn) => {
    if (btn) {
      btn.classList.add("copied");
      setTimeout(() => btn.classList.remove("copied"), 1300);
    }
    announce(t("announce.copied"));
  };
  /* clipboard works over https/localhost; on a LAN IP (insecure origin)
     navigator.clipboard is undefined, so fall back to a throwaway textarea +
     execCommand so copy still works when the prototype is opened on a phone */
  const copyText = (text) => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
      return;
    }
    fallbackCopy(text);
  };
  const fallbackCopy = (text) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.contentEditable = "true";
    ta.readOnly = false;
    // keep it on-screen-ish but invisible; iOS won't copy a fully offscreen node
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0";
    document.body.appendChild(ta);
    // iOS Safari needs an explicit Range selection, not just textarea.select()
    const range = document.createRange();
    range.selectNodeContents(ta);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    ta.setSelectionRange(0, text.length);
    try {
      document.execCommand("copy");
    } catch {
      /* nothing else to try */
    }
    sel?.removeAllRanges();
    ta.remove();
  };
  const wireCopy = () => {
    document.addEventListener("click", (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      const cueBtn = target.closest("[data-copy-cue]");
      if (cueBtn) {
        e.preventDefault();
        e.stopPropagation();
        copyText(cueBtn.closest(".cue-sub")?.querySelector(".cue-text")?.textContent || "");
        flashCopied(cueBtn);
        return;
      }
      const ck = target.closest(".ck[data-copy]");
      if (ck) {
        copyText(ck.dataset.copy);
        flashCopied(ck.querySelector(".copy"));
        return;
      }
      if (target.closest("[data-copy-report]")) {
        const cfg = MODE_CFG[state.mode];
        const stage = jobIO(state.mode).plan[cfg.faultIdx].id;
        copyText(`rom-weaver report\ncode: ${cfg.fault.code}\nstage: ${stage}\nmode: ${state.mode}`);
        announce(t("announce.copied"));
        return;
      }
      if (target.closest("[data-retry]")) { setScenario("ready"); return; }
      // swap which staged file is Original vs Modified - the content-keyed vt
      // names make the two cards morph past each other
      if (target.closest(".swap-btn")) {
        withViewTransition(() => {
          state.createSwapped = !state.createSwapped;
          renderCreate();
        });
        return;
      }
      if (target.closest(".run-btn")) {
        if (state.mode === "trim") {
          openConfirm({ title: t("confirm.trimTitle"), body: t("confirm.trimBody"), confirmLabel: t("confirm.trimConfirm"), danger: false }, () => setScenario("running"));
        } else setScenario("running");
        return;
      }
      if (target.closest(".run-cancel")) { setScenario("ready"); return; }
      const stageCancel = target.closest(".stage-cancel");
      if (stageCancel) {
        clearTimeout(state.stagingTimer);
        if (state.scenario === "staging") {
          setScenario(state.stagingFrom && state.stagingFrom !== "staging" ? state.stagingFrom : "ready");
        } else {
          stageCancel.closest(".card")?.remove();
        }
        return;
      }
      if (target.closest("#trace-copy")) {
        copyText(visibleTraceLines().map((l) => `${l.ts} ${l.lv} ${l.msg}`).join("\n"));
        flashCopied(target.closest("#trace-copy"));
        return;
      }
      // a single log line copies itself on click (ts · level · caller · message)
      const ln = target.closest("#trace-log .ln");
      if (ln) {
        copyText([...ln.children].map((c) => c.textContent).join(" "));
        ln.classList.add("copied");
        setTimeout(() => ln.classList.remove("copied"), 1200);
        announce(t("announce.copied"));
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const target = e.target instanceof Element ? e.target.closest(".ck[data-copy]") : null;
      if (target) {
        e.preventDefault();
        copyText(target.dataset.copy);
        flashCopied(target.querySelector(".copy"));
      }
    });
  };

  /* ════════ archive candidate picker ════════ */
  const PICKER_CANDIDATES = [
    { checked: true, name: "Castlevania - Symphony of the Night (USA).cue", size: "631.1 MiB", tag: "CUE", path: ["Castlevania Collection.rar", "SOTN (USA).7z"] },
    { name: "Castlevania - Symphony of the Night (Japan).cue", size: "628.4 MiB", tag: "CUE", path: ["Castlevania Collection.rar", "SOTN (Japan).7z"] },
    { disabled: true, name: "scans/manual.pdf", size: "14.2 MiB", tag: "", path: ["Castlevania Collection.rar"] },
  ];
  const renderPicker = () => {
    // the title IS the archive name - the hint below already says what to do
    $("#picker-title").textContent = "Castlevania Collection.rar";
    $("#picker-hint").textContent = t("picker.hint");
    /* tag + size ride a meta line UNDER the name so the file name and its
       archive path get the full row width (long names were unusable on mobile).
       selection is the ROW itself: the checkbox is visually hidden (still real,
       so keyboard + SR work) and the highlight + tick carry the checked state */
    $("#pick-list").innerHTML = PICKER_CANDIDATES.map((c, i) => `
      <label class="pick-row${c.disabled ? " skip" : ""}">
        <input class="pick-input" type="checkbox" name="pick" value="${i}"${c.checked ? " checked" : ""}${c.disabled ? " disabled" : ""} />
        <span class="pick-main">
          ${c.path?.length ? `<span class="pick-crumb mono">${c.path.map((p) => esc(p)).join(" › ")} ›</span>` : ""}
          <span class="pick-name mono">${esc(c.name)}</span>
          <span class="pick-meta">${c.tag ? `<span class="tag fmt">${c.tag}</span>` : `<span class="tag">${t("picker.skipped")}</span>`}<span class="pick-size mono">${fmtSizeStr(c.size)}</span></span>
        </span>
      </label>`).join("");
  };

  /* ════════ info popovers ════════ */
  const closeInfoPops = (except) => {
    $$('.info-btn[aria-expanded="true"]').forEach((b) => {
      if (b === except) return;
      b.setAttribute("aria-expanded", "false");
      if (b.nextElementSibling) b.nextElementSibling.hidden = true;
    });
  };
  const wireInfo = () => {
    document.addEventListener("click", (e) => {
      const btn = e.target instanceof Element ? e.target.closest("[data-info]") : null;
      closeInfoPops(btn);
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const pop = btn.nextElementSibling;
      const open = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!open));
      if (pop) pop.hidden = open;
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeInfoPops(null); });
  };

  /* ════════ scenario dock ════════ */
  const renderDockScenarios = () => {
    const wrap = $("#dock-scenarios");
    wrap.innerHTML = SCENARIOS.map((sc) => `<button class="dock-btn" type="button" data-scenario="${sc}" aria-pressed="${String(sc === state.scenario)}">${t(`scenario.${sc}`)}</button>`).join("");
    $("#dock-inputs").innerHTML = ["disc", "gdi", "single"]
      .map((input) => `<button class="dock-btn" type="button" data-input="${input}" aria-pressed="${String(input === state.input)}">${t(`input.${input}`)}</button>`)
      .join("");
  };
  const syncDockToggles = () => {
    $("#dock-update-banner").setAttribute("aria-pressed", String(state.updateBanner));
    $("#dock-wakelock").setAttribute("aria-pressed", String(state.wakeLock));
  };
  const wireDock = () => {
    // on a phone the open panel would overlay the form and steal taps - start it
    // collapsed so only the "Prototype" pill shows; the user opens it on demand
    if (window.matchMedia("(max-width: 860px)").matches) {
      $("#dock-panel").setAttribute("data-closed", "");
      $("#dock-toggle").setAttribute("aria-expanded", "false");
    }
    $("#dock-toggle").addEventListener("click", () => {
      const panel = $("#dock-panel");
      const closed = panel.hasAttribute("data-closed");
      panel.toggleAttribute("data-closed", !closed);
      $("#dock-toggle").setAttribute("aria-expanded", String(closed));
    });
    $("#dock-scenarios").addEventListener("click", (e) => {
      const btn = e.target instanceof Element ? e.target.closest("[data-scenario]") : null;
      if (btn) setScenario(btn.dataset.scenario);
    });
    $("#dock-inputs").addEventListener("click", (e) => {
      const btn = e.target instanceof Element ? e.target.closest("[data-input]") : null;
      if (!btn) return;
      stopRun();
      state.input = btn.dataset.input;
      renderAll();
    });
    $("#dock-update-banner").addEventListener("click", () => {
      state.updateBanner = !state.updateBanner;
      slideToggle($("#update-banner"), state.updateBanner);
      syncDockToggles();
    });
    $("#dock-wakelock").addEventListener("click", () => {
      state.wakeLock = !state.wakeLock;
      slideToggle($("#wakelock-notice"), state.wakeLock);
      syncDockToggles();
    });
    $("#dock-open-picker").addEventListener("click", () => { renderPicker(); $("#picker-dialog").showModal(); });
    $("#dock-open-settings").addEventListener("click", () => { renderSettings(); $("#settings-dialog").showModal(); });
    // the dock's confirm preview behaves like a real "remove all": confirming clears the bench
    $("#dock-open-confirm").addEventListener("click", () =>
      openConfirm({ title: t("confirm.title"), body: t("confirm.body"), confirmLabel: t("confirm.confirm") }, () => setScenario("empty")));
    $("#dock-open-update").addEventListener("click", () => $("#update-dialog").showModal());
    const locales = [["en", "English"], ["es", "Español"], ["de", "Deutsch"]];
    $("#dock-locales").innerHTML = locales
      .map(([code, name]) => `<button class="dock-btn" type="button" data-locale="${code}" aria-pressed="${String(code === state.locale)}">${name}</button>`)
      .join("");
    $("#dock-locales").addEventListener("click", (e) => {
      const btn = e.target instanceof Element ? e.target.closest("[data-locale]") : null;
      if (btn) setLocale(btn.dataset.locale);
    });
  };

  /* ════════ boot ════════ */
  wireTabs();
  wireTheme();
  wireDialogs();
  wireCopy();
  wireReorder();
  wireDnd();
  wireInfo();
  wireDrawers();
  wireDock();
  state.units = readSavedSettings()["set-units"] || "MB";
  renderSettings();
  setMode(MODES.includes(location.hash.slice(1)) ? location.hash.slice(1) : "apply");
  renderAll();

  /* prototype-only hook so the bundled a11y checker (a11y.js) can drive every
     mode/scenario through axe-core. SCENARIOS minus the transient "dragging". */
  window.__rwA11y = {
    modes: MODES,
    scenarios: SCENARIOS.filter((s) => s !== "dragging"),
    setMode: (m) => setMode(m),
    setScenario: (s) => setScenario(s),
    snapshot: () => ({ mode: state.mode, scenario: state.scenario }),
  };
})();
