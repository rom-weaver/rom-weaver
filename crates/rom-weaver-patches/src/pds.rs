use std::{fs::File, io::Read, path::Path};

use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchCreateRequest, PatchHandler, ProbeConfidence, Result, RomWeaverError,
    ThreadCapability,
};
use zip::ZipArchive;

const PDS_MANIFEST_NAME: &str = "patch.dat";
const MAX_MANIFEST_BYTES: usize = 4 * 1024 * 1024;

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
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "parse",
            format!(
                "parsed PDS archive with {} {} ({} payload {}; manifest `{}` {} byte(s))",
                parsed.entry_count,
                pluralize(parsed.entry_count, "entry", "entries"),
                parsed.payload_count,
                pluralize(parsed.payload_count, "entry", "entries"),
                parsed.manifest_path,
                parsed.manifest_size
            ),
            Some(1.0),
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
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        Ok(OperationReport::unsupported(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "apply",
            format!(
                "apply is not implemented yet for PDS (manifest `{}` with {} payload {})",
                parsed.manifest_path,
                parsed.payload_count,
                pluralize(parsed.payload_count, "entry", "entries")
            ),
            Some(execution),
        ))
    }

    fn create(
        &self,
        _request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        Ok(OperationReport::unsupported(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            "create is not implemented yet for PDS (PatcheRL-compatible patch.dat authoring is pending)",
            Some(execution),
        ))
    }

    fn capabilities(&self) -> PatchCapabilities {
        PatchCapabilities {
            parse: true,
            apply: false,
            create: false,
            threaded_scan: false,
            threaded_diff: false,
            threaded_output: false,
        }
    }
}

#[derive(Debug)]
struct ParsedPdsPatch {
    entry_count: usize,
    payload_count: usize,
    manifest_path: String,
    manifest_size: usize,
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
    let mut manifest_size = 0usize;

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
        let entry_name = entry.name().to_string();
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
            let mut manifest_bytes = Vec::with_capacity(declared_size);
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
            manifest_size = manifest_bytes.len();
            manifest_path = Some(entry_name);
        } else {
            payload_count = payload_count.checked_add(1).ok_or_else(|| {
                RomWeaverError::Validation("PDS payload entry count overflowed".into())
            })?;
        }
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

    Ok(ParsedPdsPatch {
        entry_count,
        payload_count,
        manifest_path,
        manifest_size,
    })
}

fn open_archive(path: &Path) -> Result<ZipArchive<File>> {
    let file = File::open(path)?;
    ZipArchive::new(file).map_err(|error| {
        RomWeaverError::Validation(format!("PDS patch is not a valid ZIP archive: {error}"))
    })
}

fn is_manifest_entry(entry_name: &str) -> bool {
    let file_name = Path::new(entry_name)
        .file_name()
        .and_then(|name| name.to_str());
    file_name.is_some_and(|name| name.eq_ignore_ascii_case(PDS_MANIFEST_NAME))
}

fn pluralize(count: usize, singular: &'static str, plural: &'static str) -> &'static str {
    if count == 1 { singular } else { plural }
}

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        io::Write,
        path::{Path, PathBuf},
        sync::Arc,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use rom_weaver_core::{
        CancellationToken, NoopProgressSink, OperationContext, OperationStatus, PatchApplyRequest,
        PatchCreateRequest, PatchHandler, ThreadBudget,
    };
    use zip::{CompressionMethod, ZipWriter, write::FileOptions};

    use super::PdsPatchHandler;
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
    fn apply_reports_unsupported_for_parsed_pds_archives() {
        let temp = TestDir::new();
        let input_path = temp.child("input.nds");
        let patch_path = temp.child("update.pds");
        let output_path = temp.child("output.nds");
        fs::write(&input_path, b"input").expect("fixture");
        write_archive(
            &patch_path,
            &[
                ("patch.dat", b"source_crc=1234".as_slice()),
                ("arm9.bin", b"patched"),
            ],
        );

        let handler = PdsPatchHandler::new(&PDS);
        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("apply report");
        assert_eq!(report.status, OperationStatus::Unsupported);
        assert_eq!(report.stage, "apply");
        assert!(report.label.contains("not implemented yet for PDS"));
    }

    #[test]
    fn create_reports_unsupported() {
        let temp = TestDir::new();
        let handler = PdsPatchHandler::new(&PDS);
        let report = handler
            .create(
                &PatchCreateRequest {
                    original: temp.child("source.nds"),
                    modified: temp.child("target.nds"),
                    output: temp.child("update.pds"),
                    format: "PDS".into(),
                },
                &test_context_with_threads(&temp, 2),
            )
            .expect("create report");
        assert_eq!(report.status, OperationStatus::Unsupported);
        assert_eq!(report.stage, "create");
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
}
