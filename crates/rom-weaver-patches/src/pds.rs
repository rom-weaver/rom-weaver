use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{BufWriter, Read, Write},
    path::Path,
};

use crc32fast::Hasher;
use memmap2::{Mmap, MmapOptions};
use qbsdiff::{Bsdiff, Bspatch, ParallelScheme};
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchChecksumValidation, PatchCreateRequest, PatchHandler, ProbeConfidence,
    Result, RomWeaverError, ThreadCapability,
};
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::FileOptions};

const PDS_MANIFEST_NAME: &str = "patch.dat";
const PDS_DEFAULT_PAYLOAD_NAME: &str = "patch.bdf";
const PDS_VERSION: u32 = 1;
const MAX_MANIFEST_BYTES: usize = 4 * 1024 * 1024;

const MANIFEST_KEY_VERSION: &str = "version";
const MANIFEST_KEY_FORMAT: &str = "format";
const MANIFEST_KEY_PAYLOAD: &str = "payload";
const MANIFEST_KEY_SOURCE_SIZE: &str = "source_size";
const MANIFEST_KEY_TARGET_SIZE: &str = "target_size";
const MANIFEST_KEY_SOURCE_CRC32: &str = "source_crc32";
const MANIFEST_KEY_TARGET_CRC32: &str = "target_crc32";

const BDF_FORMAT_ALIASES: &[&str] = &["bdf", "bsdiff", "bsdiff40", "bspatch", "bspatch40"];
const QBSDIFF_MIN_PARALLEL_TARGET_BYTES: usize = 256 * 1024;

pub struct PdsPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl PdsPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl PatchHandler for PdsPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let parsed = parse_pds_archive(patch_path)?;
        let mut label = format!(
            "parsed PDS archive with {} {} ({} payload {}; manifest `{}` {} byte(s))",
            parsed.entry_count,
            pluralize(parsed.entry_count, "entry", "entries"),
            parsed.payload_count,
            pluralize(parsed.payload_count, "entry", "entries"),
            parsed.manifest_path,
            parsed.manifest_size
        );

        if let Some(format) = &parsed.manifest.format {
            label.push_str(&format!("; declared format `{format}`"));
        }
        if let Some(payload) = &parsed.manifest.payload {
            label.push_str(&format!("; declared payload `{payload}`"));
        }
        if let Some(source_crc32) = parsed.manifest.source_crc32 {
            label.push_str(&format!("; source crc32 {:08x}", source_crc32));
        }
        if let Some(target_crc32) = parsed.manifest.target_crc32 {
            label.push_str(&format!("; target crc32 {:08x}", target_crc32));
        }

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "parse",
            label,
            Some(100.0),
            None,
        ))
    }

    fn apply(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        if request.patches.len() != 1 {
            return Err(RomWeaverError::Validation(format!(
                "{} apply expects exactly one patch file",
                self.descriptor.name
            )));
        }

        let parsed = parse_pds_archive(&request.patches[0])?;
        let payload_name = resolve_payload_name(&parsed)?;
        let format_name = resolve_payload_format(&parsed.manifest, &payload_name)?;
        if !is_bdf_alias(&format_name) {
            return Err(RomWeaverError::Validation(format!(
                "PDS manifest requested unsupported payload format `{format_name}`; only BSDIFF40-compatible payloads are currently supported"
            )));
        }
        let validate_checksums =
            context.patch_checksum_validation() == PatchChecksumValidation::Strict;

        let payload = read_named_payload(&request.patches[0], &payload_name)?;
        let input = map_file_read_only(&request.input)?;
        validate_source_expectations_path(&parsed.manifest, &request.input, validate_checksums)?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let output_file = File::create(&request.output)?;
        let mut output = BufWriter::new(output_file);
        apply_bdf_payload_to_writer(input.as_ref(), &payload, &mut output)?;
        output.flush()?;
        validate_target_expectations_path(&parsed.manifest, &request.output, validate_checksums)?;

        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let checksum_suffix = if validate_checksums {
            String::new()
        } else {
            "; checksum validation skipped".to_string()
        };
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "apply",
            format!(
                "applied PDS patch payload `{payload_name}` (format `{format_name}`){}",
                checksum_suffix
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let source = map_file_read_only(&request.original)?;
        if source.len() > qbsdiff::bsdiff::MAX_LENGTH {
            return Err(RomWeaverError::Validation(format!(
                "PDS source exceeds maximum supported size of {} byte(s)",
                qbsdiff::bsdiff::MAX_LENGTH
            )));
        }
        let target = map_file_read_only(&request.modified)?;
        let (execution, pool) = context.build_pool(qbsdiff_thread_capability(target.len()))?;
        let parallel_scheme = qbsdiff_parallel_scheme(target.len());
        let manifest = build_manifest(source.as_ref(), target.as_ref(), PDS_DEFAULT_PAYLOAD_NAME);

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let file = File::create(&request.output)?;
        let mut archive = ZipWriter::new(file);
        let options = FileOptions::default().compression_method(CompressionMethod::Deflated);
        archive
            .start_file(PDS_MANIFEST_NAME, options)
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "PDS archive could not write `{PDS_MANIFEST_NAME}`: {error}"
                ))
            })?;
        archive.write_all(manifest.as_bytes())?;
        archive
            .start_file(PDS_DEFAULT_PAYLOAD_NAME, options)
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "PDS archive could not write `{PDS_DEFAULT_PAYLOAD_NAME}`: {error}"
                ))
            })?;
        pool.install(|| {
            Bsdiff::new(source.as_ref(), target.as_ref())
                .parallel_scheme(parallel_scheme)
                .compare(&mut archive)
        })?;
        archive.finish().map_err(|error| {
            RomWeaverError::Validation(format!("PDS archive could not be finalized: {error}"))
        })?;

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created PDS patch with BSDIFF40 payload `{}`",
                PDS_DEFAULT_PAYLOAD_NAME
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> PatchCapabilities {
        PatchCapabilities {
            parse: true,
            apply: true,
            create: true,
            threaded_scan: false,
            threaded_diff: true,
            threaded_output: false,
        }
    }
}

fn qbsdiff_thread_capability(target_len: usize) -> ThreadCapability {
    if target_len > QBSDIFF_MIN_PARALLEL_TARGET_BYTES {
        ThreadCapability::parallel(None)
    } else {
        ThreadCapability::single_threaded()
    }
}

fn qbsdiff_parallel_scheme(target_len: usize) -> ParallelScheme {
    if target_len > QBSDIFF_MIN_PARALLEL_TARGET_BYTES {
        ParallelScheme::ChunkSize(QBSDIFF_MIN_PARALLEL_TARGET_BYTES)
    } else {
        ParallelScheme::Never
    }
}

#[derive(Debug)]
struct ParsedPdsPatch {
    entry_count: usize,
    payload_count: usize,
    manifest_path: String,
    manifest_size: usize,
    manifest: PdsManifest,
    payloads: Vec<PdsPayloadEntry>,
}

#[derive(Debug)]
struct PdsPayloadEntry {
    path: String,
}

#[derive(Debug, Default)]
struct PdsManifest {
    version: Option<u32>,
    format: Option<String>,
    payload: Option<String>,
    source_size: Option<u64>,
    target_size: Option<u64>,
    source_crc32: Option<u32>,
    target_crc32: Option<u32>,
}

fn parse_pds_archive(path: &Path) -> Result<ParsedPdsPatch> {
    let mut archive = open_archive(path)?;
    if archive.len() == 0 {
        return Err(RomWeaverError::Validation(
            "PDS patch archive contains no entries".into(),
        ));
    }

    let mut entry_count = 0usize;
    let mut payload_count = 0usize;
    let mut manifest_path: Option<String> = None;
    let mut manifest_bytes = Vec::new();
    let mut payloads = Vec::new();

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| {
            RomWeaverError::Validation(format!(
                "PDS patch archive entry #{index} could not be read: {error}"
            ))
        })?;
        if entry.is_dir() {
            continue;
        }

        entry_count = entry_count
            .checked_add(1)
            .ok_or_else(|| RomWeaverError::Validation("PDS entry count overflowed".into()))?;

        let entry_name = normalize_entry_name(entry.name());
        if is_manifest_entry(&entry_name) {
            if manifest_path.is_some() {
                return Err(RomWeaverError::Validation(
                    "PDS patch archive contains multiple patch.dat manifests".into(),
                ));
            }
            let declared_size = usize::try_from(entry.size()).map_err(|_| {
                RomWeaverError::Validation("PDS manifest size exceeded addressable memory".into())
            })?;
            if declared_size > MAX_MANIFEST_BYTES {
                return Err(RomWeaverError::Validation(format!(
                    "PDS manifest exceeded max supported size of {MAX_MANIFEST_BYTES} byte(s)"
                )));
            }

            manifest_bytes = Vec::with_capacity(declared_size);
            entry.read_to_end(&mut manifest_bytes).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "PDS manifest `{entry_name}` could not be read: {error}"
                ))
            })?;
            if manifest_bytes.iter().all(u8::is_ascii_whitespace) {
                return Err(RomWeaverError::Validation(
                    "PDS manifest `patch.dat` is empty".into(),
                ));
            }
            manifest_path = Some(entry_name);
            continue;
        }

        payload_count = payload_count.checked_add(1).ok_or_else(|| {
            RomWeaverError::Validation("PDS payload entry count overflowed".into())
        })?;
        payloads.push(PdsPayloadEntry { path: entry_name });
    }

    if entry_count == 0 {
        return Err(RomWeaverError::Validation(
            "PDS patch archive did not contain any files".into(),
        ));
    }

    let Some(manifest_path) = manifest_path else {
        return Err(RomWeaverError::Validation(
            "PDS patch archive missing required manifest `patch.dat`".into(),
        ));
    };

    let manifest = parse_manifest(&manifest_bytes)?;

    Ok(ParsedPdsPatch {
        entry_count,
        payload_count,
        manifest_size: manifest_bytes.len(),
        manifest_path,
        manifest,
        payloads,
    })
}

fn parse_manifest(bytes: &[u8]) -> Result<PdsManifest> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| RomWeaverError::Validation("PDS manifest is not valid UTF-8".into()))?;

    let mut fields = BTreeMap::<String, String>::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim().to_string();
        if !key.is_empty() {
            fields.insert(key, value);
        }
    }

    let version = parse_u32_field(&fields, MANIFEST_KEY_VERSION)?;
    let format = parse_string_field(&fields, MANIFEST_KEY_FORMAT);
    let payload = parse_string_field(&fields, MANIFEST_KEY_PAYLOAD)
        .as_deref()
        .map(normalize_entry_name);
    let source_size = parse_u64_field(&fields, MANIFEST_KEY_SOURCE_SIZE)?;
    let target_size = parse_u64_field(&fields, MANIFEST_KEY_TARGET_SIZE)?;
    let source_crc32 = parse_crc32_field(&fields, MANIFEST_KEY_SOURCE_CRC32)?;
    let target_crc32 = parse_crc32_field(&fields, MANIFEST_KEY_TARGET_CRC32)?;

    Ok(PdsManifest {
        version,
        format,
        payload,
        source_size,
        target_size,
        source_crc32,
        target_crc32,
    })
}

fn parse_string_field(fields: &BTreeMap<String, String>, key: &str) -> Option<String> {
    fields.get(key).map(|value| value.to_string())
}

fn parse_u32_field(fields: &BTreeMap<String, String>, key: &str) -> Result<Option<u32>> {
    let Some(value) = fields.get(key) else {
        return Ok(None);
    };
    let parsed = value.parse::<u32>().map_err(|_| {
        RomWeaverError::Validation(format!("PDS manifest field `{key}` is not a valid u32"))
    })?;
    Ok(Some(parsed))
}

fn parse_u64_field(fields: &BTreeMap<String, String>, key: &str) -> Result<Option<u64>> {
    let Some(value) = fields.get(key) else {
        return Ok(None);
    };
    let parsed = value.parse::<u64>().map_err(|_| {
        RomWeaverError::Validation(format!("PDS manifest field `{key}` is not a valid u64"))
    })?;
    Ok(Some(parsed))
}

fn parse_crc32_field(fields: &BTreeMap<String, String>, key: &str) -> Result<Option<u32>> {
    let Some(value) = fields.get(key) else {
        return Ok(None);
    };
    let value = value.trim();
    let value = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .unwrap_or(value);
    let parsed = u32::from_str_radix(value, 16).map_err(|_| {
        RomWeaverError::Validation(format!(
            "PDS manifest field `{key}` is not a valid crc32 hex string"
        ))
    })?;
    Ok(Some(parsed))
}

fn build_manifest(source: &[u8], target: &[u8], payload: &str) -> String {
    format!(
        "# rom-weaver PDS manifest\nversion={PDS_VERSION}\nformat=bdf\npayload={}\nsource_size={}\ntarget_size={}\nsource_crc32={}\ntarget_crc32={}\n",
        normalize_entry_name(payload),
        source.len(),
        target.len(),
        format!("{:08x}", crc32(source)),
        format!("{:08x}", crc32(target)),
    )
}

fn resolve_payload_name(parsed: &ParsedPdsPatch) -> Result<String> {
    if let Some(payload) = &parsed.manifest.payload {
        return Ok(payload.clone());
    }

    if parsed.payloads.len() == 1 {
        return Ok(parsed.payloads[0].path.clone());
    }

    Err(RomWeaverError::Validation(
        "PDS manifest did not declare `payload=...` and archive did not contain exactly one payload entry"
            .into(),
    ))
}

fn resolve_payload_format(manifest: &PdsManifest, payload_name: &str) -> Result<String> {
    if let Some(format) = &manifest.format {
        return Ok(format.trim().to_ascii_lowercase());
    }

    infer_format_from_payload(payload_name).ok_or_else(|| {
        RomWeaverError::Validation(
            "PDS manifest did not declare `format=...` and payload extension was not recognized"
                .into(),
        )
    })
}

fn infer_format_from_payload(payload_name: &str) -> Option<String> {
    let lower = payload_name.to_ascii_lowercase();
    if BDF_FORMAT_ALIASES
        .iter()
        .any(|suffix| lower.ends_with(&format!(".{suffix}")))
    {
        return Some("bdf".to_string());
    }
    None
}

fn is_bdf_alias(name: &str) -> bool {
    BDF_FORMAT_ALIASES
        .iter()
        .any(|alias| alias.eq_ignore_ascii_case(name))
}

fn validate_source_expectations_path(
    manifest: &PdsManifest,
    source_path: &Path,
    validate_checksums: bool,
) -> Result<()> {
    if let Some(expected_size) = manifest.source_size {
        let actual_size = fs::metadata(source_path)?.len();
        if expected_size != actual_size {
            return Err(RomWeaverError::Validation(format!(
                "PDS source size mismatch: expected {expected_size}, actual {actual_size}"
            )));
        }
    }

    if validate_checksums {
        if let Some(expected_crc) = manifest.source_crc32 {
            let actual_crc = crc32_path(source_path)?;
            if expected_crc != actual_crc {
                return Err(RomWeaverError::Validation(format!(
                    "PDS source checksum mismatch: expected {:08x}, actual {:08x}",
                    expected_crc, actual_crc
                )));
            }
        }
    }

    if let Some(version) = manifest.version {
        if version != PDS_VERSION {
            return Err(RomWeaverError::Validation(format!(
                "PDS manifest version `{version}` is not supported (expected {PDS_VERSION})"
            )));
        }
    }

    Ok(())
}

fn validate_target_expectations_path(
    manifest: &PdsManifest,
    target_path: &Path,
    validate_checksums: bool,
) -> Result<()> {
    if let Some(expected_size) = manifest.target_size {
        let actual_size = fs::metadata(target_path)?.len();
        if expected_size != actual_size {
            return Err(RomWeaverError::Validation(format!(
                "PDS target size mismatch: expected {expected_size}, actual {actual_size}"
            )));
        }
    }

    if validate_checksums {
        if let Some(expected_crc) = manifest.target_crc32 {
            let actual_crc = crc32_path(target_path)?;
            if expected_crc != actual_crc {
                return Err(RomWeaverError::Validation(format!(
                    "PDS target checksum mismatch: expected {:08x}, actual {:08x}",
                    expected_crc, actual_crc
                )));
            }
        }
    }

    Ok(())
}

fn read_named_payload(path: &Path, payload_name: &str) -> Result<Vec<u8>> {
    let normalized_payload = normalize_entry_name(payload_name);
    let mut archive = open_archive(path)?;
    let mut matched_payload: Option<Vec<u8>> = None;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| {
            RomWeaverError::Validation(format!(
                "PDS payload entry #{index} could not be read: {error}"
            ))
        })?;

        if entry.is_dir() {
            continue;
        }

        let entry_name = normalize_entry_name(entry.name());
        if !entry_name.eq_ignore_ascii_case(&normalized_payload) {
            continue;
        }

        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).map_err(|error| {
            RomWeaverError::Validation(format!(
                "PDS payload `{entry_name}` could not be read: {error}"
            ))
        })?;

        if matched_payload.is_some() {
            return Err(RomWeaverError::Validation(format!(
                "PDS archive contains duplicate payload entries for `{normalized_payload}`"
            )));
        }
        matched_payload = Some(bytes);
    }

    matched_payload.ok_or_else(|| {
        RomWeaverError::Validation(format!(
            "PDS payload `{normalized_payload}` was not found in archive"
        ))
    })
}

fn apply_bdf_payload_to_writer(
    input: &[u8],
    payload: &[u8],
    output: &mut impl Write,
) -> Result<()> {
    let patcher = Bspatch::new(payload).map_err(|error| {
        RomWeaverError::Validation(format!(
            "PDS payload patch is not a valid BSDIFF40 stream: {error}"
        ))
    })?;
    patcher.apply(input, output)?;
    Ok(())
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut hasher = Hasher::new();
    hasher.update(bytes);
    hasher.finalize()
}

fn crc32_path(path: &Path) -> Result<u32> {
    let mut file = File::open(path)?;
    let mut buffer = vec![0u8; 64 * 1024];
    let mut hasher = Hasher::new();
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize())
}

fn open_archive(path: &Path) -> Result<ZipArchive<File>> {
    let file = File::open(path)?;
    ZipArchive::new(file).map_err(|error| {
        RomWeaverError::Validation(format!("PDS patch is not a valid ZIP archive: {error}"))
    })
}

fn map_file_read_only(path: &Path) -> Result<Mmap> {
    let file = File::open(path)?;
    // SAFETY: This mapping is read-only and the file handle lives through map creation.
    let map = unsafe { MmapOptions::new().map(&file)? };
    Ok(map)
}

fn is_manifest_entry(entry_name: &str) -> bool {
    let file_name = Path::new(entry_name)
        .file_name()
        .and_then(|name| name.to_str());
    file_name.is_some_and(|name| name.eq_ignore_ascii_case(PDS_MANIFEST_NAME))
}

fn normalize_entry_name(name: &str) -> String {
    name.trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_string()
}

fn pluralize(count: usize, singular: &'static str, plural: &'static str) -> &'static str {
    if count == 1 { singular } else { plural }
}

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        io::{Read, Write},
        path::{Path, PathBuf},
        sync::Arc,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use rom_weaver_core::{
        CancellationToken, NoopProgressSink, OperationContext, OperationStatus, PatchApplyRequest,
        PatchCreateRequest, PatchHandler, ThreadBudget,
    };
    use zip::{CompressionMethod, ZipArchive, ZipWriter, write::FileOptions};

    use super::{PDS_DEFAULT_PAYLOAD_NAME, PDS_MANIFEST_NAME, PdsPatchHandler};
    use crate::PDS;

    static NEXT_TEST_DIR_ID: AtomicU64 = AtomicU64::new(0);

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time")
                .as_nanos();
            let sequence = NEXT_TEST_DIR_ID.fetch_add(1, Ordering::Relaxed);
            let path = env::temp_dir().join(format!(
                "rom-weaver-pds-tests-{}-{timestamp}-{sequence}",
                std::process::id(),
            ));
            fs::create_dir_all(&path).expect("temp dir");
            Self { path }
        }

        fn child(&self, name: &str) -> PathBuf {
            self.path.join(name)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn parse_accepts_archive_with_patch_dat_manifest() {
        let temp = TestDir::new();
        let patch_path = temp.child("update.pds");
        write_archive(
            &patch_path,
            &[
                ("patch.dat", b"title=Demo Translation\n".as_slice()),
                ("data/script.bin", b"\x01\x02\x03"),
            ],
        );

        let handler = PdsPatchHandler::new(&PDS);
        let report = handler
            .parse(&patch_path, &test_context_with_threads(&temp, 1))
            .expect("parse");
        assert_eq!(report.status, OperationStatus::Succeeded);
        assert!(report.label.contains("manifest `patch.dat`"));
    }

    #[test]
    fn parse_rejects_non_zip_archives() {
        let temp = TestDir::new();
        let patch_path = temp.child("broken.pds");
        fs::write(&patch_path, b"not-a-zip").expect("fixture");

        let handler = PdsPatchHandler::new(&PDS);
        let error = handler
            .parse(&patch_path, &test_context_with_threads(&temp, 1))
            .expect_err("parse should fail");
        assert!(error.to_string().contains("not a valid ZIP archive"));
    }

    #[test]
    fn parse_rejects_missing_patch_dat_manifest() {
        let temp = TestDir::new();
        let patch_path = temp.child("missing-manifest.pds");
        write_archive(&patch_path, &[("data/payload.bin", b"\x00\x01\x02")]);

        let handler = PdsPatchHandler::new(&PDS);
        let error = handler
            .parse(&patch_path, &test_context_with_threads(&temp, 1))
            .expect_err("parse should fail");
        assert!(error.to_string().contains("missing required manifest"));
    }

    #[test]
    fn create_and_apply_round_trip() {
        let temp = TestDir::new();
        let original = temp.child("old.bin");
        let modified = temp.child("new.bin");
        let patch = temp.child("update.pds");
        let output = temp.child("out.bin");

        fs::write(&original, b"The quick brown fox jumps over the lazy dog.").expect("fixture");
        fs::write(&modified, b"The quick brown cat jumps over two lazy dogs!").expect("fixture");

        let handler = PdsPatchHandler::new(&PDS);
        let create = handler
            .create(
                &PatchCreateRequest {
                    original: original.clone(),
                    modified: modified.clone(),
                    output: patch.clone(),
                    format: "pds".into(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("create");

        assert_eq!(create.status, OperationStatus::Succeeded);
        assert!(create.label.contains("BSDIFF40 payload"));
        let execution = create.thread_execution.expect("thread execution");
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 1);
        assert!(!execution.used_parallelism);

        let apply = handler
            .apply(
                &PatchApplyRequest {
                    input: original,
                    patches: vec![patch],
                    output: output.clone(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("apply");

        assert_eq!(apply.status, OperationStatus::Succeeded);
        assert_eq!(
            fs::read(output).expect("output"),
            fs::read(modified).expect("modified")
        );
    }

    #[test]
    fn apply_rejects_source_checksum_mismatch() {
        let temp = TestDir::new();
        let original = temp.child("old.bin");
        let modified = temp.child("new.bin");
        let patch = temp.child("update.pds");
        let output = temp.child("out.bin");

        fs::write(&original, b"hello old world").expect("fixture");
        fs::write(&modified, b"hello new world").expect("fixture");

        let handler = PdsPatchHandler::new(&PDS);
        handler
            .create(
                &PatchCreateRequest {
                    original: original.clone(),
                    modified,
                    output: patch.clone(),
                    format: "pds".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("create");

        fs::write(&original, b"hello old wurld").expect("corrupt");
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: original,
                    patches: vec![patch],
                    output,
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect_err("apply should fail");

        assert!(error.to_string().contains("source checksum mismatch"));
    }

    #[test]
    fn create_writes_manifest_and_payload_entries() {
        let temp = TestDir::new();
        let original = temp.child("old.bin");
        let modified = temp.child("new.bin");
        let patch = temp.child("update.pds");

        fs::write(&original, b"hello old world").expect("fixture");
        fs::write(&modified, b"hello new world").expect("fixture");

        let handler = PdsPatchHandler::new(&PDS);
        handler
            .create(
                &PatchCreateRequest {
                    original,
                    modified,
                    output: patch.clone(),
                    format: "pds".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("create");

        let file = fs::File::open(&patch).expect("patch");
        let mut archive = ZipArchive::new(file).expect("zip");
        let mut names = Vec::new();
        for index in 0..archive.len() {
            let entry = archive.by_index(index).expect("entry");
            if !entry.is_dir() {
                names.push(entry.name().to_string());
            }
        }

        assert!(names.iter().any(|name| name.ends_with(PDS_MANIFEST_NAME)));
        assert!(
            names
                .iter()
                .any(|name| name.eq_ignore_ascii_case(PDS_DEFAULT_PAYLOAD_NAME))
        );

        let mut manifest = String::new();
        archive
            .by_name(PDS_MANIFEST_NAME)
            .expect("manifest")
            .read_to_string(&mut manifest)
            .expect("manifest text");
        assert!(manifest.contains("format=bdf"));
        assert!(manifest.contains("payload=patch.bdf"));
    }

    #[test]
    fn create_is_deterministic_across_thread_budgets() {
        let temp = TestDir::new();
        let original = temp.child("original-large.bin");
        let modified = temp.child("modified-large.bin");
        let single_patch = temp.child("single-thread.pds");
        let parallel_patch = temp.child("parallel-thread.pds");

        let source = build_large_fixture_bytes();
        let mut target = source.clone();
        for index in (0..target.len()).step_by(4096) {
            target[index] = target[index].wrapping_add(31);
        }
        fs::write(&original, &source).expect("fixture");
        fs::write(&modified, &target).expect("fixture");

        let handler = PdsPatchHandler::new(&PDS);
        let single_report = handler
            .create(
                &PatchCreateRequest {
                    original: original.clone(),
                    modified: modified.clone(),
                    output: single_patch.clone(),
                    format: "pds".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("single-thread create");
        let parallel_report = handler
            .create(
                &PatchCreateRequest {
                    original,
                    modified,
                    output: parallel_patch.clone(),
                    format: "pds".into(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("parallel create");

        let single_execution = single_report.thread_execution.expect("single execution");
        assert_eq!(single_execution.effective_threads, 1);
        assert!(!single_execution.used_parallelism);
        let parallel_execution = parallel_report
            .thread_execution
            .expect("parallel execution");
        assert_eq!(parallel_execution.requested_threads, 8);
        assert_eq!(parallel_execution.effective_threads, 8);
        assert!(parallel_execution.used_parallelism);

        let single_bytes = fs::read(&single_patch).expect("single-thread patch");
        let parallel_bytes = fs::read(&parallel_patch).expect("parallel-thread patch");
        assert_eq!(single_bytes, parallel_bytes);
    }

    fn write_archive(path: &Path, entries: &[(&str, &[u8])]) {
        let file = fs::File::create(path).expect("archive file");
        let mut writer = ZipWriter::new(file);
        let options = FileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, data) in entries {
            writer.start_file(*name, options).expect("start file");
            writer.write_all(data).expect("write file");
        }
        writer.finish().expect("finish archive");
    }

    fn test_context_with_threads(temp: &TestDir, threads: usize) -> OperationContext {
        OperationContext::new(
            ThreadBudget::Fixed(threads),
            temp.child("temp"),
            Arc::new(NoopProgressSink),
            CancellationToken::new(),
        )
    }

    fn build_large_fixture_bytes() -> Vec<u8> {
        let mut bytes = vec![0u8; 512 * 1024];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = ((index * 3) % 251) as u8;
        }
        bytes
    }
}
