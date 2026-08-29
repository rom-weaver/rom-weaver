//! The installed identify database: the per-user pack directory, the platform
//! catalog over it, lazy pack loading, and the `identify database`
//! subcommands (list/status/path/remove/install-all/install-group).

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use rom_weaver_checksum::identify_catalog::{IdentifyCatalog, IdentifyPlatformCatalogEntry};
use rom_weaver_checksum::identify_pack::IdentifyPackFile;

use super::*;

/// A parsed RWFP4 identify pack tagged with its display name.
pub(super) struct LoadedPack {
    pub(super) name: String,
    pub(super) file: IdentifyPackFile,
}

/// The identify database directory: env override, then the platform data dir.
#[cfg(not(target_arch = "wasm32"))]
pub(super) fn default_database_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("ROM_WEAVER_DATA_DIR") {
        return Ok(PathBuf::from(dir).join("identify"));
    }
    let base = if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share"))
            })
    };
    let base = base.ok_or_else(|| {
        RomWeaverError::Validation(
            "cannot resolve the identify database directory: no home directory; pass --database-dir"
                .to_string(),
        )
    })?;
    Ok(base.join("rom-weaver").join("identify"))
}

/// Provider over one command invocation's identify databases: the builtin
/// OpenGood packs, plus a database directory of installed packs with an
/// optional `catalog.json`. Packs parse once, lazily, cached by slug.
pub(super) struct IdentifyPackProvider {
    database_dir: PathBuf,
    dir_catalog: Option<IdentifyCatalog>,
    cache: RefCell<HashMap<String, Rc<LoadedPack>>>,
}

impl IdentifyPackProvider {
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn new(database_dir: Option<PathBuf>) -> Result<Self> {
        let database_dir = match database_dir {
            Some(dir) => dir,
            None => default_database_dir()?,
        };
        let catalog_path = database_dir.join("catalog.json");
        let dir_catalog = if catalog_path.is_file() {
            let bytes = fs::read(&catalog_path).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to read identify catalog `{}`: {error}",
                    catalog_path.display()
                ))
            })?;
            Some(IdentifyCatalog::parse(&bytes)?)
        } else {
            None
        };
        trace!(
            database_dir = %database_dir.display(),
            has_catalog = dir_catalog.is_some(),
            "identify pack provider initialized"
        );
        Ok(Self {
            database_dir,
            dir_catalog,
            cache: RefCell::new(HashMap::new()),
        })
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn database_dir(&self) -> &Path {
        &self.database_dir
    }

    /// Resolve a platform name or alias: the database dir's catalog first,
    /// then the builtin OpenGood catalog.
    pub(super) fn resolve_entry(&self, name: &str) -> Option<IdentifyPlatformCatalogEntry> {
        if let Some(catalog) = &self.dir_catalog
            && let Some(entry) = catalog.resolve_platform(name)
        {
            return Some(entry.clone());
        }
        IdentifyCatalog::builtin().resolve_platform(name).cloned()
    }

    /// Every catalog entry: the database dir's entries plus builtin entries it
    /// does not override, sorted by canonical platform.
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn catalog_entries(&self) -> Vec<IdentifyPlatformCatalogEntry> {
        let mut entries: Vec<IdentifyPlatformCatalogEntry> = self
            .dir_catalog
            .as_ref()
            .map(|catalog| catalog.entries().to_vec())
            .unwrap_or_default();
        for builtin in IdentifyCatalog::builtin().entries() {
            if !entries
                .iter()
                .any(|entry| entry.canonical_platform == builtin.canonical_platform)
            {
                entries.push(builtin.clone());
            }
        }
        entries.sort_by(|a, b| a.canonical_platform.cmp(&b.canonical_platform));
        entries
    }

    /// Whether the slug's pack is available (installed in the dir, or builtin).
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn pack_installed(&self, slug: &str) -> bool {
        self.database_dir.join(format!("{slug}.pack")).is_file()
            || super::identify_builtin::pack_path(&self.database_dir, slug).is_some()
    }

    /// Load one slug's pack, cached. `Ok(None)` when no such pack exists; a
    /// present pack that fails to parse is an error naming the pack path.
    pub(super) fn pack_for_slug(&self, slug: &str) -> Result<Option<Rc<LoadedPack>>> {
        if let Some(cached) = self.cache.borrow().get(slug) {
            trace!(slug, "identify pack cache hit");
            return Ok(Some(Rc::clone(cached)));
        }
        let path = self.database_dir.join(format!("{slug}.pack"));
        let (name, bytes) = if path.is_file() {
            trace!(slug, path = %path.display(), "identify pack cache miss; loading from database dir");
            let bytes = fs::read(&path).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to read ROM identify pack `{}`: {error}",
                    path.display()
                ))
            })?;
            // The dir catalog records each pack's sha256 at import time; a pack
            // that no longer matches it MUST fail loading, not parse silently.
            #[cfg(not(target_arch = "wasm32"))]
            if let Some(catalog) = &self.dir_catalog
                && let Some(expected) = catalog
                    .entries()
                    .iter()
                    .find(|entry| entry.pack_slug == slug)
                    .and_then(|entry| entry.pack_sha256.as_deref())
            {
                let actual = sha256_hex(&bytes);
                if actual != expected {
                    return Err(RomWeaverError::Validation(format!(
                        "ROM identify pack `{}` does not match its catalog sha256 \
                         (expected {expected}, found {actual}); re-import or remove it",
                        path.display()
                    )));
                }
            }
            (format!("{slug}.pack"), bytes)
        } else if let Some(packaged) = super::identify_builtin::pack_path(&self.database_dir, slug)
        {
            trace!(slug, path = %packaged.display(), "identify pack cache miss; decompressing packaged pack");
            (
                format!("{slug}.pack"),
                super::identify_builtin::decompress(&packaged)?,
            )
        } else {
            trace!(slug, "identify pack not installed");
            return Ok(None);
        };
        let file = IdentifyPackFile::parse(&bytes).map_err(|error| {
            RomWeaverError::Validation(format!("invalid ROM identify pack `{name}`: {error}"))
        })?;
        if !matches!(file, IdentifyPackFile::V4(_)) {
            return Err(RomWeaverError::Validation(format!(
                "invalid ROM identify pack `{name}`: expected RWFP4"
            )));
        }
        let pack = Rc::new(LoadedPack { name, file });
        self.cache
            .borrow_mut()
            .insert(slug.to_string(), Rc::clone(&pack));
        Ok(Some(pack))
    }

    /// Every available pack: each installed `*.pack` in the database dir plus
    /// every builtin pack whose slug the dir does not shadow. Sorted by name.
    pub(super) fn all_packs(&self) -> Result<Vec<Rc<LoadedPack>>> {
        let mut slugs: Vec<String> = Vec::new();
        if self.database_dir.is_dir() {
            for entry in fs::read_dir(&self.database_dir).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to read identify database dir `{}`: {error}",
                    self.database_dir.display()
                ))
            })? {
                let entry = entry.map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to read identify database dir `{}`: {error}",
                        self.database_dir.display()
                    ))
                })?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if let Some(slug) = name.strip_suffix(".pack") {
                    slugs.push(slug.to_string());
                }
            }
        }
        for slug in super::identify_builtin::pack_slugs(&self.database_dir)? {
            if !slugs.iter().any(|existing| existing == &slug) {
                slugs.push(slug);
            }
        }
        slugs.sort();
        let mut packs = Vec::with_capacity(slugs.len());
        for slug in slugs {
            if let Some(pack) = self.pack_for_slug(&slug)? {
                packs.push(pack);
            }
        }
        Ok(packs)
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn sha256_hex(bytes: &[u8]) -> String {
    let mut stream = rom_weaver_checksum::StreamingChecksum::new(&["sha256".to_string()])
        .ok()
        .flatten()
        .expect("sha256 is a supported algorithm");
    stream.update(bytes).expect("sha256 update never fails");
    stream
        .finalize()
        .expect("sha256 finalize never fails")
        .remove("sha256")
        .expect("sha256 value present")
}

// ---------------------------------------------------------------------------
// Subcommand runners
// ---------------------------------------------------------------------------

impl CliApp {
    pub(super) fn run_identify_database(&self, command: IdentifyDatabaseCommands) -> AppRunOutcome {
        #[cfg(target_arch = "wasm32")]
        {
            let _ = command;
            return self.finish(
                "identify",
                OperationReport::failed(
                    OperationFamily::Command,
                    Some("identify-database".to_string()),
                    "identify-database",
                    "identify database commands are not supported in the browser build",
                    None,
                ),
            );
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            let report = self
                .run_identify_database_inner(command)
                .unwrap_or_else(|error| {
                    OperationReport::failed(
                        OperationFamily::Command,
                        Some("identify-database".to_string()),
                        "identify-database",
                        error.to_string(),
                        None,
                    )
                });
            self.finish("identify", report)
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn run_identify_database_inner(
        &self,
        command: IdentifyDatabaseCommands,
    ) -> Result<OperationReport> {
        match command {
            IdentifyDatabaseCommands::List(args) => {
                let provider = IdentifyPackProvider::new(args.database_dir)?;
                let entries: Vec<Value> = provider
                    .catalog_entries()
                    .iter()
                    .map(|entry| {
                        json!({
                            "platform": entry.canonical_platform,
                            "source": entry.source,
                            "installed": provider.pack_installed(&entry.pack_slug),
                            "pack_format": entry.pack_format,
                            "pack_slug": entry.pack_slug,
                        })
                    })
                    .collect();
                let installed = entries
                    .iter()
                    .filter(|entry| entry["installed"] == json!(true))
                    .count();
                let mut report = OperationReport::succeeded(
                    OperationFamily::Command,
                    Some("identify-database".to_string()),
                    "list",
                    format!("{} platform(s), {installed} installed", entries.len()),
                    Some(100.0),
                    None,
                );
                report.details = Some(json!({
                    "database_dir": provider.database_dir().to_string_lossy(),
                    "platforms": entries,
                }));
                Ok(report)
            }
            IdentifyDatabaseCommands::Status(args) => {
                let provider = IdentifyPackProvider::new(args.database_dir)?;
                let mut packs = Vec::new();
                let dir = provider.database_dir();
                if dir.is_dir() {
                    let mut names: Vec<String> = fs::read_dir(dir)
                        .map_err(|error| {
                            RomWeaverError::Validation(format!(
                                "failed to read identify database dir `{}`: {error}",
                                dir.display()
                            ))
                        })?
                        .filter_map(|entry| entry.ok())
                        .map(|entry| entry.file_name().to_string_lossy().into_owned())
                        .filter(|name| name.ends_with(".pack"))
                        .collect();
                    names.sort();
                    for name in names {
                        let path = dir.join(&name);
                        let bytes = fs::read(&path).map_err(|error| {
                            RomWeaverError::Validation(format!(
                                "failed to read ROM identify pack `{}`: {error}",
                                path.display()
                            ))
                        })?;
                        let format = if matches!(
                            IdentifyPackFile::parse(&bytes),
                            Ok(IdentifyPackFile::V4(_))
                        ) {
                            "RWFP4"
                        } else {
                            "invalid"
                        };
                        packs.push(json!({
                            "slug": name.trim_end_matches(".pack"),
                            "format": format,
                            "bytes": bytes.len(),
                            "sha256": sha256_hex(&bytes),
                        }));
                    }
                }
                let mut report = OperationReport::succeeded(
                    OperationFamily::Command,
                    Some("identify-database".to_string()),
                    "status",
                    format!("{} installed pack(s)", packs.len()),
                    Some(100.0),
                    None,
                );
                report.details = Some(json!({
                    "database_dir": dir.to_string_lossy(),
                    "packs": packs,
                }));
                Ok(report)
            }
            IdentifyDatabaseCommands::Path(args) => {
                let provider = IdentifyPackProvider::new(args.database_dir)?;
                let dir = provider.database_dir().to_string_lossy().into_owned();
                let mut report = OperationReport::succeeded(
                    OperationFamily::Command,
                    Some("identify-database".to_string()),
                    "path",
                    dir.clone(),
                    Some(100.0),
                    None,
                );
                report.details = Some(json!({ "database_dir": dir }));
                Ok(report)
            }
            IdentifyDatabaseCommands::Remove(args) => {
                let provider = IdentifyPackProvider::new(args.database_dir)?;
                let entry = provider.resolve_entry(&args.system).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "unknown system `{}`; run `rom-weaver identify database list` for the catalog",
                        args.system
                    ))
                })?;
                let path = provider
                    .database_dir()
                    .join(format!("{}.pack", entry.pack_slug));
                if !path.is_file() {
                    return Err(RomWeaverError::Validation(format!(
                        "no installed pack for `{}` at `{}`",
                        entry.canonical_platform,
                        path.display()
                    )));
                }
                fs::remove_file(&path).map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to remove `{}`: {error}",
                        path.display()
                    ))
                })?;
                let mut report = OperationReport::succeeded(
                    OperationFamily::Command,
                    Some("identify-database".to_string()),
                    "remove",
                    format!("removed the {} pack", entry.canonical_platform),
                    Some(100.0),
                    None,
                );
                report.details = Some(json!({
                    "platform": entry.canonical_platform,
                    "removed": path.to_string_lossy(),
                }));
                Ok(report)
            }
            IdentifyDatabaseCommands::InstallAll(args) => {
                let provider = IdentifyPackProvider::new(args.database_dir)?;
                let count = super::identify_builtin::install_all(provider.database_dir())?;
                let mut report = OperationReport::succeeded(
                    OperationFamily::Command,
                    Some("identify-database".to_string()),
                    "install-all",
                    format!("installed {count} identify pack(s)"),
                    Some(100.0),
                    None,
                );
                report.details = Some(json!({
                    "database_dir": provider.database_dir().to_string_lossy(),
                    "packs": count,
                    "version": env!("CARGO_PKG_VERSION"),
                }));
                Ok(report)
            }
            IdentifyDatabaseCommands::InstallGroup(args) => {
                let provider = IdentifyPackProvider::new(args.database_dir)?;
                let count = super::identify_builtin::install_group(
                    provider.database_dir(),
                    &args.group,
                    args.from.as_deref(),
                )?;
                let mut report = OperationReport::succeeded(
                    OperationFamily::Command,
                    Some("identify-database".to_string()),
                    "install-group",
                    format!(
                        "installed {count} identify pack(s) from group `{}`",
                        args.group
                    ),
                    Some(100.0),
                    None,
                );
                report.details = Some(json!({
                    "database_dir": provider.database_dir().to_string_lossy(),
                    "group": args.group,
                    "packs": count,
                    "version": env!("CARGO_PKG_VERSION"),
                }));
                Ok(report)
            }
        }
    }
}
