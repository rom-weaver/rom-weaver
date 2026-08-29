#[cfg(not(target_arch = "wasm32"))]
use std::fs;
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
const DATA_RELATIVE_PATH: &str = "share/rom-weaver/identify/v1/packs";

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

#[cfg(all(not(target_arch = "wasm32"), feature = "bundled-identify-data"))]
pub(super) fn pack_path(database_dir: &Path, slug: &str) -> Option<PathBuf> {
    let file = format!("{slug}.pack.zst");
    let user = database_dir
        .join(USER_FULL_DATA_DIR)
        .join("packs")
        .join(&file);
    if user.is_file() {
        return Some(user);
    }
    data_dirs()
        .into_iter()
        .map(|dir| dir.join(&file))
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
    let mut dirs = vec![database_dir.join(USER_FULL_DATA_DIR).join("packs")];
    dirs.extend(data_dirs());
    for dir in dirs.into_iter().filter(|dir| dir.is_dir()) {
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
            if let Some(slug) = name.strip_suffix(".pack.zst")
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
    if sha256(&bytes) != entry.zstd_sha256 {
        return Err(RomWeaverError::Validation(format!(
            "pack `{}` has an invalid compressed sha256",
            entry.zstd_file
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
    zstd_file: String,
    zstd_sha256: String,
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
        .find(|entry| entry.zstd_file == relative)
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
    let decoder = zstd::stream::read::Decoder::new(reader).map_err(|error| {
        RomWeaverError::Validation(format!("invalid identify data archive: {error}"))
    })?;
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
        let relative = Path::new(&entry.zstd_file);
        if relative.parent() != Some(Path::new("packs"))
            || relative
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err(RomWeaverError::Validation(format!(
                "invalid identify index pack path `{}`",
                entry.zstd_file
            )));
        }
        let path = destination.join(relative);
        if !path.is_file() {
            return Err(RomWeaverError::Validation(format!(
                "identify data archive is missing `{}`",
                entry.zstd_file
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
                .is_some_and(|name| name.to_string_lossy().ends_with(".pack.zst")));
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
        if entry.zstd_file != format!("packs/{}.pack.zst", entry.slug) {
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
        .map(|entry| format!("{}.pack.zst", entry.slug))
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
            decompress(&stage.join(&entry.zstd_file)).map(|bytes| (entry.slug.as_str(), bytes))
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
            "https://github.com/rom-weaver/rom-weaver/releases/download/v{version}/rom-weaver-identify-data-{group}.tar.zst"
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
        "https://github.com/rom-weaver/rom-weaver/releases/download/v{version}/rom-weaver-identify-data.tar.zst"
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
    zstd::bulk::decompress(bytes, capacity).map_err(|error| {
        RomWeaverError::Validation(format!(
            "failed to decompress packaged identify pack `{label}`: {error}"
        ))
    })
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
        let compressed = zstd::bulk::compress(raw, 1).expect("compressed pack");
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
                "zstdFile": format!("packs/{slug}.pack.zst"),
                "zstdSha256": sha256(&compressed),
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
                "packFormat": "RWFP4",
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
                        format!("share/rom-weaver/identify/v1/packs/{slug}.pack.zst"),
                        compressed.as_slice(),
                    )
                    .expect("pack entry");
            }
            builder.finish().expect("tar archive");
        }
        zstd::bulk::compress(&tar_bytes, 1).expect("compressed archive")
    }

    fn builder_style_archive(include_pack: bool) -> Vec<u8> {
        builder_style_archive_for_group(include_pack, "optional", "test", "Test System")
    }

    #[test]
    fn data_layout_supports_installed_and_portable_archives() {
        let dirs = candidate_data_dirs(Path::new("/opt/rom-weaver/bin/rom-weaver"));
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("/opt/rom-weaver/bin/share/rom-weaver/identify/v1/packs"),
                PathBuf::from("/opt/rom-weaver/share/rom-weaver/identify/v1/packs"),
            ]
        );
    }

    #[test]
    fn packaged_pack_decompression_reads_one_zstd_frame() {
        let expected = b"RWFP4\0\0\0pack data";
        let compressed = zstd::bulk::compress(expected, 1).expect("compressed fixture");
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
        let raw = b"RWFP4\0\0\0pack data";
        let compressed = zstd::bulk::compress(raw, 1).expect("compressed fixture");
        let pack = packs.join("test.pack.zst");
        fs::write(&pack, &compressed).expect("pack fixture");
        let index = serde_json::json!({
            "systems": [{
                "file": "test.pack",
                "rawBytes": raw.len(),
                "sha256": sha256(raw),
                "zstdFile": "packs/test.pack.zst",
                "zstdSha256": sha256(&compressed),
            }]
        });
        fs::write(
            temp.path().join("index.json"),
            serde_json::to_vec(&index).expect("index JSON"),
        )
        .expect("index fixture");
        assert_eq!(decompress(&pack).expect("verified pack"), raw);

        let mut corrupt = index;
        corrupt["systems"][0]["zstdSha256"] = serde_json::json!("00");
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
        let error = extract_archive(b"not a zstd archive".as_slice(), temp.path())
            .expect_err("corrupt archive rejected");
        assert!(error.to_string().contains("invalid identify data archive"));
    }

    #[test]
    fn builder_style_ancestor_directories_extract_successfully() {
        let temp = assert_fs::TempDir::new().expect("temporary directory");
        let archive = builder_style_archive(true);
        extract_archive(archive.as_slice(), temp.path()).expect("archive extraction");
        assert!(temp.path().join("packs/test.pack.zst").is_file());
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
                    "packFormat": "RWFP4",
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
        let archive = temp.path().join("oversized.tar.zst");
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
    fn zstd_decompression_rejects_output_above_the_capacity() {
        let raw = vec![0_u8; 1024];
        let compressed = zstd::bulk::compress(&raw, 1).expect("compressed fixture");
        assert!(decompress_bytes(&compressed, "fixture", raw.len() - 1).is_err());
    }
}
