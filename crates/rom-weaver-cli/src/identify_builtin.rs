#[cfg(not(target_arch = "wasm32"))]
use std::fs;
#[cfg(not(target_arch = "wasm32"))]
use std::io::Read;
#[cfg(not(target_arch = "wasm32"))]
use std::path::{Path, PathBuf};

#[cfg(not(target_arch = "wasm32"))]
use rom_weaver_core::{Result, RomWeaverError};

#[cfg(not(target_arch = "wasm32"))]
const USER_FULL_DATA_DIR: &str = "full-v1";
#[cfg(not(target_arch = "wasm32"))]
const ARCHIVE_PREFIX: &str = "share/rom-weaver/identify/v1";
#[cfg(not(target_arch = "wasm32"))]
const MAX_PACK_BYTES: u64 = 256 * 1024 * 1024;
#[cfg(not(target_arch = "wasm32"))]
const MAX_EXTRACTED_BYTES: u64 = 1024 * 1024 * 1024;

#[cfg(all(
    not(target_arch = "wasm32"),
    any(feature = "bundled-identify-data", test)
))]
const DATA_RELATIVE_PATH: &str = "share/rom-weaver/identify/v1";

#[cfg(all(
    not(target_arch = "wasm32"),
    any(feature = "bundled-identify-data", test)
))]
fn candidate_data_dirs(executable: &Path) -> Vec<PathBuf> {
    let Some(bin_dir) = executable.parent() else {
        return Vec::new();
    };
    let mut dirs = vec![bin_dir.join(DATA_RELATIVE_PATH)];
    if let Some(prefix) = bin_dir.parent() {
        let installed = prefix.join(DATA_RELATIVE_PATH);
        if installed != dirs[0] {
            dirs.push(installed);
        }
    }
    dirs
}

#[cfg(all(not(target_arch = "wasm32"), feature = "bundled-identify-data"))]
fn data_dirs() -> Vec<PathBuf> {
    std::env::current_exe()
        .map(|executable| candidate_data_dirs(&executable))
        .unwrap_or_default()
}

/// Every data tree that can hold `catalog.json`, `index.json`, and `packs/`,
/// in lookup order: the user install first, then the packaged trees beside the
/// executable.
#[cfg(all(not(target_arch = "wasm32"), feature = "bundled-identify-data"))]
pub(super) fn data_roots(database_dir: &Path) -> Vec<PathBuf> {
    let mut roots = vec![database_dir.join(USER_FULL_DATA_DIR)];
    roots.extend(data_dirs());
    roots
}

#[cfg(all(not(target_arch = "wasm32"), not(feature = "bundled-identify-data")))]
pub(super) fn data_roots(_database_dir: &Path) -> Vec<PathBuf> {
    Vec::new()
}

/// The `catalog.json` of the first data tree that has one. The generated
/// catalog names the slugs the packaged packs actually use, so a build that
/// ships data MUST prefer it over the built-in fallback catalog.
#[cfg(not(target_arch = "wasm32"))]
pub(super) fn catalog_path(database_dir: &Path) -> Option<PathBuf> {
    data_roots(database_dir)
        .into_iter()
        .map(|root| root.join("catalog.json"))
        .find(|path| path.is_file())
}

#[cfg(all(not(target_arch = "wasm32"), feature = "bundled-identify-data"))]
pub(super) fn pack_path(database_dir: &Path, slug: &str) -> Option<PathBuf> {
    let file = format!("{slug}.pack.br");
    data_roots(database_dir)
        .into_iter()
        .map(|root| root.join("packs").join(&file))
        .find(|path| path.is_file())
}

#[cfg(any(target_arch = "wasm32", not(feature = "bundled-identify-data")))]
pub(super) fn pack_path(
    _database_dir: &std::path::Path,
    _slug: &str,
) -> Option<std::path::PathBuf> {
    None
}

#[cfg(all(not(target_arch = "wasm32"), feature = "bundled-identify-data"))]
pub(super) fn pack_slugs(database_dir: &Path) -> Result<Vec<String>> {
    let mut slugs = Vec::new();
    let dirs = data_roots(database_dir)
        .into_iter()
        .map(|root| root.join("packs"));
    for dir in dirs.filter(|dir| dir.is_dir()) {
        for entry in fs::read_dir(&dir).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to read packaged identify data `{}`: {error}",
                dir.display()
            ))
        })? {
            let entry = entry.map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to read packaged identify data `{}`: {error}",
                    dir.display()
                ))
            })?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(slug) = name.strip_suffix(".pack.br")
                && !slugs.iter().any(|existing| existing == slug)
            {
                slugs.push(slug.to_string());
            }
        }
    }
    slugs.sort();
    Ok(slugs)
}

#[cfg(any(target_arch = "wasm32", not(feature = "bundled-identify-data")))]
pub(super) fn pack_slugs(_database_dir: &std::path::Path) -> rom_weaver_core::Result<Vec<String>> {
    Ok(Vec::new())
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn decompress(path: &Path) -> Result<Vec<u8>> {
    let compressed_size = fs::metadata(path)?.len();
    check_pack_size(compressed_size, "compressed")?;
    let bytes = fs::read(path).map_err(|error| {
        RomWeaverError::Validation(format!(
            "failed to read packaged identify pack `{}`: {error}",
            path.display()
        ))
    })?;
    let entry = pack_index_entry(path)?;
    check_pack_size(entry.raw_bytes, "decompressed")?;
    if compressed_size != entry.brotli_bytes {
        return Err(RomWeaverError::Validation(format!(
            "pack `{}` has an invalid compressed size",
            entry.brotli_file
        )));
    }
    if sha256(&bytes) != entry.brotli_sha256 {
        return Err(RomWeaverError::Validation(format!(
            "pack `{}` has an invalid compressed sha256",
            entry.brotli_file
        )));
    }
    let decompressed = decompress_bytes(
        &bytes,
        &path.display().to_string(),
        usize::try_from(entry.raw_bytes).map_err(|_| {
            RomWeaverError::Validation("identify pack size does not fit this platform".to_string())
        })?,
    )?;
    verify_raw_pack(&entry, &decompressed)?;
    Ok(decompressed)
}

/// Decompress a Brotli pack that has no `index.json` entry to check it
/// against, such as a file passed to `--database`. The size cap is the only
/// guard here, so it MUST stay in place: the input is user-supplied and a
/// Brotli frame can expand without bound.
#[cfg(not(target_arch = "wasm32"))]
pub(super) fn decompress_standalone(bytes: &[u8], label: &str) -> Result<Vec<u8>> {
    let decoder = brotli::Decompressor::new(bytes, 4096);
    let mut decompressed = Vec::new();
    decoder
        .take(MAX_PACK_BYTES.saturating_add(1))
        .read_to_end(&mut decompressed)
        .map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to decompress identify pack `{label}`: {error}"
            ))
        })?;
    check_pack_size(decompressed.len() as u64, "decompressed")?;
    Ok(decompressed)
}

#[cfg(target_arch = "wasm32")]
pub(super) fn decompress_standalone(
    _bytes: &[u8],
    label: &str,
) -> rom_weaver_core::Result<Vec<u8>> {
    Err(rom_weaver_core::RomWeaverError::Validation(format!(
        "identify pack `{label}` is Brotli compressed; this build reads raw packs only"
    )))
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackIndex {
    systems: Vec<PackIndexEntry>,
    #[serde(default)]
    groups: Vec<PackGroup>,
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackIndexEntry {
    #[serde(default)]
    slug: String,
    file: String,
    raw_bytes: u64,
    sha256: String,
    brotli_file: String,
    brotli_bytes: u64,
    brotli_sha256: String,
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackGroup {
    id: String,
    #[serde(default)]
    default: bool,
    systems: Vec<String>,
}

#[cfg(not(target_arch = "wasm32"))]
fn sha256(bytes: &[u8]) -> String {
    let mut checksum = rom_weaver_checksum::StreamingChecksum::new(&["sha256".to_string()])
        .expect("sha256 setup")
        .expect("sha256 support");
    checksum.update(bytes).expect("sha256 update");
    checksum
        .finalize()
        .expect("sha256 finalize")
        .remove("sha256")
        .expect("sha256 result")
}

#[cfg(not(target_arch = "wasm32"))]
fn pack_index_entry(path: &Path) -> Result<PackIndexEntry> {
    let root = path.parent().and_then(Path::parent).ok_or_else(|| {
        RomWeaverError::Validation(format!(
            "invalid packaged identify path `{}`",
            path.display()
        ))
    })?;
    let index_path = root.join("index.json");
    let index: PackIndex = serde_json::from_slice(&fs::read(&index_path).map_err(|error| {
        RomWeaverError::Validation(format!(
            "failed to read `{}`: {error}",
            index_path.display()
        ))
    })?)
    .map_err(|error| {
        RomWeaverError::Validation(format!(
            "invalid identify index `{}`: {error}",
            index_path.display()
        ))
    })?;
    let relative = format!(
        "packs/{}",
        path.file_name().unwrap_or_default().to_string_lossy()
    );
    index
        .systems
        .into_iter()
        .find(|entry| entry.brotli_file == relative)
        .ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "pack `{relative}` is missing from `{}`",
                index_path.display()
            ))
        })
}

#[cfg(not(target_arch = "wasm32"))]
fn verify_raw_pack(entry: &PackIndexEntry, raw: &[u8]) -> Result<()> {
    if raw.len() as u64 != entry.raw_bytes || sha256(raw) != entry.sha256 {
        return Err(RomWeaverError::Validation(format!(
            "pack `{}` has invalid decompressed data",
            entry.file
        )));
    }
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
fn check_pack_size(size: u64, kind: &str) -> Result<()> {
    if size > MAX_PACK_BYTES {
        return Err(RomWeaverError::Validation(format!(
            "identify pack {kind} size {size} exceeds the {MAX_PACK_BYTES}-byte limit"
        )));
    }
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
fn extract_archive<R: std::io::Read>(reader: R, destination: &Path) -> Result<()> {
    let decoder = brotli::Decompressor::new(reader, 4096);
    let mut archive = tar::Archive::new(decoder);
    let mut extracted_bytes = 0_u64;
    for item in archive.entries().map_err(|error| {
        RomWeaverError::Validation(format!("invalid identify data archive: {error}"))
    })? {
        let mut entry = item.map_err(|error| {
            RomWeaverError::Validation(format!("invalid identify data archive entry: {error}"))
        })?;
        let path = entry
            .path()
            .map_err(|error| {
                RomWeaverError::Validation(format!("invalid identify data archive path: {error}"))
            })?
            .into_owned();
        if entry.header().entry_type().is_dir() && archive_directory_allowed(&path) {
            continue;
        }
        if !entry.header().entry_type().is_file() {
            return Err(RomWeaverError::Validation(format!(
                "identify data archive entry `{}` is not a regular file",
                path.display()
            )));
        }
        let entry_size = entry.header().size().map_err(|error| {
            RomWeaverError::Validation(format!("invalid identify data archive size: {error}"))
        })?;
        check_archive_entry_size(entry_size, &mut extracted_bytes)?;
        let relative = archive_relative_path(&path)?;
        let target = destination.join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        entry.unpack(&target).map_err(|error| {
            RomWeaverError::Validation(format!("failed to extract `{}`: {error}", path.display()))
        })?;
    }
    if !destination.join("index.json").is_file() || !destination.join("catalog.json").is_file() {
        return Err(RomWeaverError::Validation(
            "identify data archive is incomplete".to_string(),
        ));
    }
    let catalog = fs::read(destination.join("catalog.json"))?;
    rom_weaver_checksum::identify_catalog::IdentifyCatalog::parse(&catalog)?;
    let index: PackIndex = serde_json::from_slice(&fs::read(destination.join("index.json"))?)
        .map_err(|error| RomWeaverError::Validation(format!("invalid identify index: {error}")))?;
    for entry in &index.systems {
        let relative = Path::new(&entry.brotli_file);
        if relative.parent() != Some(Path::new("packs"))
            || relative
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err(RomWeaverError::Validation(format!(
                "invalid identify index pack path `{}`",
                entry.brotli_file
            )));
        }
        let path = destination.join(relative);
        if !path.is_file() {
            return Err(RomWeaverError::Validation(format!(
                "identify data archive is missing `{}`",
                entry.brotli_file
            )));
        }
        decompress(&path)?;
    }
    for entry in fs::read_dir(destination.join("packs"))? {
        let path = entry?.path();
        decompress(&path)?;
    }
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
fn check_archive_entry_size(size: u64, extracted_bytes: &mut u64) -> Result<()> {
    check_pack_size(size, "archive entry")?;
    *extracted_bytes = extracted_bytes.checked_add(size).ok_or_else(|| {
        RomWeaverError::Validation("identify data archive size overflow".to_string())
    })?;
    if *extracted_bytes > MAX_EXTRACTED_BYTES {
        return Err(RomWeaverError::Validation(format!(
            "identify data archive exceeds the {MAX_EXTRACTED_BYTES}-byte extracted limit"
        )));
    }
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
fn archive_directory_allowed(path: &Path) -> bool {
    [
        "share",
        "share/rom-weaver",
        "share/rom-weaver/identify",
        ARCHIVE_PREFIX,
        "share/rom-weaver/identify/v1/packs",
    ]
    .iter()
    .any(|allowed| path == Path::new(allowed))
}

#[cfg(not(target_arch = "wasm32"))]
fn archive_relative_path(path: &Path) -> Result<PathBuf> {
    let relative = path.strip_prefix(ARCHIVE_PREFIX).map_err(|_| {
        RomWeaverError::Validation(format!(
            "unexpected identify data archive path `{}`",
            path.display()
        ))
    })?;
    let allowed = relative == Path::new("index.json")
        || relative == Path::new("catalog.json")
        || (relative.parent() == Some(Path::new("packs"))
            && relative
                .file_name()
                .is_some_and(|name| name.to_string_lossy().ends_with(".pack.br")));
    if !allowed
        || relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(RomWeaverError::Validation(format!(
            "unexpected identify data archive path `{}`",
            path.display()
        )));
    }
    Ok(relative.to_path_buf())
}

#[cfg(not(target_arch = "wasm32"))]
fn validate_group_id(group: &str) -> Result<()> {
    if group.is_empty()
        || !group
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    {
        return Err(RomWeaverError::Validation(format!(
            "invalid identify pack group `{group}`; use lowercase letters, digits, and hyphens"
        )));
    }
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
fn read_json_object(path: &Path) -> Result<serde_json::Map<String, serde_json::Value>> {
    let value: serde_json::Value = serde_json::from_slice(&fs::read(path).map_err(|error| {
        RomWeaverError::Validation(format!("failed to read `{}`: {error}", path.display()))
    })?)
    .map_err(|error| {
        RomWeaverError::Validation(format!("invalid `{}`: {error}", path.display()))
    })?;
    value.as_object().cloned().ok_or_else(|| {
        RomWeaverError::Validation(format!(
            "invalid `{}`: expected a JSON object",
            path.display()
        ))
    })
}

#[cfg(not(target_arch = "wasm32"))]
fn merge_json_records(
    destination: &mut serde_json::Map<String, serde_json::Value>,
    incoming: &serde_json::Map<String, serde_json::Value>,
    field: &str,
    key: &str,
) -> Result<()> {
    let records = incoming
        .get(field)
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            RomWeaverError::Validation(format!("identify metadata has no `{field}` array"))
        })?;
    let destination_records = destination
        .entry(field.to_string())
        .or_insert_with(|| serde_json::Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "installed identify metadata has no `{field}` array"
            ))
        })?;
    for record in records {
        let value = record
            .as_object()
            .and_then(|record| record.get(key))
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                RomWeaverError::Validation(format!("identify `{field}` record has no `{key}`"))
            })?;
        destination_records.retain(|existing| {
            existing
                .as_object()
                .and_then(|record| record.get(key))
                .and_then(serde_json::Value::as_str)
                != Some(value)
        });
        destination_records.push(record.clone());
    }
    destination_records.sort_by(|left, right| {
        let left = left
            .as_object()
            .and_then(|record| record.get(key))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let right = right
            .as_object()
            .and_then(|record| record.get(key))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        left.cmp(right)
    });
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
fn merged_metadata(
    installed_path: &Path,
    archive_path: &Path,
    fields: &[(&str, &str)],
) -> Result<Vec<u8>> {
    let archive = read_json_object(archive_path)?;
    let mut installed = if installed_path.is_file() {
        read_json_object(installed_path)?
    } else {
        archive.clone()
    };
    for (field, key) in fields {
        merge_json_records(&mut installed, &archive, field, key)?;
    }
    serde_json::to_vec_pretty(&installed).map_err(|error| {
        RomWeaverError::Validation(format!("failed to serialize identify metadata: {error}"))
    })
}

#[cfg(not(target_arch = "wasm32"))]
fn write_group_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let part = path.with_extension("part");
    fs::write(&part, bytes).map_err(|error| {
        RomWeaverError::Validation(format!("failed to write `{}`: {error}", part.display()))
    })?;
    fs::rename(&part, path).map_err(|error| {
        RomWeaverError::Validation(format!("failed to finalize `{}`: {error}", path.display()))
    })
}

#[cfg(not(target_arch = "wasm32"))]
fn group_archive_entries(stage: &Path, group: &str) -> Result<Vec<PackIndexEntry>> {
    let index_path = stage.join("index.json");
    let index: PackIndex = serde_json::from_slice(&fs::read(&index_path).map_err(|error| {
        RomWeaverError::Validation(format!(
            "failed to read `{}`: {error}",
            index_path.display()
        ))
    })?)
    .map_err(|error| RomWeaverError::Validation(format!("invalid identify index: {error}")))?;
    let archive_group = index
        .groups
        .iter()
        .find(|candidate| candidate.id == group)
        .ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "identify data archive does not contain group `{group}`"
            ))
        })?;
    if index.groups.len() != 1 {
        return Err(RomWeaverError::Validation(format!(
            "identify group archive for `{group}` lists more than one group"
        )));
    }
    if archive_group.default {
        return Err(RomWeaverError::Validation(format!(
            "identify pack group `{group}` is included by install-all"
        )));
    }
    let expected: std::collections::BTreeSet<_> =
        archive_group.systems.iter().map(String::as_str).collect();
    let actual: std::collections::BTreeSet<_> = index
        .systems
        .iter()
        .map(|entry| entry.slug.as_str())
        .collect();
    if expected.is_empty() || expected != actual {
        return Err(RomWeaverError::Validation(format!(
            "identify pack group `{group}` does not match its archive systems"
        )));
    }
    for entry in &index.systems {
        validate_group_id(&entry.slug)?;
        if entry.brotli_file != format!("packs/{}.pack.br", entry.slug) {
            return Err(RomWeaverError::Validation(format!(
                "identify pack `{}` has an invalid archive path",
                entry.slug
            )));
        }
    }
    let catalog = read_json_object(&stage.join("catalog.json"))?;
    let catalog_slugs: std::collections::BTreeSet<_> = catalog
        .get("platforms")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            RomWeaverError::Validation("identify catalog has no `platforms` array".to_string())
        })?
        .iter()
        .map(|platform| {
            platform
                .as_object()
                .and_then(|platform| platform.get("packSlug"))
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    RomWeaverError::Validation(
                        "identify catalog platform has no `packSlug`".to_string(),
                    )
                })
        })
        .collect::<Result<_>>()?;
    if catalog_slugs != expected {
        return Err(RomWeaverError::Validation(format!(
            "identify pack group `{group}` does not match its catalog platforms"
        )));
    }
    let archive_packs: std::collections::BTreeSet<_> = fs::read_dir(stage.join("packs"))?
        .map(|entry| {
            entry
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to read staged identify pack: {error}"
                    ))
                })
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
        })
        .collect::<Result<_>>()?;
    let expected_packs: std::collections::BTreeSet<_> = index
        .systems
        .iter()
        .map(|entry| format!("{}.pack.br", entry.slug))
        .collect();
    if archive_packs != expected_packs {
        return Err(RomWeaverError::Validation(format!(
            "identify pack group `{group}` contains unexpected pack files"
        )));
    }
    Ok(index.systems)
}

#[cfg(not(target_arch = "wasm32"))]
fn install_group_archive(database_dir: &Path, group: &str, archive: &[u8]) -> Result<usize> {
    validate_group_id(group)?;
    let parent = database_dir.parent().unwrap_or(database_dir);
    fs::create_dir_all(parent)?;
    let stage = parent.join(format!(
        ".identify-group-{group}-{}.part",
        std::process::id()
    ));
    if stage.exists() {
        fs::remove_dir_all(&stage)?;
    }
    fs::create_dir_all(&stage)?;
    if let Err(error) = extract_archive(archive, &stage) {
        let _ = fs::remove_dir_all(&stage);
        return Err(error);
    }
    let entries = match group_archive_entries(&stage, group) {
        Ok(entries) => entries,
        Err(error) => {
            let _ = fs::remove_dir_all(&stage);
            return Err(error);
        }
    };
    let index_bytes = match merged_metadata(
        &database_dir.join("index.json"),
        &stage.join("index.json"),
        &[("systems", "slug"), ("groups", "id")],
    ) {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = fs::remove_dir_all(&stage);
            return Err(error);
        }
    };
    let catalog_bytes = match merged_metadata(
        &database_dir.join("catalog.json"),
        &stage.join("catalog.json"),
        &[("platforms", "packSlug")],
    ) {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = fs::remove_dir_all(&stage);
            return Err(error);
        }
    };
    rom_weaver_checksum::identify_catalog::IdentifyCatalog::parse(&catalog_bytes)?;

    let packs = entries
        .iter()
        .map(|entry| {
            decompress(&stage.join(&entry.brotli_file)).map(|bytes| (entry.slug.as_str(), bytes))
        })
        .collect::<Result<Vec<_>>>()?;
    let install = parent.join(format!(
        ".identify-group-{group}-{}.install",
        std::process::id()
    ));
    let backup = parent.join(format!(
        ".identify-group-{group}-{}.backup",
        std::process::id()
    ));
    if install.exists() {
        fs::remove_dir_all(&install)?;
    }
    if backup.exists() {
        fs::remove_dir_all(&backup)?;
    }
    let prepare = (|| -> Result<()> {
        if database_dir.exists() {
            copy_directory(database_dir, &install)?;
        } else {
            fs::create_dir_all(&install)?;
        }
        for (slug, pack) in &packs {
            write_group_atomic(&install.join(format!("{slug}.pack")), pack)?;
        }
        write_group_atomic(&install.join("index.json"), &index_bytes)?;
        write_group_atomic(&install.join("catalog.json"), &catalog_bytes)?;
        Ok(())
    })();
    if let Err(error) = prepare {
        let _ = fs::remove_dir_all(&install);
        let _ = fs::remove_dir_all(&stage);
        return Err(error);
    }
    if database_dir.exists() {
        fs::rename(database_dir, &backup)?;
    }
    if let Err(error) = fs::rename(&install, database_dir) {
        if backup.exists() {
            let _ = fs::rename(&backup, database_dir);
        }
        let _ = fs::remove_dir_all(&stage);
        return Err(error.into());
    }
    if backup.exists()
        && let Err(error) = fs::remove_dir_all(&backup)
    {
        tracing::warn!(path = %backup.display(), %error, "failed to remove identify group backup");
    }
    fs::remove_dir_all(&stage)?;
    Ok(packs.len())
}

#[cfg(not(target_arch = "wasm32"))]
fn copy_directory(source: &Path, target: &Path) -> Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let destination = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_directory(&entry.path(), &destination)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), destination)?;
        } else {
            return Err(RomWeaverError::Validation(format!(
                "identify database contains an unsupported entry `{}`",
                entry.path().display()
            )));
        }
    }
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn install_group(
    database_dir: &Path,
    group: &str,
    from: Option<&Path>,
) -> Result<usize> {
    use std::io::Read;
    const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
    validate_group_id(group)?;
    let bytes = if let Some(path) = from {
        let size = fs::metadata(path)
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to inspect identify group archive `{}`: {error}",
                    path.display()
                ))
            })?
            .len();
        if size > MAX_ARCHIVE_BYTES {
            return Err(RomWeaverError::Validation(format!(
                "identify group archive `{}` exceeds the {} byte limit",
                path.display(),
                MAX_ARCHIVE_BYTES
            )));
        }
        fs::read(path).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to read identify group archive `{}`: {error}",
                path.display()
            ))
        })?
    } else {
        let version = env!("CARGO_PKG_VERSION");
        let url = format!(
            "https://github.com/rom-weaver/rom-weaver/releases/download/v{version}/rom-weaver-identify-data-{group}.tar.br"
        );
        tracing::debug!(
            url,
            version,
            group,
            "downloading identify pack group archive"
        );
        let mut response = ureq::get(&url).call().map_err(|error| {
            RomWeaverError::Validation(format!(
                "identify data download failed for `{url}`: {error}"
            ))
        })?;
        let mut bytes = Vec::new();
        response
            .body_mut()
            .with_config()
            .limit(MAX_ARCHIVE_BYTES)
            .reader()
            .read_to_end(&mut bytes)
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "identify data download failed for `{url}`: {error}"
                ))
            })?;
        bytes
    };
    install_group_archive(database_dir, group, &bytes)
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn install_all(database_dir: &Path) -> Result<usize> {
    use std::io::Read;
    const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
    let version = env!("CARGO_PKG_VERSION");
    let url = format!(
        "https://github.com/rom-weaver/rom-weaver/releases/download/v{version}/rom-weaver-identify-data.tar.br"
    );
    tracing::debug!(url, version, "downloading full identify data archive");
    let mut response = ureq::get(&url).call().map_err(|error| {
        RomWeaverError::Validation(format!(
            "identify data download failed for `{url}`: {error}"
        ))
    })?;
    let mut bytes = Vec::new();
    response
        .body_mut()
        .with_config()
        .limit(MAX_ARCHIVE_BYTES)
        .reader()
        .read_to_end(&mut bytes)
        .map_err(|error| {
            RomWeaverError::Validation(format!(
                "identify data download failed for `{url}`: {error}"
            ))
        })?;
    let parent = database_dir.parent().unwrap_or(database_dir);
    fs::create_dir_all(parent)?;
    let stage = parent.join(format!(".identify-full-v1-{}.part", std::process::id()));
    let backup = parent.join(format!(".identify-full-v1-{}.backup", std::process::id()));
    if stage.exists() {
        fs::remove_dir_all(&stage)?;
    }
    fs::create_dir_all(&stage)?;
    if let Err(error) = extract_archive(bytes.as_slice(), &stage) {
        let _ = fs::remove_dir_all(&stage);
        return Err(error);
    }
    let target = database_dir.join(USER_FULL_DATA_DIR);
    fs::create_dir_all(database_dir)?;
    if backup.exists() {
        fs::remove_dir_all(&backup)?;
    }
    if target.exists() {
        fs::rename(&target, &backup)?;
    }
    if let Err(error) = fs::rename(&stage, &target) {
        if backup.exists() {
            let _ = fs::rename(&backup, &target);
        }
        return Err(error.into());
    }
    if backup.exists()
        && let Err(error) = fs::remove_dir_all(&backup)
    {
        tracing::warn!(path = %backup.display(), %error, "failed to remove replaced identify data backup");
    }
    let count = fs::read_dir(target.join("packs"))?.count();
    tracing::debug!(packs = count, path = %target.display(), "installed full identify data");
    Ok(count)
}

#[cfg(not(target_arch = "wasm32"))]
fn decompress_bytes(bytes: &[u8], label: &str, capacity: usize) -> Result<Vec<u8>> {
    let decoder = brotli::Decompressor::new(bytes, 4096);
    let mut decompressed = Vec::with_capacity(capacity);
    decoder
        .take(
            u64::try_from(capacity)
                .unwrap_or(u64::MAX)
                .saturating_add(1),
        )
        .read_to_end(&mut decompressed)
        .map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to decompress packaged identify pack `{label}`: {error}"
            ))
        })?;
    if decompressed.len() != capacity {
        return Err(RomWeaverError::Validation(format!(
            "failed to decompress packaged identify pack `{label}`: expected {capacity} bytes, got {}",
            decompressed.len()
        )));
    }
    Ok(decompressed)
}

#[cfg(target_arch = "wasm32")]
pub(super) fn decompress(_path: &std::path::Path) -> rom_weaver_core::Result<Vec<u8>> {
    Err(rom_weaver_core::RomWeaverError::Validation(
        "packaged identify data is not available in the browser build".to_string(),
    ))
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    fn builder_style_archive_for_group(
        include_pack: bool,
        group: &str,
        slug: &str,
        platform: &str,
    ) -> Vec<u8> {
        let raw = b"pack bytes";
        let compressed = brotli_compress(raw);
        let index = serde_json::to_vec(&serde_json::json!({
            "groups": [{
                "id": group,
                "label": "Optional systems",
                "default": false,
                "systems": [slug],
            }],
            "systems": [{
                "slug": slug,
                "file": format!("{slug}.pack"),
                "rawBytes": raw.len(),
                "sha256": sha256(raw),
                "brotliFile": format!("packs/{slug}.pack.br"),
                "brotliBytes": compressed.len(),
                "brotliSha256": sha256(&compressed),
            }]
        }))
        .expect("index JSON");
        let catalog = serde_json::to_vec(&serde_json::json!({
            "format": "rom-weaver-identify-catalog-v1",
            "platforms": [{
                "canonicalPlatform": platform,
                "aliases": [slug],
                "source": "redump",
                "mediaProfiles": ["redump-cd-track-v1"],
                "packSlug": slug,
                "packFormat": "RWFP1",
                "canonicalizationVersion": 1
            }]
        }))
        .expect("catalog JSON");
        let mut tar_bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_bytes);
            for path in [
                "share",
                "share/rom-weaver",
                "share/rom-weaver/identify",
                ARCHIVE_PREFIX,
                "share/rom-weaver/identify/v1/packs",
            ] {
                let mut header = tar::Header::new_gnu();
                header.set_entry_type(tar::EntryType::Directory);
                header.set_size(0);
                header.set_mode(0o755);
                header.set_cksum();
                builder
                    .append_data(&mut header, path, std::io::empty())
                    .expect("directory entry");
            }
            for (path, bytes) in [
                ("share/rom-weaver/identify/v1/index.json", index.as_slice()),
                (
                    "share/rom-weaver/identify/v1/catalog.json",
                    catalog.as_slice(),
                ),
            ] {
                let mut header = tar::Header::new_gnu();
                header.set_size(bytes.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder
                    .append_data(&mut header, path, bytes)
                    .expect("file entry");
            }
            if include_pack {
                let mut header = tar::Header::new_gnu();
                header.set_size(compressed.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder
                    .append_data(
                        &mut header,
                        format!("share/rom-weaver/identify/v1/packs/{slug}.pack.br"),
                        compressed.as_slice(),
                    )
                    .expect("pack entry");
            }
            builder.finish().expect("tar archive");
        }
        brotli_compress(&tar_bytes)
    }

    fn builder_style_archive(include_pack: bool) -> Vec<u8> {
        builder_style_archive_for_group(include_pack, "optional", "test", "Test System")
    }

    fn brotli_compress(raw: &[u8]) -> Vec<u8> {
        let mut compressed = Vec::new();
        {
            let mut encoder = brotli::CompressorWriter::new(&mut compressed, 4096, 5, 22);
            std::io::Write::write_all(&mut encoder, raw).expect("compressed pack");
        }
        compressed
    }

    #[test]
    fn data_layout_supports_installed_and_portable_archives() {
        let dirs = candidate_data_dirs(Path::new("/opt/rom-weaver/bin/rom-weaver"));
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/opt/rom-weaver/bin/share/rom-weaver/identify/v1"),
                PathBuf::from("/opt/rom-weaver/share/rom-weaver/identify/v1"),
            ]
        );
    }

    #[test]
    fn packaged_pack_decompression_reads_one_brotli_frame() {
        let expected = b"RWFP1\0\0\0pack data";
        let compressed = brotli_compress(expected);
        assert_eq!(
            decompress_bytes(&compressed, "fixture", expected.len()).expect("decompressed fixture"),
            expected
        );
    }

    #[test]
    fn packaged_pack_checks_compressed_and_raw_hashes() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        let packs = temp.path().join("packs");
        fs::create_dir_all(&packs).expect("packs directory");
        let raw = b"RWFP1\0\0\0pack data";
        let compressed = brotli_compress(raw);
        let pack = packs.join("test.pack.br");
        fs::write(&pack, &compressed).expect("pack fixture");
        let index = serde_json::json!({
            "systems": [{
                "file": "test.pack",
                "rawBytes": raw.len(),
                "sha256": sha256(raw),
                "brotliFile": "packs/test.pack.br",
                "brotliBytes": compressed.len(),
                "brotliSha256": sha256(&compressed),
            }]
        });
        fs::write(
            temp.path().join("index.json"),
            serde_json::to_vec(&index).expect("index JSON"),
        )
        .expect("index fixture");
        assert_eq!(decompress(&pack).expect("verified pack"), raw);

        let mut corrupt = index;
        corrupt["systems"][0]["brotliSha256"] = serde_json::json!("00");
        fs::write(
            temp.path().join("index.json"),
            serde_json::to_vec(&corrupt).expect("corrupt index JSON"),
        )
        .expect("corrupt index fixture");
        assert!(decompress(&pack).is_err());
    }

    #[test]
    fn archive_path_rejects_traversal_and_unexpected_files() {
        assert!(
            archive_relative_path(Path::new("share/rom-weaver/identify/v1/../../outside")).is_err()
        );
        assert!(
            archive_relative_path(Path::new(
                "share/rom-weaver/identify/v1/packs/not-a-pack.txt"
            ))
            .is_err()
        );
    }

    #[test]
    fn corrupt_archive_is_rejected_before_install() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        let error = extract_archive(b"not a Brotli archive".as_slice(), temp.path())
            .expect_err("corrupt archive rejected");
        assert!(error.to_string().contains("invalid identify data archive"));
    }

    #[test]
    fn builder_style_ancestor_directories_extract_successfully() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        let archive = builder_style_archive(true);
        extract_archive(archive.as_slice(), temp.path()).expect("archive extraction");
        assert!(temp.path().join("packs/test.pack.br").is_file());
    }

    #[test]
    fn archive_rejects_an_index_pack_that_is_missing() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        let archive = builder_style_archive(false);
        let error =
            extract_archive(archive.as_slice(), temp.path()).expect_err("missing pack rejected");
        assert!(error.to_string().contains("is missing"));
    }

    #[test]
    fn archive_rejects_oversized_entries() {
        let mut total = 0;
        let error = check_archive_entry_size(MAX_PACK_BYTES + 1, &mut total)
            .expect_err("oversized entry rejected");
        assert!(error.to_string().contains("archive entry size"));
    }

    #[test]
    fn optional_group_install_merges_packs_and_metadata_by_slug() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        let database = temp.path().join("identify");
        fs::create_dir_all(&database).expect("database directory");
        fs::write(
            database.join("index.json"),
            serde_json::to_vec(&serde_json::json!({
                "format": "rom-weaver-identify-index-v1",
                "groups": [{"id": "default", "default": true, "systems": ["base"]}],
                "systems": [{"slug": "base", "file": "base.pack"}],
            }))
            .expect("existing index"),
        )
        .expect("write existing index");
        fs::write(
            database.join("catalog.json"),
            serde_json::to_vec(&serde_json::json!({
                "format": "rom-weaver-identify-catalog-v1",
                "platforms": [{
                    "canonicalPlatform": "Base System",
                    "aliases": ["base"],
                    "source": "libretro",
                    "mediaProfiles": ["libretro-clrmamepro-v1"],
                    "packSlug": "base",
                    "packFormat": "RWFP1",
                    "canonicalizationVersion": 1,
                }],
            }))
            .expect("existing catalog"),
        )
        .expect("write existing catalog");
        fs::write(database.join("base.pack"), b"existing pack").expect("write existing pack");

        let archive = builder_style_archive(true);
        assert_eq!(
            install_group_archive(&database, "optional", &archive).expect("install"),
            1
        );
        assert_eq!(
            fs::read(database.join("base.pack")).expect("base pack"),
            b"existing pack"
        );
        assert_eq!(
            fs::read(database.join("test.pack")).expect("group pack"),
            b"pack bytes"
        );

        let index: serde_json::Value =
            serde_json::from_slice(&fs::read(database.join("index.json")).expect("merged index"))
                .expect("index JSON");
        assert_eq!(index["systems"].as_array().expect("systems").len(), 2);
        assert_eq!(index["groups"].as_array().expect("groups").len(), 2);
        let catalog = fs::read(database.join("catalog.json")).expect("merged catalog");
        assert_eq!(
            rom_weaver_checksum::identify_catalog::IdentifyCatalog::parse(&catalog)
                .expect("catalog")
                .entries()
                .len(),
            2
        );
    }

    #[test]
    fn optional_computer_group_install_adds_its_pack_and_metadata() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        let database = temp.path().join("identify");
        let archive = builder_style_archive_for_group(
            true,
            "optional-computers",
            "commodore-64",
            "Commodore 64",
        );

        assert_eq!(
            install_group_archive(&database, "optional-computers", &archive).expect("install"),
            1
        );
        assert_eq!(
            fs::read(database.join("commodore-64.pack")).expect("computer pack"),
            b"pack bytes"
        );

        let index: PackIndex = serde_json::from_slice(
            &fs::read(database.join("index.json")).expect("installed index"),
        )
        .expect("index JSON");
        assert_eq!(index.groups.len(), 1);
        assert_eq!(index.groups[0].id, "optional-computers");
        assert!(!index.groups[0].default);
        assert_eq!(index.groups[0].systems, ["commodore-64"]);

        let catalog = fs::read(database.join("catalog.json")).expect("installed catalog");
        let catalog = rom_weaver_checksum::identify_catalog::IdentifyCatalog::parse(&catalog)
            .expect("catalog");
        assert_eq!(catalog.entries().len(), 1);
        assert_eq!(catalog.entries()[0].canonical_platform, "Commodore 64");
    }

    #[test]
    fn optional_group_install_rejects_an_oversized_local_archive() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        let archive = temp.path().join("oversized.tar.br");
        fs::File::create(&archive)
            .expect("archive fixture")
            .set_len(512 * 1024 * 1024 + 1)
            .expect("sparse archive size");
        let error = install_group(temp.path(), "optional", Some(&archive))
            .expect_err("oversized archive rejected");
        assert!(
            error
                .to_string()
                .contains("exceeds the 536870912 byte limit")
        );
    }

    #[test]
    fn brotli_decompression_rejects_output_above_the_capacity() {
        let raw = vec![0_u8; 1024];
        let compressed = brotli_compress(&raw);
        assert!(decompress_bytes(&compressed, "fixture", raw.len() - 1).is_err());
    }

    // -----------------------------------------------------------------------
    // Staged group fixtures
    // -----------------------------------------------------------------------

    /// A staged archive directory: `index.json`, `catalog.json`, and one
    /// `packs/<slug>.pack.br` per index entry.
    fn stage_dir(
        index: &serde_json::Value,
        catalog: &serde_json::Value,
        packs: &[&str],
    ) -> assert_fs::TempDir {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        fs::create_dir_all(temp.path().join("packs")).expect("packs directory");
        fs::write(
            temp.path().join("index.json"),
            serde_json::to_vec(index).expect("index JSON"),
        )
        .expect("index fixture");
        fs::write(
            temp.path().join("catalog.json"),
            serde_json::to_vec(catalog).expect("catalog JSON"),
        )
        .expect("catalog fixture");
        for pack in packs {
            fs::write(temp.path().join("packs").join(pack), b"pack").expect("pack fixture");
        }
        temp
    }

    fn group_index(
        group: &str,
        default: bool,
        groups: usize,
        slug: &str,
        brotli_file: &str,
    ) -> serde_json::Value {
        let mut group_rows = vec![serde_json::json!({
            "id": group,
            "default": default,
            "systems": [slug],
        })];
        for extra in 1..groups {
            group_rows.push(serde_json::json!({
                "id": format!("{group}-{extra}"),
                "default": false,
                "systems": [slug],
            }));
        }
        serde_json::json!({
            "groups": group_rows,
            "systems": [{
                "slug": slug,
                "file": format!("{slug}.pack"),
                "rawBytes": 4,
                "sha256": sha256(b"pack"),
                "brotliFile": brotli_file,
                "brotliBytes": 4,
                "brotliSha256": sha256(b"pack"),
            }],
        })
    }

    fn group_catalog(slug: &str) -> serde_json::Value {
        serde_json::json!({
            "format": "rom-weaver-identify-catalog-v1",
            "platforms": [{
                "canonicalPlatform": "Test System",
                "aliases": [slug],
                "source": "redump",
                "mediaProfiles": ["redump-cd-track-v1"],
                "packSlug": slug,
                "packFormat": "RWFP1",
                "canonicalizationVersion": 1,
            }],
        })
    }

    /// The message of a call that must fail; `Result`'s Ok type is not `Debug`.
    fn error_text<T>(result: Result<T>) -> String {
        match result {
            Ok(_) => panic!("the call was expected to fail"),
            Err(error) => error.to_string(),
        }
    }

    // -----------------------------------------------------------------------
    // Path and size helpers
    // -----------------------------------------------------------------------

    #[test]
    fn candidate_data_dirs_needs_a_parent_directory() {
        assert!(
            candidate_data_dirs(Path::new("/")).is_empty(),
            "a path with no parent names no data directory"
        );
        assert_eq!(
            candidate_data_dirs(Path::new("/rom-weaver")),
            vec![PathBuf::from("/").join(DATA_RELATIVE_PATH)],
            "a bin dir with no parent contributes one candidate"
        );
    }

    #[test]
    fn pack_path_prefers_the_user_installed_data_dir() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        let database = temp.path().join("identify");
        assert!(pack_path(&database, "test").is_none());

        let packs = database.join(USER_FULL_DATA_DIR).join("packs");
        fs::create_dir_all(&packs).expect("user packs directory");
        let pack = packs.join("test.pack.br");
        fs::write(&pack, b"compressed").expect("pack fixture");
        assert_eq!(pack_path(&database, "test"), Some(pack));
        assert!(pack_path(&database, "other").is_none());
    }

    #[test]
    fn pack_slugs_lists_the_user_installed_packs_without_duplicates() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        let database = temp.path().join("identify");
        assert!(
            pack_slugs(&database).expect("slug listing").is_empty(),
            "a database dir with no packs lists nothing"
        );

        let packs = database.join(USER_FULL_DATA_DIR).join("packs");
        fs::create_dir_all(&packs).expect("user packs directory");
        for name in ["sega-saturn.pack.br", "atari-2600.pack.br", "index.json"] {
            fs::write(packs.join(name), b"payload").expect("pack fixture");
        }
        assert_eq!(
            pack_slugs(&database).expect("slug listing"),
            ["atari-2600", "sega-saturn"]
        );
    }

    #[test]
    fn pack_size_checks_name_the_side_that_is_too_large() {
        assert!(check_pack_size(MAX_PACK_BYTES, "compressed").is_ok());
        let error = error_text(check_pack_size(MAX_PACK_BYTES + 1, "decompressed"));
        assert!(error.contains("identify pack decompressed size"));
        assert!(error.contains(&MAX_PACK_BYTES.to_string()));
    }

    #[test]
    fn archive_entry_sizes_are_capped_in_total_and_guarded_against_overflow() {
        let mut total = 0;
        check_archive_entry_size(MAX_PACK_BYTES, &mut total).expect("one entry at the cap");
        assert_eq!(total, MAX_PACK_BYTES);

        let mut near_limit = MAX_EXTRACTED_BYTES;
        assert!(
            error_text(check_archive_entry_size(1, &mut near_limit)).contains("extracted limit")
        );

        let mut overflowing = u64::MAX;
        assert!(
            error_text(check_archive_entry_size(1, &mut overflowing)).contains("size overflow")
        );
    }

    #[test]
    fn archive_directory_allowlist_covers_only_the_data_ancestors() {
        for allowed in [
            "share",
            "share/rom-weaver",
            "share/rom-weaver/identify",
            ARCHIVE_PREFIX,
            "share/rom-weaver/identify/v1/packs",
        ] {
            assert!(archive_directory_allowed(Path::new(allowed)));
        }
        assert!(!archive_directory_allowed(Path::new("share/other")));
        assert!(!archive_directory_allowed(Path::new(
            "share/rom-weaver/identify/v1/packs/nested"
        )));
    }

    #[test]
    fn archive_paths_accept_the_metadata_files_and_pack_directory() {
        assert_eq!(
            archive_relative_path(Path::new("share/rom-weaver/identify/v1/index.json"))
                .expect("index path"),
            PathBuf::from("index.json")
        );
        assert_eq!(
            archive_relative_path(Path::new("share/rom-weaver/identify/v1/catalog.json"))
                .expect("catalog path"),
            PathBuf::from("catalog.json")
        );
        assert_eq!(
            archive_relative_path(Path::new("share/rom-weaver/identify/v1/packs/a.pack.br"))
                .expect("pack path"),
            PathBuf::from("packs/a.pack.br")
        );
        assert!(
            error_text(archive_relative_path(Path::new("etc/passwd")))
                .contains("unexpected identify data archive path")
        );
        assert!(
            archive_relative_path(Path::new(
                "share/rom-weaver/identify/v1/packs/nested/a.pack.br"
            ))
            .is_err()
        );
    }

    #[test]
    fn group_ids_are_lowercase_alphanumeric_with_hyphens() {
        validate_group_id("optional-computers").expect("a valid group id");
        validate_group_id("group2").expect("digits are allowed");
        for invalid in ["", "Optional", "group_1", "group/1", "grüp"] {
            assert!(
                error_text(validate_group_id(invalid)).contains("invalid identify pack group"),
                "`{invalid}` must be rejected"
            );
        }
    }

    // -----------------------------------------------------------------------
    // decompress
    // -----------------------------------------------------------------------

    #[test]
    fn decompress_rejects_a_pack_its_index_does_not_describe() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        let packs = temp.path().join("packs");
        fs::create_dir_all(&packs).expect("packs directory");
        let raw = b"RWFP1 payload";
        let compressed = brotli_compress(raw);
        let pack = packs.join("test.pack.br");
        fs::write(&pack, &compressed).expect("pack fixture");

        assert!(
            error_text(decompress(&pack)).contains("failed to read"),
            "a missing index.json is reported by path"
        );

        fs::write(temp.path().join("index.json"), b"{ not json").expect("index fixture");
        assert!(error_text(decompress(&pack)).contains("invalid identify index"));

        fs::write(
            temp.path().join("index.json"),
            serde_json::to_vec(&serde_json::json!({ "systems": [] })).expect("index JSON"),
        )
        .expect("index fixture");
        assert!(
            error_text(decompress(&pack)).contains("is missing from"),
            "a pack with no index row is rejected"
        );
    }

    #[test]
    fn decompress_rejects_a_wrong_compressed_size_and_a_wrong_raw_hash() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        let packs = temp.path().join("packs");
        fs::create_dir_all(&packs).expect("packs directory");
        let raw = b"RWFP1 payload";
        let compressed = brotli_compress(raw);
        let pack = packs.join("test.pack.br");
        fs::write(&pack, &compressed).expect("pack fixture");
        let index = |raw_bytes: usize, sha256_value: String, brotli_bytes: usize| {
            serde_json::json!({
                "systems": [{
                    "file": "test.pack",
                    "rawBytes": raw_bytes,
                    "sha256": sha256_value,
                    "brotliFile": "packs/test.pack.br",
                    "brotliBytes": brotli_bytes,
                    "brotliSha256": sha256(&compressed),
                }]
            })
        };
        let write_index = |value: serde_json::Value| {
            fs::write(
                temp.path().join("index.json"),
                serde_json::to_vec(&value).expect("index JSON"),
            )
            .expect("index fixture");
        };

        write_index(index(raw.len(), sha256(raw), compressed.len() + 1));
        assert!(error_text(decompress(&pack)).contains("invalid compressed size"));

        write_index(index(raw.len(), "0".repeat(64), compressed.len()));
        assert!(error_text(decompress(&pack)).contains("invalid decompressed data"));
    }

    #[test]
    fn verify_raw_pack_checks_both_the_length_and_the_hash() {
        let raw = b"RWFP1 payload";
        let entry = PackIndexEntry {
            slug: "test".to_string(),
            file: "test.pack".to_string(),
            raw_bytes: raw.len() as u64,
            sha256: sha256(raw),
            brotli_file: "packs/test.pack.br".to_string(),
            brotli_bytes: 1,
            brotli_sha256: String::new(),
        };
        verify_raw_pack(&entry, raw).expect("matching raw pack");
        assert!(
            error_text(verify_raw_pack(&entry, b"short")).contains("invalid decompressed data")
        );

        let mut wrong_hash = entry;
        wrong_hash.sha256 = "0".repeat(64);
        assert!(verify_raw_pack(&wrong_hash, raw).is_err());
    }

    // -----------------------------------------------------------------------
    // extract_archive
    // -----------------------------------------------------------------------

    /// A brotli-compressed tar of `entries`, each `(path, type, bytes)`.
    fn tar_archive(entries: &[(&str, tar::EntryType, &[u8])]) -> Vec<u8> {
        let mut tar_bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_bytes);
            for (path, entry_type, bytes) in entries {
                let mut header = tar::Header::new_gnu();
                header.set_entry_type(*entry_type);
                header.set_size(bytes.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder
                    .append_data(&mut header, path, *bytes)
                    .expect("archive entry");
            }
            builder.finish().expect("tar archive");
        }
        brotli_compress(&tar_bytes)
    }

    #[test]
    fn archive_extraction_rejects_a_non_regular_entry() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        let archive = tar_archive(&[(
            "share/rom-weaver/identify/v1/index.json",
            tar::EntryType::Symlink,
            b"",
        )]);
        assert!(
            error_text(extract_archive(archive.as_slice(), temp.path()))
                .contains("is not a regular file")
        );
    }

    #[test]
    fn archive_extraction_rejects_a_path_outside_the_data_prefix() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        let archive = tar_archive(&[(
            "share/rom-weaver/identify/v1/notes.txt",
            tar::EntryType::Regular,
            b"notes",
        )]);
        assert!(
            error_text(extract_archive(archive.as_slice(), temp.path()))
                .contains("unexpected identify data archive path")
        );
    }

    #[test]
    fn archive_extraction_requires_both_metadata_files() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        let archive = tar_archive(&[(
            "share/rom-weaver/identify/v1/index.json",
            tar::EntryType::Regular,
            b"{}",
        )]);
        assert!(
            error_text(extract_archive(archive.as_slice(), temp.path()))
                .contains("archive is incomplete")
        );
    }

    #[test]
    fn archive_extraction_rejects_an_index_pack_path_that_escapes_packs() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        let index = serde_json::to_vec(&group_index(
            "optional",
            false,
            1,
            "test",
            "../outside.pack.br",
        ))
        .expect("index JSON");
        let catalog = serde_json::to_vec(&group_catalog("test")).expect("catalog JSON");
        let archive = tar_archive(&[
            (
                "share/rom-weaver/identify/v1/index.json",
                tar::EntryType::Regular,
                &index,
            ),
            (
                "share/rom-weaver/identify/v1/catalog.json",
                tar::EntryType::Regular,
                &catalog,
            ),
        ]);
        assert!(
            error_text(extract_archive(archive.as_slice(), temp.path()))
                .contains("invalid identify index pack path")
        );
    }

    // -----------------------------------------------------------------------
    // Metadata merging
    // -----------------------------------------------------------------------

    #[test]
    fn read_json_object_reports_the_reason_it_could_not_read_the_file() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        assert!(
            error_text(read_json_object(&temp.path().join("absent.json")))
                .contains("failed to read")
        );

        let broken = temp.path().join("broken.json");
        fs::write(&broken, b"{ not json").expect("broken fixture");
        assert!(error_text(read_json_object(&broken)).contains("invalid"));

        let array = temp.path().join("array.json");
        fs::write(&array, b"[1, 2]").expect("array fixture");
        assert!(error_text(read_json_object(&array)).contains("expected a JSON object"));
    }

    #[test]
    fn merging_records_replaces_by_key_and_sorts_the_result() {
        let mut destination = serde_json::json!({
            "systems": [
                { "slug": "zeta", "file": "zeta.pack" },
                { "slug": "alpha", "file": "old-alpha.pack" },
            ],
        })
        .as_object()
        .cloned()
        .expect("destination object");
        let incoming = serde_json::json!({
            "systems": [
                { "slug": "alpha", "file": "new-alpha.pack" },
                { "slug": "mid", "file": "mid.pack" },
            ],
        })
        .as_object()
        .cloned()
        .expect("incoming object");

        merge_json_records(&mut destination, &incoming, "systems", "slug").expect("merge");
        let systems = destination["systems"].as_array().expect("merged systems");
        assert_eq!(
            systems
                .iter()
                .map(|entry| entry["slug"].as_str().expect("slug"))
                .collect::<Vec<_>>(),
            ["alpha", "mid", "zeta"]
        );
        assert_eq!(systems[0]["file"], serde_json::json!("new-alpha.pack"));
    }

    #[test]
    fn merging_records_rejects_missing_arrays_and_keyless_records() {
        let empty = serde_json::Map::new();
        let mut destination = empty.clone();
        assert!(
            error_text(merge_json_records(
                &mut destination,
                &empty,
                "systems",
                "slug"
            ))
            .contains("identify metadata has no `systems` array")
        );

        let incoming = serde_json::json!({ "systems": [{ "file": "a.pack" }] })
            .as_object()
            .cloned()
            .expect("incoming object");
        let mut destination = serde_json::Map::new();
        assert!(
            error_text(merge_json_records(
                &mut destination,
                &incoming,
                "systems",
                "slug"
            ))
            .contains("identify `systems` record has no `slug`")
        );

        let mut not_an_array = serde_json::json!({ "systems": 7 })
            .as_object()
            .cloned()
            .expect("destination object");
        let incoming = serde_json::json!({ "systems": [{ "slug": "a" }] })
            .as_object()
            .cloned()
            .expect("incoming object");
        assert!(
            error_text(merge_json_records(
                &mut not_an_array,
                &incoming,
                "systems",
                "slug"
            ))
            .contains("installed identify metadata has no `systems` array")
        );
    }

    #[test]
    fn merged_metadata_starts_from_the_archive_when_nothing_is_installed() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        let archive = temp.path().join("archive.json");
        fs::write(
            &archive,
            serde_json::to_vec(&serde_json::json!({
                "format": "rom-weaver-identify-index-v1",
                "systems": [{ "slug": "test", "file": "test.pack" }],
            }))
            .expect("archive JSON"),
        )
        .expect("archive fixture");

        let bytes = merged_metadata(
            &temp.path().join("absent.json"),
            &archive,
            &[("systems", "slug")],
        )
        .expect("merged metadata");
        let value: serde_json::Value = serde_json::from_slice(&bytes).expect("merged JSON");
        assert_eq!(
            value["format"],
            serde_json::json!("rom-weaver-identify-index-v1")
        );
        assert_eq!(value["systems"].as_array().expect("systems").len(), 1);
    }

    #[test]
    fn group_atomic_writes_replace_the_target_and_report_a_bad_path() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        let path = temp.path().join("index.json");
        write_group_atomic(&path, b"first").expect("atomic write");
        write_group_atomic(&path, b"second").expect("atomic overwrite");
        assert_eq!(fs::read(&path).expect("written file"), b"second");
        assert!(!temp.path().join("index.part").exists());

        assert!(
            error_text(write_group_atomic(
                &temp.path().join("absent").join("index.json"),
                b"payload"
            ))
            .contains("failed to write")
        );
    }

    // -----------------------------------------------------------------------
    // group_archive_entries
    // -----------------------------------------------------------------------

    #[test]
    fn group_archives_must_name_exactly_the_requested_non_default_group() {
        let valid = group_index("optional", false, 1, "test", "packs/test.pack.br");
        let catalog = group_catalog("test");

        let stage = stage_dir(&valid, &catalog, &["test.pack.br"]);
        let entries = group_archive_entries(stage.path(), "optional").expect("group entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].slug, "test");

        assert!(
            error_text(group_archive_entries(stage.path(), "other"))
                .contains("does not contain group `other`")
        );

        let two_groups = stage_dir(
            &group_index("optional", false, 2, "test", "packs/test.pack.br"),
            &catalog,
            &["test.pack.br"],
        );
        assert!(
            error_text(group_archive_entries(two_groups.path(), "optional"))
                .contains("lists more than one group")
        );

        let default_group = stage_dir(
            &group_index("optional", true, 1, "test", "packs/test.pack.br"),
            &catalog,
            &["test.pack.br"],
        );
        assert!(
            error_text(group_archive_entries(default_group.path(), "optional"))
                .contains("is included by install-all")
        );
    }

    #[test]
    fn group_archives_must_agree_with_their_index_catalog_and_pack_files() {
        let catalog = group_catalog("test");

        let mut mismatched = group_index("optional", false, 1, "test", "packs/test.pack.br");
        mismatched["groups"][0]["systems"] = serde_json::json!(["other"]);
        let stage = stage_dir(&mismatched, &catalog, &["test.pack.br"]);
        assert!(
            error_text(group_archive_entries(stage.path(), "optional"))
                .contains("does not match its archive systems")
        );

        let stage = stage_dir(
            &group_index("optional", false, 1, "test", "packs/wrong.pack.br"),
            &catalog,
            &["test.pack.br"],
        );
        assert!(
            error_text(group_archive_entries(stage.path(), "optional"))
                .contains("has an invalid archive path")
        );

        let stage = stage_dir(
            &group_index("optional", false, 1, "test", "packs/test.pack.br"),
            &group_catalog("other"),
            &["test.pack.br"],
        );
        assert!(
            error_text(group_archive_entries(stage.path(), "optional"))
                .contains("does not match its catalog platforms")
        );

        let stage = stage_dir(
            &group_index("optional", false, 1, "test", "packs/test.pack.br"),
            &catalog,
            &["test.pack.br", "extra.pack.br"],
        );
        assert!(
            error_text(group_archive_entries(stage.path(), "optional"))
                .contains("contains unexpected pack files")
        );
    }

    #[test]
    fn group_archives_need_a_catalog_with_platform_pack_slugs() {
        let index = group_index("optional", false, 1, "test", "packs/test.pack.br");
        let stage = stage_dir(
            &index,
            &serde_json::json!({ "format": "x" }),
            &["test.pack.br"],
        );
        assert!(
            error_text(group_archive_entries(stage.path(), "optional"))
                .contains("identify catalog has no `platforms` array")
        );

        let stage = stage_dir(
            &index,
            &serde_json::json!({ "format": "x", "platforms": [{ "canonicalPlatform": "T" }] }),
            &["test.pack.br"],
        );
        assert!(
            error_text(group_archive_entries(stage.path(), "optional"))
                .contains("identify catalog platform has no `packSlug`")
        );
    }

    #[test]
    fn group_archive_entries_report_an_unreadable_index() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        assert!(
            error_text(group_archive_entries(temp.path(), "optional")).contains("failed to read")
        );
        fs::write(temp.path().join("index.json"), b"{ not json").expect("index fixture");
        assert!(
            error_text(group_archive_entries(temp.path(), "optional"))
                .contains("invalid identify index")
        );
    }

    // -----------------------------------------------------------------------
    // Installation
    // -----------------------------------------------------------------------

    #[test]
    fn optional_group_install_reads_a_local_archive_from_disk() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        let archive = temp.path().join("optional.tar.br");
        fs::write(&archive, builder_style_archive(true)).expect("archive fixture");
        let database = temp.path().join("identify");

        assert_eq!(
            install_group(&database, "optional", Some(&archive)).expect("install"),
            1
        );
        assert_eq!(
            fs::read(database.join("test.pack")).expect("installed pack"),
            b"pack bytes"
        );
    }

    #[test]
    fn optional_group_install_reports_an_archive_it_cannot_read() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        assert!(
            error_text(install_group(
                temp.path(),
                "optional",
                Some(&temp.path().join("absent.tar.br"))
            ))
            .contains("failed to inspect identify group archive")
        );
    }

    #[test]
    fn optional_group_install_rejects_an_invalid_group_id_before_any_io() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        assert!(
            error_text(install_group(temp.path(), "Optional", None))
                .contains("invalid identify pack group")
        );
    }

    #[test]
    fn a_failed_group_install_leaves_the_database_untouched() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        let database = temp.path().join("identify");
        fs::create_dir_all(&database).expect("database directory");
        fs::write(database.join("base.pack"), b"existing pack").expect("existing pack");

        assert!(
            install_group_archive(&database, "optional", b"not a Brotli archive").is_err(),
            "a corrupt archive fails the install"
        );
        assert_eq!(
            fs::read(database.join("base.pack")).expect("base pack"),
            b"existing pack"
        );
        assert!(
            fs::read_dir(temp.path())
                .expect("parent listing")
                .filter_map(|entry| entry.ok())
                .all(|entry| !entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".identify-group-")),
            "the staging directory is removed"
        );
    }

    #[test]
    fn copy_directory_recreates_nested_files() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        let source = temp.path().join("source");
        fs::create_dir_all(source.join("packs")).expect("source tree");
        fs::write(source.join("index.json"), b"index").expect("index fixture");
        fs::write(source.join("packs/a.pack"), b"pack").expect("pack fixture");

        let target = temp.path().join("target");
        copy_directory(&source, &target).expect("directory copy");
        assert_eq!(
            fs::read(target.join("index.json")).expect("copied index"),
            b"index"
        );
        assert_eq!(
            fs::read(target.join("packs/a.pack")).expect("copied pack"),
            b"pack"
        );
    }

    #[cfg(unix)]
    #[test]
    fn copy_directory_refuses_an_entry_that_is_not_a_file_or_directory() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        let source = temp.path().join("source");
        fs::create_dir_all(&source).expect("source tree");
        std::os::unix::fs::symlink("/dev/null", source.join("link")).expect("symlink fixture");
        assert!(
            error_text(copy_directory(&source, &temp.path().join("target")))
                .contains("unsupported entry")
        );
    }
}
