use std::sync::atomic::{AtomicU32, Ordering};

use rom_weaver_core::{NoninteractivePrompter, NoopProgressSink};

use super::*;

/// Monotonic suffix so parallel tests in this file never share a scratch dir.
static SCRATCH_COUNTER: AtomicU32 = AtomicU32::new(0);

fn scratch_dir(label: &str) -> PathBuf {
    let unique = SCRATCH_COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.agent/trim-fixes/rom-safety")
        .join(format!(
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
        .copy_from_slice(&0x1000_u32.to_le_bytes());
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
    let mut bytes = vec![0x42_u8; 1024];
    bytes[0x100..0x104].copy_from_slice(b"NCCH");
    bytes[0x18E] = 0;
    bytes[0x104..0x108].copy_from_slice(&2_u32.to_le_bytes());
    let rom = write_fixture(&dir, "game.3ds", &bytes);
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
fn retrimming_a_marked_gba_strips_only_its_footer() {
    let dir = scratch_dir("revert-marker-retrim-gba");
    let app = test_app();
    // This layout's footer CRC ends in 0x00, which a trailing-padding scan would treat as fill.
    let mut bytes = vec![0x42_u8; 0x6F_FF9C];
    bytes.resize(0x80_0000, 0xFF);
    let rom = write_fixture(&dir, "game.gba", &bytes);
    let marker_trim = TrimRequest {
        revert_marker: true,
        ..request(TrimOperation::Trim, TrimInputKind::Gba)
    };

    let first = dir.join("first.gba");
    app.trim_file(&rom, &first, marker_trim)
        .expect("first trim");
    let first_bytes = fs::read(&first).expect("first");
    assert!(
        matches!(first_bytes.last(), Some(0x00 | 0xFF)),
        "fixture must end in a padding-like CRC byte"
    );
    let second = dir.join("second.gba");
    app.trim_file(&first, &second, marker_trim)
        .expect("second trim");
    assert_eq!(
        fs::read(&second).expect("second"),
        first_bytes,
        "the old footer is replaced, not partly kept"
    );

    let reverted = dir.join("reverted.gba");
    app.trim_file(
        &second,
        &reverted,
        request(TrimOperation::Revert, TrimInputKind::Gba),
    )
    .expect("revert");
    assert_eq!(fs::read(&reverted).expect("reverted"), bytes);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn trimming_a_marked_rom_again_keeps_the_original_restore_data() {
    let dir = scratch_dir("revert-marker-retrim");
    let app = test_app();
    let bytes = nds_rom(&nds_header(false, 0x2000, 0x8000), 0x8000);
    let rom = write_fixture(&dir, "game.nds", &bytes);
    let marker_trim = TrimRequest {
        revert_marker: true,
        ..request(TrimOperation::Trim, TrimInputKind::NdsFamily)
    };

    let first = dir.join("first.nds");
    app.trim_file(&rom, &first, marker_trim)
        .expect("first trim");
    let second = dir.join("second.nds");
    let outcome = app
        .trim_file(&first, &second, marker_trim)
        .expect("second trim");
    assert!(
        !outcome.already_target_size,
        "the second trim strips the footer"
    );

    let reverted = dir.join("reverted.nds");
    app.trim_file(
        &second,
        &reverted,
        request(TrimOperation::Revert, TrimInputKind::NdsFamily),
    )
    .expect("revert");
    assert_eq!(
        fs::read(&reverted).expect("reverted"),
        bytes,
        "the rewritten footer still restores the original bytes"
    );
    fs::remove_dir_all(&dir).ok();
}

/// Hand-built legacy 14-byte footer: `RWT\x01` + pad_byte + 40-bit LE pad_len + CRC-32 of the
/// preceding 10 bytes. Uses `crc32fast` so the check is independent of the production CRC helper.
fn legacy_revert_footer(pad_byte: u8, pad_len: u64) -> Vec<u8> {
    let mut footer = b"RWT\x01".to_vec();
    footer.push(pad_byte);
    footer.extend_from_slice(&pad_len.to_le_bytes()[..5]);
    let crc = crc32fast::hash(&footer);
    footer.extend_from_slice(&crc.to_le_bytes());
    assert_eq!(footer.len(), 14);
    footer
}

#[test]
fn a_new_revert_footer_is_twelve_bytes_starting_with_rw() {
    let dir = scratch_dir("revert-footer-layout");
    let path = write_fixture(&dir, "trimmed.bin", &[0x42_u8; 1000]);

    CliApp::write_revert_footer(&path, 0x01_0000_0000_u64 + 1000, 0xA5).expect("footer");

    let written = fs::read(&path).expect("read");
    assert_eq!(written.len(), 1000 + 12);
    let footer = &written[1000..];
    assert_eq!(&footer[..2], b"RW");
    assert_eq!(footer[2], 0xA5, "pad byte");
    assert_eq!(
        &footer[3..8],
        &[0x00, 0x00, 0x00, 0x00, 0x01],
        "40-bit LE pad_len"
    );
    assert_eq!(
        footer[8..],
        crc32fast::hash(&footer[..8]).to_le_bytes(),
        "CRC-32 covers the preceding 8 bytes"
    );

    let read = CliApp::read_revert_footer(&path)
        .expect("read footer")
        .expect("valid footer");
    assert_eq!(read.footer_len, 12);
    assert_eq!(read.pad_byte, 0xA5);
    assert_eq!(read.original_size, 0x01_0000_0000_u64 + 1000);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_legacy_revert_footer_still_restores_byte_identically() {
    let dir = scratch_dir("revert-footer-legacy");
    let app = test_app();
    // 0x00 padding differs from the 0xFF fallback, so only the footer can restore it.
    let mut original = vec![0x42_u8; 1000];
    original.resize(4096, 0x00);
    let mut legacy = original[..1000].to_vec();
    legacy.extend_from_slice(&legacy_revert_footer(0x00, 4096 - 1000));
    let trimmed = write_fixture(&dir, "legacy.gba", &legacy);

    let read = CliApp::read_revert_footer(&trimmed)
        .expect("read footer")
        .expect("valid legacy footer");
    assert_eq!(read.footer_len, 14);
    assert_eq!(read.original_size, 4096);

    let reverted = dir.join("reverted.gba");
    app.trim_file(
        &trimmed,
        &reverted,
        request(TrimOperation::Revert, TrimInputKind::Gba),
    )
    .expect("revert");
    assert_eq!(fs::read(&reverted).expect("reverted"), original);

    // In place restores the same bytes.
    app.trim_file(
        &trimmed,
        &trimmed,
        TrimRequest {
            in_place: true,
            ..request(TrimOperation::Revert, TrimInputKind::Gba)
        },
    )
    .expect("in-place revert");
    assert_eq!(fs::read(&trimmed).expect("reverted"), original);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn retrimming_a_rom_with_a_legacy_footer_writes_a_new_rw_footer() {
    let dir = scratch_dir("revert-footer-legacy-retrim");
    let app = test_app();
    let original = nds_rom(&nds_header(false, 0x2000, 0x8000), 0x8000);
    let mut legacy = original[..0x2000].to_vec();
    legacy.extend_from_slice(&legacy_revert_footer(0xFF, 0x8000 - 0x2000));
    let source = write_fixture(&dir, "legacy.nds", &legacy);

    let retrimmed = dir.join("retrimmed.nds");
    app.trim_file(
        &source,
        &retrimmed,
        TrimRequest {
            revert_marker: true,
            ..request(TrimOperation::Trim, TrimInputKind::NdsFamily)
        },
    )
    .expect("re-trim");

    let written = fs::read(&retrimmed).expect("re-trimmed");
    assert_eq!(
        written.len(),
        0x2000 + 12,
        "legacy footer replaced by a 12-byte footer"
    );
    assert_eq!(&written[0x2000..0x2002], b"RW");
    assert_eq!(&written[..0x2000], &original[..0x2000]);

    let reverted = dir.join("reverted.nds");
    app.trim_file(
        &retrimmed,
        &reverted,
        request(TrimOperation::Revert, TrimInputKind::NdsFamily),
    )
    .expect("revert");
    assert_eq!(fs::read(&reverted).expect("reverted"), original);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_revert_footer_with_a_corrupt_crc_is_ignored() {
    let dir = scratch_dir("revert-footer-corrupt-crc");

    let current = write_fixture(&dir, "current.bin", &[0x42_u8; 1000]);
    CliApp::write_revert_footer(&current, 4096, 0x00).expect("footer");
    assert!(
        CliApp::read_revert_footer(&current)
            .expect("read")
            .is_some()
    );
    let mut bytes = fs::read(&current).expect("read");
    *bytes.last_mut().expect("footer byte") ^= 0xFF;
    fs::write(&current, &bytes).expect("corrupt");
    assert!(
        CliApp::read_revert_footer(&current)
            .expect("read")
            .is_none(),
        "a corrupt CRC invalidates the RW footer"
    );

    let mut legacy = vec![0x42_u8; 1000];
    legacy.extend_from_slice(&legacy_revert_footer(0x00, 3096));
    let legacy_path = write_fixture(&dir, "legacy.bin", &legacy);
    assert!(
        CliApp::read_revert_footer(&legacy_path)
            .expect("read")
            .is_some()
    );
    *legacy.last_mut().expect("footer byte") ^= 0xFF;
    fs::write(&legacy_path, &legacy).expect("corrupt");
    assert!(
        CliApp::read_revert_footer(&legacy_path)
            .expect("read")
            .is_none(),
        "a corrupt CRC invalidates the legacy footer"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_revert_footer_past_the_forty_bit_pad_length_is_rejected() {
    let dir = scratch_dir("revert-footer-max-pad");
    let path = write_fixture(&dir, "trimmed.bin", &[0x42_u8; 16]);
    let error = CliApp::write_revert_footer(&path, 16 + (1_u64 << 40), 0xFF)
        .err_or_panic("pad_len needs more than 40 bits");
    assert!(error.to_string().contains("too large"), "{error}");
    assert_eq!(fs::metadata(&path).expect("meta").len(), 16);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_revert_marker_is_not_written_when_nothing_was_trimmed() {
    let dir = scratch_dir("revert-marker-noop");
    let app = test_app();
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
    )
    .expect("dry run");
    assert!(!trimmed.exists());
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn trim_file_dispatches_each_input_kind_to_its_own_refusal() {
    let dir = scratch_dir("dispatch");
    let app = test_app();
    let empty = write_fixture(&dir, "empty.bin", &[]);

    let error = app
        .trim_file(
            &empty,
            &dir.join("out.bin"),
            request(TrimOperation::Revert, TrimInputKind::Xiso),
        )
        .err_or_panic("revert unsupported");
    assert!(
        error
            .to_string()
            .contains("xiso trim revert is not supported"),
        "{error}"
    );

    let error = app
        .trim_file(
            &empty,
            &dir.join("out.bin"),
            request(TrimOperation::Trim, TrimInputKind::NdsFamily),
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

#[test]
fn irreversible_trim_kinds_reject_existing_revert_footers() {
    let dir = scratch_dir("irreversible-revert-footer");
    let app = test_app();
    let source = write_fixture(&dir, "marked.bin", &[0x42; 64]);
    CliApp::write_revert_footer(&source, 128, 0).expect("legacy footer");
    let original = fs::read(&source).expect("original bytes");
    let kind = TrimInputKind::Xiso;
    for dry_run in [false, true] {
        let error = app
            .trim_file(
                &source,
                &source,
                TrimRequest {
                    in_place: true,
                    dry_run,
                    ..request(TrimOperation::Revert, kind)
                },
            )
            .err_or_panic("irreversible format");
        assert!(
            error.to_string().contains("trim revert is not supported"),
            "{error}"
        );
        assert_eq!(fs::read(&source).expect("unchanged source"), original);
    }
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn irreversible_trim_kinds_reject_markers_including_dry_runs() {
    let dir = scratch_dir("irreversible-marker");
    let app = test_app();
    let source = write_fixture(&dir, "source.bin", &[0x42; 64]);
    let kind = TrimInputKind::Xiso;
    for dry_run in [false, true] {
        let error = app
            .trim_file(
                &source,
                &source,
                TrimRequest {
                    in_place: true,
                    dry_run,
                    revert_marker: true,
                    ..request(TrimOperation::Trim, kind)
                },
            )
            .err_or_panic("irreversible format");
        assert!(
            error
                .to_string()
                .contains("does not support --revert-marker"),
            "{error}"
        );
        assert_eq!(fs::read(&source).expect("unchanged source"), [0x42; 64]);
    }
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn output_aliases_never_truncate_the_source() {
    let dir = scratch_dir("output-aliases");
    let mut bytes = vec![0x42; 1000];
    bytes.resize(4096, 0xFF);
    let source = write_fixture(&dir, "game.gba", &bytes);
    fs::create_dir_all(dir.join("sub")).expect("subdirectory");
    let hardlink = dir.join("hardlink.gba");
    fs::hard_link(&source, &hardlink).expect("hardlink");
    let mut aliases = vec![hardlink, dir.join("sub/../game.gba")];
    #[cfg(unix)]
    {
        let symlink = dir.join("symlink.gba");
        std::os::unix::fs::symlink(&source, &symlink).expect("symlink");
        aliases.push(symlink);
    }
    for destination in aliases {
        for dry_run in [false, true] {
            let error = CliApp::trim_power_of_two_file(
                &source,
                &destination,
                false,
                dry_run,
                TrimOperation::Trim,
                TrimInputKind::Gba,
            )
            .err_or_panic("output alias");
            assert!(
                error.to_string().contains("refers to the input file"),
                "{error}"
            );
            assert_eq!(fs::read(&source).expect("source"), bytes);
        }
    }
    fs::remove_dir_all(dir).ok();
}

#[test]
fn nds_boundaries_must_preserve_headers_and_referenced_data() {
    let dir = scratch_dir("nds-small-boundaries");
    for (boundary, referenced_end) in [(1, 0), (0x2000, 0x3000)] {
        let mut header = nds_header(false, boundary, 0);
        if referenced_end != 0 {
            header[0x20..0x24].copy_from_slice(&0x1000_u32.to_le_bytes());
            header[0x2C..0x30].copy_from_slice(&0x2000_u32.to_le_bytes());
            stamp_nds_crcs(&mut header);
        }
        let bytes = nds_rom(&header, 0x4000);
        let source = write_fixture(&dir, "game.nds", &bytes);
        for operation in [TrimOperation::Trim, TrimOperation::Revert] {
            let error = CliApp::trim_nds_file(&source, &source, true, false, operation)
                .err_or_panic("boundary inside live data");
            assert!(
                error
                    .to_string()
                    .contains("below the header or referenced data extent"),
                "{error}"
            );
            assert_eq!(fs::read(&source).expect("source"), bytes);
        }
    }
    fs::remove_dir_all(dir).ok();
}

#[test]
fn three_ds_trimming_preserves_declared_ncsd_and_ncch_extents() {
    let dir = scratch_dir("3ds-extents");
    for ncsd in [false, true] {
        let mut bytes = vec![0; 0x10000];
        bytes[0x100..0x104].copy_from_slice(if ncsd { b"NCSD" } else { b"NCCH" });
        bytes[0x104..0x108]
            .copy_from_slice(&(if ncsd { 0x80_u32 } else { 0x40_u32 }).to_le_bytes());
        if ncsd {
            bytes[0x120..0x124].copy_from_slice(&2_u32.to_le_bytes());
            bytes[0x124..0x128].copy_from_slice(&0x3E_u32.to_le_bytes());
            bytes[0x500..0x504].copy_from_slice(b"NCCH");
            bytes[0x504..0x508].copy_from_slice(&0x3E_u32.to_le_bytes());
        }
        let source = write_fixture(&dir, "game.3ds", &bytes);
        let output = dir.join("trimmed.3ds");
        let outcome = CliApp::trim_power_of_two_file(
            &source,
            &output,
            false,
            false,
            TrimOperation::Trim,
            TrimInputKind::ThreeDs,
        )
        .expect("trim");
        assert_eq!(outcome.result_size, 0x8000);
        assert_eq!(fs::read(output).expect("output"), bytes[..0x8000]);
        bytes[0x104..0x108].copy_from_slice(&0_u32.to_le_bytes());
        fs::write(&source, &bytes).expect("malformed fixture");
        CliApp::trim_power_of_two_file(
            &source,
            &source,
            true,
            false,
            TrimOperation::Trim,
            TrimInputKind::ThreeDs,
        )
        .err_or_panic("invalid extent");
        assert_eq!(fs::read(source).expect("source"), bytes);
    }
    fs::remove_dir_all(dir).ok();
}

#[test]
fn three_ds_restore_uses_the_declared_card_size_only_up_to_8_gib() {
    let dir = scratch_dir("3ds-card-size");
    // (declared card size in 512-byte units, expected restore size)
    for (card_units, expected) in [
        (0x60_u32, 0xC000_u64),
        (0x0100_0000, 8 << 30),
        (0x0100_0001, 0x8000),
    ] {
        let mut bytes = vec![0x11; 0x4567];
        bytes[0x100..0x104].copy_from_slice(b"NCSD");
        bytes[0x104..0x108].copy_from_slice(&card_units.to_le_bytes());
        bytes[0x108..0x200].fill(0);
        bytes[0x400..0x600].fill(0);
        bytes[0x120..0x124].copy_from_slice(&2_u32.to_le_bytes());
        bytes[0x124..0x128].copy_from_slice(&0x20_u32.to_le_bytes());
        bytes[0x500..0x504].copy_from_slice(b"NCCH");
        bytes[0x504..0x508].copy_from_slice(&0x20_u32.to_le_bytes());
        let source = write_fixture(&dir, "game.3ds", &bytes);
        let outcome = CliApp::trim_power_of_two_file(
            &source,
            &dir.join("restored.3ds"),
            false,
            true,
            TrimOperation::Revert,
            TrimInputKind::ThreeDs,
        )
        .expect("restore dry run");
        assert_eq!(outcome.result_size, expected, "card units {card_units:#x}");
    }
    fs::remove_dir_all(dir).ok();
}

#[test]
fn restoring_a_cxi_without_a_marker_leaves_it_unchanged() {
    let dir = scratch_dir("cxi-restore");
    let mut bytes = vec![0x11; 0x4600];
    bytes[0x100..0x104].copy_from_slice(b"NCCH");
    bytes[0x104..0x108].copy_from_slice(&0x23_u32.to_le_bytes());
    bytes[0x18E] = 0;
    for (name, expected) in [("game.cxi", 0x4600_u64), ("game.3ds", 0x8000)] {
        let source = write_fixture(&dir, name, &bytes);
        let outcome = CliApp::trim_power_of_two_file(
            &source,
            &dir.join("restored.bin"),
            false,
            true,
            TrimOperation::Revert,
            TrimInputKind::ThreeDs,
        )
        .expect("restore dry run");
        assert_eq!(outcome.result_size, expected, "{name}");
        assert_eq!(outcome.already_target_size, name == "game.cxi", "{name}");
    }
    fs::remove_dir_all(dir).ok();
}

#[test]
fn trim_input_extensions_cover_path_and_sniffed_kinds_but_not_gamecube_wii_discs() {
    let extensions = trim_input_extensions();
    for (extension, kind) in TRIM_PATH_EXTENSIONS {
        assert!(extensions.contains(extension), "{extension}");
        let path = PathBuf::from(format!("game.{extension}"));
        assert_eq!(TrimInputKind::from_path(&path), Some(*kind), "{extension}");
        let upper = PathBuf::from(format!("GAME.{}", extension.to_ascii_uppercase()));
        assert_eq!(TrimInputKind::from_path(&upper), Some(*kind), "{extension}");
    }
    assert_eq!(TrimInputKind::from_path(Path::new("game.zip")), None);
    assert_eq!(TrimInputKind::from_path(Path::new(".nds")), None);
    for sniffed in TRIM_CONTENT_SNIFFED_EXTENSIONS {
        assert!(extensions.contains(sniffed), "{sniffed}");
        assert_eq!(
            TrimInputKind::from_path(&PathBuf::from(format!("game.{sniffed}"))),
            None
        );
    }
    for disc in ["gcm", "wbfs", "rvz"] {
        assert!(!extensions.contains(&disc), "{disc}");
        assert_eq!(
            TrimInputKind::from_path(&PathBuf::from(format!("game.{disc}"))),
            None
        );
    }
}
