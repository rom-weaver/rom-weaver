use rom_weaver_libarchive::RegularArchiveFileEntry;

use super::bundle_parse::{
    bundle_bytes_are_valid, bundle_file_name_codec, bundle_validation, is_bundle_json_candidate,
};
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
    /// Load bundle JSON bytes from `source`: a plain JSON file (any name - its
    /// bytes are read verbatim and validated by the caller), a
    /// stream-codec-compressed one (`rom-weaver-bundle.json.gz`/`.bz2`/`.xz`/`.zst`), or an
    /// archive carrying a bundle at its root. Inside archives a root-level
    /// `rom-weaver-bundle.json` is the trusted fast-path; failing that, every
    /// other root-level `*.json` is content-probed and the first that validates
    /// as a bundle wins (so pre-rename `rw.json` archives keep working).
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
        // A root-level `rom-weaver-bundle.json` is the trusted fast-path: its
        // name alone marks it, and its own parse errors surface downstream.
        // Any other root-level `*.json` is only a *candidate* - it is read and
        // must parse+validate as a bundle to be accepted (content probing), so
        // pre-rename `rw.json` bundles and other names keep working without
        // misclassifying a stray JSON.
        let mut root_canonical: Option<&RegularArchiveFileEntry> = None;
        let mut root_candidates: Vec<&RegularArchiveFileEntry> = Vec::new();
        for entry in &entries {
            let normalized = normalize_entry_name(&entry.name);
            let (directory, base_name) = match normalized.rsplit_once('/') {
                Some((directory, base_name)) => (Some(directory), base_name),
                None => (None, normalized.as_str()),
            };
            if let Some(codec) = bundle_file_name_codec(base_name) {
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
                if let Some(existing) = root_canonical {
                    warnings.push(format!(
                        "ignoring extra bundle member `{}`: using `{}`",
                        entry.name, existing.name
                    ));
                    continue;
                }
                root_canonical = Some(entry);
            } else if directory.is_none() && is_bundle_json_candidate(base_name) {
                root_candidates.push(entry);
            }
        }

        let read_member = |entry: &RegularArchiveFileEntry| -> Result<Vec<u8>> {
            with_regular_archive_file_entry_reader(
                source,
                format_name,
                entry.index,
                &entry.name,
                |reader| read_bundle_bytes_capped(reader, &entry.name),
            )
        };

        let (member, bytes) = if let Some(entry) = root_canonical {
            trace!(
                source = %source.display(),
                format = format_name,
                member = %entry.name,
                entries = entries.len(),
                "loading canonical bundle member from archive"
            );
            (entry, read_member(entry)?)
        } else {
            // No canonical name: content-probe each root-level `*.json`, in
            // listing order, and take the first that validates as a bundle.
            let mut chosen: Option<(&RegularArchiveFileEntry, Vec<u8>)> = None;
            for candidate in &root_candidates {
                let bytes = read_member(candidate)?;
                if bundle_bytes_are_valid(&bytes) {
                    trace!(
                        source = %source.display(),
                        format = format_name,
                        member = %candidate.name,
                        "content-probed bundle member from archive"
                    );
                    chosen = Some((candidate, bytes));
                    break;
                }
                trace!(
                    source = %source.display(),
                    member = %candidate.name,
                    "skipping JSON member: not a valid bundle"
                );
            }
            let Some((entry, bytes)) = chosen else {
                return Err(RomWeaverError::ValidationCode(
                    rom_weaver_core::ValidationCodeError::new("bundle.missing")
                        .with_message(
                            "archive contains no rom-weaver-bundle.json bundle at its root",
                        )
                        .with_field("source", source.to_string_lossy().into_owned()),
                ));
            };
            (entry, bytes)
        };

        let archive_member = Some(member.name.clone());
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
