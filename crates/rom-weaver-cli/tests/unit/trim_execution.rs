use std::sync::atomic::{AtomicU32, Ordering};

use rom_weaver_core::{NoninteractivePrompter, NoopProgressSink};

use super::*;

/// Monotonic suffix so parallel tests in this file never share a scratch dir.
static SCRATCH_COUNTER: AtomicU32 = AtomicU32::new(0);

fn scratch_dir(label: &str) -> PathBuf {
    let unique = SCRATCH_COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "rw-trim-execution-{label}-{}-{unique}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

fn test_app() -> CliApp {
    CliApp::new(
        Arc::new(NoopProgressSink),
        Arc::new(NoninteractivePrompter),
        false,
        false,
        false,
    )
}

/// A header whose two CRCs are consistent, so `validate_nds_header` accepts it.
/// The logo CRC is stamped before the header CRC because the header CRC covers
/// the logo CRC field.
fn nds_header(dsi: bool, ntr_rom_size: u32, ntr_twl_rom_size: u32) -> Vec<u8> {
    let mut header = vec![0_u8; NDS_HEADER_TOTAL_BYTES];
    header[NDS_HEADER_UNIT_CODE_OFFSET] = u8::from(dsi) * 0x03;
    header[NDS_HEADER_NTR_ROM_SIZE_OFFSET..NDS_HEADER_NTR_ROM_SIZE_OFFSET + 4]
        .copy_from_slice(&ntr_rom_size.to_le_bytes());
    header[NDS_HEADER_HEADER_SIZE_OFFSET..NDS_HEADER_HEADER_SIZE_OFFSET + 4]
        .copy_from_slice(&0x4000_u32.to_le_bytes());
    header[NDS_HEADER_NTR_TWL_ROM_SIZE_OFFSET..NDS_HEADER_NTR_TWL_ROM_SIZE_OFFSET + 4]
        .copy_from_slice(&ntr_twl_rom_size.to_le_bytes());
    stamp_nds_crcs(&mut header);
    header
}

fn stamp_nds_crcs(header: &mut [u8]) {
    let logo_crc = CliApp::nds_crc16(
        &header[NDS_HEADER_LOGO_OFFSET..NDS_HEADER_LOGO_OFFSET + NDS_HEADER_LOGO_LENGTH],
    );
    header[NDS_HEADER_LOGO_CRC_OFFSET..NDS_HEADER_LOGO_CRC_OFFSET + 2]
        .copy_from_slice(&logo_crc.to_le_bytes());
    let header_crc = CliApp::nds_crc16(&header[..NDS_HEADER_CRC_OFFSET]);
    header[NDS_HEADER_CRC_OFFSET..NDS_HEADER_CRC_OFFSET + 2]
        .copy_from_slice(&header_crc.to_le_bytes());
}

fn nds_rom(header: &[u8], total_size: usize) -> Vec<u8> {
    let mut rom = header.to_vec();
    rom.resize(total_size, 0xFF);
    rom
}

fn write_fixture(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, bytes).expect("fixture write");
    path
}

/// `expect_err` needs `Debug` on the success type, and the trim outcomes are
/// plain internal structs without it.
trait ErrOrPanic {
    fn err_or_panic(self, context: &str) -> RomWeaverError;
}

impl<T> ErrOrPanic for Result<T> {
    fn err_or_panic(self, context: &str) -> RomWeaverError {
        match self {
            Ok(_) => panic!("expected an error: {context}"),
            Err(error) => error,
        }
    }
}

fn request(operation: TrimOperation, kind: TrimInputKind) -> TrimRequest {
    TrimRequest {
        in_place: false,
        dry_run: false,
        operation,
        kind,
        revert_marker: false,
    }
}

#[test]
fn read_u16_and_u32_report_the_field_they_could_not_read() {
    let buffer = [0x01_u8, 0x02, 0x03, 0x04];
    assert_eq!(
        CliApp::read_u16_le(&buffer, 0, "logo CRC").expect("in range"),
        0x0201
    );
    assert_eq!(
        CliApp::read_u32_le(&buffer, 0, "header size").expect("in range"),
        0x0403_0201
    );
    let error = CliApp::read_u16_le(&buffer, 3, "logo CRC").err_or_panic("past the end");
    assert!(
        error.to_string().contains("missing logo CRC bytes"),
        "{error}"
    );
    let error = CliApp::read_u32_le(&buffer, 1, "header size").err_or_panic("past the end");
    assert!(
        error.to_string().contains("missing header size bytes"),
        "{error}"
    );
}

#[test]
fn nds_crc16_matches_the_documented_seed_and_polynomial() {
    assert_eq!(CliApp::nds_crc16(&[]), 0xFFFF);
    assert_eq!(CliApp::nds_crc16(&[0x00]), 0x40BF);
    assert_eq!(CliApp::nds_crc16(b"123456789"), 0x4B37);
}

#[test]
fn validate_nds_header_rejects_a_truncated_buffer() {
    let error = CliApp::validate_nds_header(&[0_u8; 16]).err_or_panic("truncated");
    assert!(
        error.to_string().contains("NDS header buffer is truncated"),
        "{error}"
    );
}

#[test]
fn validate_nds_header_rejects_an_undersized_header_size() {
    let mut header = nds_header(false, 0x2000, 0x2000);
    header[NDS_HEADER_HEADER_SIZE_OFFSET..NDS_HEADER_HEADER_SIZE_OFFSET + 4]
        .copy_from_slice(&0x100_u32.to_le_bytes());
    stamp_nds_crcs(&mut header);
    let error = CliApp::validate_nds_header(&header).err_or_panic("header size below 0x160");
    assert!(
        error.to_string().contains("invalid NDS header size 0x100"),
        "{error}"
    );
}

#[test]
fn validate_nds_header_rejects_a_bad_logo_crc() {
    let mut header = nds_header(false, 0x2000, 0x2000);
    header[NDS_HEADER_LOGO_OFFSET] ^= 0xFF;
    let error = CliApp::validate_nds_header(&header).err_or_panic("logo crc");
    assert!(
        error.to_string().contains("NDS logo CRC mismatch"),
        "{error}"
    );
}

#[test]
fn validate_nds_header_rejects_a_bad_header_crc() {
    let mut header = nds_header(false, 0x2000, 0x2000);
    header[NDS_HEADER_CRC_OFFSET] ^= 0xFF;
    let error = CliApp::validate_nds_header(&header).err_or_panic("header crc");
    assert!(
        error.to_string().contains("NDS header CRC mismatch"),
        "{error}"
    );
}

#[test]
fn an_nds_plan_reads_the_ntr_boundary_for_a_ds_cart() {
    let dir = scratch_dir("plan-ds");
    let rom = write_fixture(
        &dir,
        "game.nds",
        &nds_rom(&nds_header(false, 0x2000, 0x8000), 0x4000),
    );
    let mut file = File::open(&rom).expect("open");
    let plan = CliApp::read_nds_trim_plan(&mut file, 0x4000, false, 0).expect("plan");
    assert_eq!(plan.trimmed_size, 0x2000);
    assert!(!plan.dsi_mode);
    assert!(!plan.preserved_download_play_cert);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn an_nds_plan_reads_the_twl_boundary_for_a_dsi_cart() {
    let dir = scratch_dir("plan-dsi");
    let rom = write_fixture(
        &dir,
        "game.dsi",
        &nds_rom(&nds_header(true, 0x2000, 0x3000), 0x4000),
    );
    let mut file = File::open(&rom).expect("open");
    let plan = CliApp::read_nds_trim_plan(&mut file, 0x4000, false, 0).expect("plan");
    assert_eq!(plan.trimmed_size, 0x3000);
    assert!(plan.dsi_mode);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_download_play_certificate_extends_the_ds_trim_boundary() {
    let dir = scratch_dir("plan-cert");
    let mut bytes = nds_rom(&nds_header(false, 0x2000, 0x8000), 0x4000);
    bytes[0x2000] = NDS_DOWNLOAD_PLAY_CERT_MAGIC[0];
    bytes[0x2001] = NDS_DOWNLOAD_PLAY_CERT_MAGIC[1];
    let rom = write_fixture(&dir, "game.nds", &bytes);
    let mut file = File::open(&rom).expect("open");
    let plan = CliApp::read_nds_trim_plan(&mut file, 0x4000, false, 0).expect("plan");
    assert_eq!(
        plan.trimmed_size,
        0x2000 + NDS_DOWNLOAD_PLAY_CERT_SIZE_BYTES
    );
    assert!(plan.preserved_download_play_cert);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn an_nds_plan_rejects_a_zero_trim_boundary() {
    let dir = scratch_dir("plan-zero");
    let rom = write_fixture(&dir, "game.nds", &nds_rom(&nds_header(false, 0, 0), 0x4000));
    let mut file = File::open(&rom).expect("open");
    let error =
        CliApp::read_nds_trim_plan(&mut file, 0x4000, false, 0).err_or_panic("zero boundary");
    assert!(
        error
            .to_string()
            .contains("NDS header reported a zero trim boundary"),
        "{error}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn an_nds_plan_rejects_a_boundary_past_the_end_unless_reverting() {
    let dir = scratch_dir("plan-past-eof");
    let rom = write_fixture(
        &dir,
        "game.nds",
        &nds_rom(&nds_header(false, 0x9000, 0x9000), 0x4000),
    );
    let mut file = File::open(&rom).expect("open");
    let error =
        CliApp::read_nds_trim_plan(&mut file, 0x4000, false, 0).err_or_panic("boundary past eof");
    assert!(error.to_string().contains("exceeds input size"), "{error}");
    let plan = CliApp::read_nds_trim_plan(&mut file, 0x4000, true, 0)
        .expect("revert tolerates a boundary past eof");
    assert_eq!(plan.trimmed_size, 0x9000);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn trimming_an_nds_rom_writes_the_boundary_sized_output() {
    let dir = scratch_dir("nds-trim");
    let rom = write_fixture(
        &dir,
        "game.nds",
        &nds_rom(&nds_header(false, 0x2000, 0x8000), 0x4000),
    );
    let destination = dir.join("out/game.nds");
    let outcome =
        CliApp::trim_nds_file(&rom, &destination, false, false, TrimOperation::Trim).expect("trim");
    assert_eq!(outcome.original_size, 0x4000);
    assert_eq!(outcome.result_size, 0x2000);
    assert_eq!(outcome.output_path, destination);
    assert_eq!(outcome.mode, "ds");
    assert!(!outcome.already_target_size);
    assert!(outcome.revert_supported);
    assert_eq!(fs::metadata(&destination).expect("output").len(), 0x2000);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn an_nds_dry_run_reports_the_target_without_writing() {
    let dir = scratch_dir("nds-dry-run");
    let rom = write_fixture(
        &dir,
        "game.nds",
        &nds_rom(&nds_header(true, 0x2000, 0x3000), 0x4000),
    );
    let destination = dir.join("out.nds");
    let outcome = CliApp::trim_nds_file(&rom, &destination, true, true, TrimOperation::Trim)
        .expect("dry run");
    assert_eq!(outcome.result_size, 0x3000);
    assert_eq!(outcome.mode, "dsi");
    assert_eq!(outcome.output_path, rom, "in-place reports the source path");
    assert!(!destination.exists());
    assert_eq!(fs::metadata(&rom).expect("source").len(), 0x4000);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn reverting_an_nds_rom_pads_back_to_the_next_power_of_two_with_ff() {
    let dir = scratch_dir("nds-revert");
    let rom = write_fixture(
        &dir,
        "game.nds",
        &nds_rom(&nds_header(false, 0x2000, 0x8000), 0x3000),
    );
    let destination = dir.join("reverted.nds");
    let outcome = CliApp::trim_nds_file(&rom, &destination, false, false, TrimOperation::Revert)
        .expect("revert");
    assert_eq!(outcome.result_size, 0x4000);
    let reverted = fs::read(&destination).expect("reverted");
    assert_eq!(reverted.len(), 0x4000);
    assert!(
        reverted[0x3000..].iter().all(|byte| *byte == 0xFF),
        "NDS carts pad with 0xFF"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn an_nds_revert_never_drops_below_the_header_boundary() {
    let dir = scratch_dir("nds-revert-floor");
    // Already a power of two, but smaller than the header's own boundary, so
    // the boundary wins over the power-of-two target.
    let rom = write_fixture(
        &dir,
        "game.nds",
        &nds_rom(&nds_header(false, 0x5000, 0x5000), 0x4000),
    );
    let destination = dir.join("reverted.nds");
    let outcome = CliApp::trim_nds_file(&rom, &destination, false, false, TrimOperation::Revert)
        .expect("revert");
    assert_eq!(outcome.result_size, 0x5000);
    assert!(!outcome.already_target_size);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn an_nds_input_smaller_than_a_header_is_refused() {
    let dir = scratch_dir("nds-too-small");
    let rom = write_fixture(&dir, "game.nds", &[0x00; 16]);
    let error = CliApp::trim_nds_file(
        &rom,
        &dir.join("out.nds"),
        false,
        false,
        TrimOperation::Trim,
    )
    .err_or_panic("too small");
    assert!(
        error
            .to_string()
            .contains("too small to contain a valid NDS/DSi header"),
        "{error}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_power_of_two_trim_removes_the_detected_padding() {
    let dir = scratch_dir("gba-trim");
    let mut bytes = vec![0x42_u8; 1000];
    bytes.resize(4096, 0xFF);
    let rom = write_fixture(&dir, "game.gba", &bytes);
    let destination = dir.join("trimmed.gba");
    let outcome = CliApp::trim_power_of_two_file(
        &rom,
        &destination,
        false,
        false,
        TrimOperation::Trim,
        TrimInputKind::Gba,
    )
    .expect("trim");
    assert_eq!(outcome.original_size, 4096);
    assert_eq!(outcome.result_size, 1000);
    assert_eq!(outcome.mode, "gba");
    assert!(!outcome.already_target_size);
    assert_eq!(fs::read(&destination).expect("trimmed").len(), 1000);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_power_of_two_trim_leaves_a_rom_without_recognizable_padding() {
    let dir = scratch_dir("3ds-no-padding");
    let rom = write_fixture(&dir, "game.3ds", &vec![0x42_u8; 1024]);
    let destination = dir.join("trimmed.3ds");
    let outcome = CliApp::trim_power_of_two_file(
        &rom,
        &destination,
        false,
        false,
        TrimOperation::Trim,
        TrimInputKind::ThreeDs,
    )
    .expect("trim");
    assert_eq!(outcome.result_size, 1024);
    assert!(outcome.already_target_size);
    assert_eq!(outcome.mode, "3ds");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_power_of_two_revert_pads_up_to_the_next_power_of_two() {
    let dir = scratch_dir("gba-revert");
    let rom = write_fixture(&dir, "game.gba", &vec![0x42_u8; 1000]);
    let destination = dir.join("reverted.gba");
    let outcome = CliApp::trim_power_of_two_file(
        &rom,
        &destination,
        false,
        false,
        TrimOperation::Revert,
        TrimInputKind::Gba,
    )
    .expect("revert");
    assert_eq!(outcome.result_size, 1024);
    let reverted = fs::read(&destination).expect("reverted");
    assert!(
        reverted[1000..].iter().all(|byte| *byte == 0xFF),
        "GBA carts pad with 0xFF"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_power_of_two_dry_run_reports_without_writing() {
    let dir = scratch_dir("gba-dry-run");
    let mut bytes = vec![0x42_u8; 1000];
    bytes.resize(4096, 0xFF);
    let rom = write_fixture(&dir, "game.gba", &bytes);
    let destination = dir.join("trimmed.gba");
    let outcome = CliApp::trim_power_of_two_file(
        &rom,
        &destination,
        false,
        true,
        TrimOperation::Trim,
        TrimInputKind::Gba,
    )
    .expect("dry run");
    assert_eq!(outcome.result_size, 1000);
    assert!(!destination.exists());
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_power_of_two_trim_refuses_an_empty_input() {
    let dir = scratch_dir("gba-empty");
    let rom = write_fixture(&dir, "game.gba", &[]);
    let error = CliApp::trim_power_of_two_file(
        &rom,
        &dir.join("out.gba"),
        false,
        false,
        TrimOperation::Trim,
        TrimInputKind::Gba,
    )
    .err_or_panic("empty input");
    assert!(error.to_string().contains("input is empty"), "{error}");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn an_xiso_trim_refuses_revert_and_empty_input() {
    let dir = scratch_dir("xiso-refusals");
    let rom = write_fixture(&dir, "game.xiso", &[]);
    let error = CliApp::trim_xiso_file(
        &rom,
        &dir.join("out.xiso"),
        false,
        false,
        TrimOperation::Revert,
    )
    .err_or_panic("revert unsupported");
    assert!(
        error
            .to_string()
            .contains("xiso trim revert is not supported"),
        "{error}"
    );
    let error = CliApp::trim_xiso_file(
        &rom,
        &dir.join("out.xiso"),
        false,
        false,
        TrimOperation::Trim,
    )
    .err_or_panic("empty input");
    assert!(error.to_string().contains("input is empty"), "{error}");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn an_xiso_source_that_is_not_an_xdvdfs_image_is_reported() {
    let dir = scratch_dir("xiso-not-an-image");
    let rom = write_fixture(&dir, "game.xiso", &vec![0x42_u8; 4096]);

    let error = CliApp::open_xiso_trim_source_filesystem(&rom).err_or_panic("not xdvdfs");
    assert!(
        error.to_string().contains("is not an Xbox XDVDFS image"),
        "{error}"
    );

    let error = CliApp::open_xiso_trim_source_filesystem(&dir.join("absent.xiso"))
        .err_or_panic("missing file");
    assert!(
        error.to_string().contains("failed to open xiso source"),
        "{error}"
    );

    let error = CliApp::trim_xiso_file(
        &rom,
        &dir.join("out.xiso"),
        false,
        true,
        TrimOperation::Trim,
    )
    .err_or_panic("dry run cannot rebuild");
    assert!(
        error
            .to_string()
            .contains("xiso trim simulation failed while rebuilding"),
        "{error}"
    );

    let error = CliApp::trim_xiso_file(
        &rom,
        &dir.join("out/out.xiso"),
        false,
        false,
        TrimOperation::Trim,
    )
    .err_or_panic("rebuild fails");
    assert!(
        error.to_string().contains("is not an Xbox XDVDFS image"),
        "{error}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_failed_in_place_xiso_trim_leaves_no_temp_file_behind() {
    let dir = scratch_dir("xiso-in-place-failure");
    let rom = write_fixture(&dir, "game.xiso", &vec![0x42_u8; 4096]);
    let error = CliApp::trim_xiso_file(&rom, &rom, true, false, TrimOperation::Trim)
        .err_or_panic("rebuild fails");
    assert!(
        error.to_string().contains("is not an Xbox XDVDFS image"),
        "{error}"
    );

    let leftovers: Vec<PathBuf> = fs::read_dir(&dir)
        .expect("scan dir")
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains(XISO_TRIM_TEMP_SUFFIX))
        })
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    assert_eq!(
        fs::metadata(&rom).expect("source").len(),
        4096,
        "the source is untouched"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn the_temporary_xiso_path_is_hidden_and_sits_beside_the_source() {
    let path = CliApp::temporary_xiso_trim_path(Path::new("/games/discs/game.xiso"));
    assert_eq!(path.parent(), Some(Path::new("/games/discs")));
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .expect("temp name");
    assert!(name.starts_with(".game.xiso."), "{name}");
    assert!(name.contains(XISO_TRIM_TEMP_SUFFIX), "{name}");
    assert_ne!(
        path,
        CliApp::temporary_xiso_trim_path(Path::new("/games/discs/game.xiso")),
        "each attempt gets its own temp name"
    );
}

#[test]
fn an_rvz_scrub_trim_refuses_revert_empty_input_and_in_place() {
    let dir = scratch_dir("rvz-refusals");
    let app = test_app();
    let context = app.context(ThreadBudget::Fixed(1));
    let empty = write_fixture(&dir, "empty.rvz", &[]);
    let error = app
        .trim_rvz_scrub_file(
            &empty,
            &dir.join("out.rvz"),
            false,
            false,
            TrimOperation::Revert,
            &context,
        )
        .err_or_panic("revert unsupported");
    assert!(
        error
            .to_string()
            .contains("rvz-scrub trim revert is not supported"),
        "{error}"
    );
    let error = app
        .trim_rvz_scrub_file(
            &empty,
            &dir.join("out.rvz"),
            false,
            false,
            TrimOperation::Trim,
            &context,
        )
        .err_or_panic("empty input");
    assert!(error.to_string().contains("input is empty"), "{error}");

    let source = write_fixture(&dir, "game.rvz", &vec![0x42_u8; 4096]);
    let error = app
        .trim_rvz_scrub_file(&source, &source, true, false, TrimOperation::Trim, &context)
        .err_or_panic("in-place unsupported");
    assert!(
        error
            .to_string()
            .contains("requires a separate output file"),
        "{error}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn an_rvz_scrub_of_a_non_disc_source_reports_the_rebuild_failure() {
    let dir = scratch_dir("rvz-not-a-disc");
    let app = test_app();
    let context = app.context(ThreadBudget::Fixed(1));
    let source = write_fixture(&dir, "game.rvz", &vec![0x42_u8; 4096]);

    let error = app
        .trim_rvz_scrub_file(
            &source,
            &dir.join("out.rvz"),
            false,
            true,
            TrimOperation::Trim,
            &context,
        )
        .err_or_panic("dry run cannot rebuild");
    assert!(
        error
            .to_string()
            .contains("rvz-scrub trim simulation failed while rebuilding"),
        "{error}"
    );

    let error = app
        .trim_rvz_scrub_file(
            &source,
            &dir.join("out/out.rvz"),
            false,
            false,
            TrimOperation::Trim,
            &context,
        )
        .err_or_panic("rebuild fails");
    assert!(
        error
            .to_string()
            .contains("rvz-scrub trim failed while rebuilding"),
        "{error}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn write_padding_bytes_spans_more_than_one_chunk() {
    let mut sink = Vec::new();
    CliApp::write_padding_bytes(&mut sink, 0, 0xFF).expect("no padding");
    assert!(sink.is_empty());

    CliApp::write_padding_bytes(&mut sink, 8192 + 7, 0xAB).expect("padding");
    assert_eq!(sink.len(), 8192 + 7);
    assert!(sink.iter().all(|byte| *byte == 0xAB));
}

#[test]
fn applying_a_size_target_in_place_shrinks_and_grows_the_source() {
    let dir = scratch_dir("size-target-in-place");
    let rom = write_fixture(&dir, "game.bin", &[0x42_u8; 100]);

    CliApp::apply_file_size_target(&rom, &rom, true, 100, 40, 0x00).expect("shrink");
    assert_eq!(fs::read(&rom).expect("read").len(), 40);

    CliApp::apply_file_size_target(&rom, &rom, true, 40, 64, 0xFF).expect("grow");
    let grown = fs::read(&rom).expect("read");
    assert_eq!(grown.len(), 64);
    assert!(grown[40..].iter().all(|byte| *byte == 0xFF));

    CliApp::apply_file_size_target(&rom, &rom, true, 64, 64, 0x00).expect("no change");
    assert_eq!(fs::metadata(&rom).expect("meta").len(), 64);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn applying_a_size_target_to_a_new_file_creates_its_parent_directory() {
    let dir = scratch_dir("size-target-copy");
    let rom = write_fixture(&dir, "game.bin", &[0x42_u8; 100]);
    let destination = dir.join("nested/deeper/out.bin");

    CliApp::apply_file_size_target(&rom, &destination, false, 100, 150, 0x5A).expect("grow copy");
    let written = fs::read(&destination).expect("read");
    assert_eq!(written.len(), 150);
    assert!(written[..100].iter().all(|byte| *byte == 0x42));
    assert!(written[100..].iter().all(|byte| *byte == 0x5A));
    assert_eq!(
        fs::metadata(&rom).expect("source").len(),
        100,
        "the source is left alone"
    );

    let shrunk = dir.join("shrunk.bin");
    CliApp::apply_file_size_target(&rom, &shrunk, false, 100, 30, 0x00).expect("shrink copy");
    assert_eq!(fs::read(&shrunk).expect("read").len(), 30);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_revert_marker_trim_round_trips_the_original_bytes() {
    let dir = scratch_dir("revert-marker");
    let app = test_app();
    let context = app.context(ThreadBudget::Fixed(1));
    let mut bytes = vec![0x42_u8; 1000];
    bytes.resize(4096, 0xFF);
    let rom = write_fixture(&dir, "game.gba", &bytes);
    let trimmed = dir.join("trimmed.gba");

    let outcome = app
        .trim_file(
            &rom,
            &trimmed,
            TrimRequest {
                revert_marker: true,
                ..request(TrimOperation::Trim, TrimInputKind::Gba)
            },
            &context,
        )
        .expect("trim");
    assert_eq!(outcome.result_size, 1000);
    assert!(
        fs::metadata(&trimmed).expect("trimmed").len() > 1000,
        "the footer is appended after the trimmed data"
    );

    let reverted = dir.join("reverted.gba");
    app.trim_file(
        &trimmed,
        &reverted,
        request(TrimOperation::Revert, TrimInputKind::Gba),
        &context,
    )
    .expect("revert");
    assert_eq!(
        fs::read(&reverted).expect("reverted"),
        bytes,
        "the footer restores the original bytes exactly"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_revert_marker_is_not_written_when_nothing_was_trimmed() {
    let dir = scratch_dir("revert-marker-noop");
    let app = test_app();
    let context = app.context(ThreadBudget::Fixed(1));
    let bytes = vec![0x42_u8; 1024];
    let rom = write_fixture(&dir, "game.gba", &bytes);
    let trimmed = dir.join("trimmed.gba");

    let outcome = app
        .trim_file(
            &rom,
            &trimmed,
            TrimRequest {
                revert_marker: true,
                ..request(TrimOperation::Trim, TrimInputKind::Gba)
            },
            &context,
        )
        .expect("trim");
    assert!(outcome.already_target_size);
    assert_eq!(
        fs::read(&trimmed).expect("trimmed"),
        bytes,
        "a clean ROM is never grown by a footer"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_dry_run_trim_never_writes_a_revert_footer() {
    let dir = scratch_dir("revert-marker-dry-run");
    let app = test_app();
    let context = app.context(ThreadBudget::Fixed(1));
    let mut bytes = vec![0x42_u8; 1000];
    bytes.resize(4096, 0xFF);
    let rom = write_fixture(&dir, "game.gba", &bytes);
    let trimmed = dir.join("trimmed.gba");

    app.trim_file(
        &rom,
        &trimmed,
        TrimRequest {
            dry_run: true,
            revert_marker: true,
            ..request(TrimOperation::Trim, TrimInputKind::Gba)
        },
        &context,
    )
    .expect("dry run");
    assert!(!trimmed.exists());
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn trim_file_dispatches_each_input_kind_to_its_own_refusal() {
    let dir = scratch_dir("dispatch");
    let app = test_app();
    let context = app.context(ThreadBudget::Fixed(1));
    let empty = write_fixture(&dir, "empty.bin", &[]);

    for (kind, expected) in [
        (TrimInputKind::Xiso, "xiso trim revert is not supported"),
        (
            TrimInputKind::RvzScrub,
            "rvz-scrub trim revert is not supported",
        ),
    ] {
        let error = app
            .trim_file(
                &empty,
                &dir.join("out.bin"),
                request(TrimOperation::Revert, kind),
                &context,
            )
            .err_or_panic("revert unsupported");
        assert!(error.to_string().contains(expected), "{error}");
    }

    let error = app
        .trim_file(
            &empty,
            &dir.join("out.bin"),
            request(TrimOperation::Trim, TrimInputKind::NdsFamily),
            &context,
        )
        .err_or_panic("nds needs a header");
    assert!(
        error
            .to_string()
            .contains("too small to contain a valid NDS/DSi header"),
        "{error}"
    );
    fs::remove_dir_all(&dir).ok();
}
