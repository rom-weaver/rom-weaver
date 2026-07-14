use rom_weaver_libarchive::RegularArchiveFileEntry;

use super::bundle_parse::{bundle_file_name_codec, bundle_validation};
use super::*;

/// Hard cap on bundle JSON bytes (plain or decompressed). A bundle is
/// metadata; anything larger is a mistake, and the cap keeps hostile
/// compressed inputs from ballooning in memory.
pub(crate) const BUNDLE_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// Container-registry format names that are single-payload stream codecs.
const STREAM_CODEC_FORMAT_NAMES: [&str; 4] = ["gz", "bz2", "xz", "zst"];

pub(crate) fn is_stream_codec_format_name(name: &str) -> bool {
    STREAM_CODEC_FORMAT_NAMES
        .iter()
        .any(|codec| codec.eq_ignore_ascii_case(name))
}

/// A bundle's raw JSON bytes plus where they came from.
pub(crate) struct LoadedBundleSource {
    pub bytes: Vec<u8>,
    pub kind: BundleSourceKind,
    /// Container-registry format name when `kind` is `Archive`.
    pub archive_format: Option<&'static str>,
    /// Entry name of the bundle member when `kind` is `Archive`.
    pub archive_member: Option<String>,
    /// Full entry listing when `kind` is `Archive` (reused to resolve `path`
    /// entries without re-listing).
    pub archive_entries: Vec<RegularArchiveFileEntry>,
    pub warnings: Vec<String>,
}

/// Forward-slash-normalize an archive entry name for comparisons.
fn normalize_entry_name(name: &str) -> String {
    let normalized = name.replace('\\', "/");
    normalized
        .strip_prefix("./")
        .map(str::to_owned)
        .unwrap_or(normalized)
}

impl CliApp {
    /// Load bundle JSON bytes from `source`: a plain `rom-weaver-bundle.json`, a
    /// stream-codec-compressed one (`rom-weaver-bundle.json.gz`/`.bz2`/`.xz`/`.zst`), or an
    /// archive carrying `rom-weaver-bundle.json` at its root.
    pub(super) fn load_bundle_source(&self, source: &Path) -> Result<LoadedBundleSource> {
        let Some(handler) = self.containers.probe(source) else {
            let size = fs::metadata(source)?.len();
            if size > BUNDLE_MAX_BYTES {
                return Err(bundle_too_large(source.to_string_lossy().as_ref(), size));
            }
            trace!(source = %source.display(), size, "loading plain bundle file");
            return Ok(LoadedBundleSource {
                bytes: fs::read(source)?,
                kind: BundleSourceKind::Json,
                archive_format: None,
                archive_member: None,
                archive_entries: Vec::new(),
                warnings: Vec::new(),
            });
        };

        let format_name = handler.descriptor().name;
        if is_stream_codec_format_name(format_name) {
            let filter = Self::libarchive_read_filter_for_stream_format(format_name)?;
            trace!(
                source = %source.display(),
                format = format_name,
                "loading stream-codec-compressed bundle"
            );
            let bytes = with_raw_stream_reader(source, format_name, filter, 64 * 1024, |reader| {
                read_bundle_bytes_capped(reader, source.to_string_lossy().as_ref())
            })?;
            return Ok(LoadedBundleSource {
                bytes,
                kind: BundleSourceKind::CompressedJson,
                archive_format: None,
                archive_member: None,
                archive_entries: Vec::new(),
                warnings: Vec::new(),
            });
        }

        let entries = list_regular_archive_file_entries(source, format_name)?;
        let mut warnings = Vec::new();
        let mut root_bundle: Option<&RegularArchiveFileEntry> = None;
        for entry in &entries {
            let normalized = normalize_entry_name(&entry.name);
            let (directory, base_name) = match normalized.rsplit_once('/') {
                Some((directory, base_name)) => (Some(directory), base_name),
                None => (None, normalized.as_str()),
            };
            let Some(codec) = bundle_file_name_codec(base_name) else {
                continue;
            };
            if directory.is_some() {
                warnings.push(format!(
                    "ignoring `{}`: only a root-level rom-weaver-bundle.json is recognized",
                    entry.name
                ));
                continue;
            }
            if codec.is_some() {
                return Err(bundle_validation(
                    "bundle.member.unsupported",
                    "compressed bundle members inside archives are not supported; store rom-weaver-bundle.json uncompressed",
                ));
            }
            if let Some(existing) = root_bundle {
                warnings.push(format!(
                    "ignoring extra bundle member `{}`: using `{}`",
                    entry.name, existing.name
                ));
                continue;
            }
            root_bundle = Some(entry);
        }
        let Some(entry) = root_bundle else {
            return Err(RomWeaverError::ValidationCode(
                rom_weaver_core::ValidationCodeError::new("bundle.missing")
                    .with_message("archive contains no rom-weaver-bundle.json bundle at its root")
                    .with_field("source", source.to_string_lossy().into_owned()),
            ));
        };
        trace!(
            source = %source.display(),
            format = format_name,
            member = %entry.name,
            entries = entries.len(),
            "loading bundle member from archive"
        );
        let bytes = with_regular_archive_file_entry_reader(
            source,
            format_name,
            entry.index,
            &entry.name,
            |reader| read_bundle_bytes_capped(reader, &entry.name),
        )?;
        let archive_member = Some(entry.name.clone());
        Ok(LoadedBundleSource {
            bytes,
            kind: BundleSourceKind::Archive,
            archive_format: Some(format_name),
            archive_member,
            archive_entries: entries,
            warnings,
        })
    }

    /// Find the archive entry a bundle `path` value refers to.
    pub(super) fn find_bundle_archive_entry<'entries>(
        entries: &'entries [RegularArchiveFileEntry],
        path: &str,
    ) -> Option<&'entries RegularArchiveFileEntry> {
        let wanted = normalize_entry_name(path);
        entries
            .iter()
            .find(|entry| normalize_entry_name(&entry.name) == wanted)
            .or_else(|| {
                entries
                    .iter()
                    .find(|entry| normalize_entry_name(&entry.name).eq_ignore_ascii_case(&wanted))
            })
    }

    /// Extract one bundle-referenced archive member below `extract_dir`,
    /// preserving its (validated-relative) archive path.
    pub(super) fn extract_bundle_archive_member(
        archive: &Path,
        format_name: &str,
        entry: &RegularArchiveFileEntry,
        extract_dir: &Path,
    ) -> Result<PathBuf> {
        let normalized = normalize_entry_name(&entry.name);
        let target = extract_dir.join(&normalized);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        with_regular_archive_file_entry_reader(
            archive,
            format_name,
            entry.index,
            &entry.name,
            |reader| {
                let mut file = File::create(&target)?;
                io::copy(reader, &mut file)?;
                Ok(())
            },
        )?;
        trace!(
            archive = %archive.display(),
            member = %entry.name,
            target = %target.display(),
            "extracted bundle-referenced archive member"
        );
        Ok(target)
    }
}

fn bundle_too_large(label: &str, size: u64) -> RomWeaverError {
    RomWeaverError::ValidationCode(
        rom_weaver_core::ValidationCodeError::new("bundle.parse")
            .with_message("bundle exceeds the maximum supported size")
            .with_field("source", label.to_owned())
            .with_field("size", size)
            .with_field("limit", BUNDLE_MAX_BYTES),
    )
}

fn read_bundle_bytes_capped(reader: &mut dyn Read, label: &str) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(BUNDLE_MAX_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > BUNDLE_MAX_BYTES {
        return Err(bundle_too_large(label, bytes.len() as u64));
    }
    Ok(bytes)
}
