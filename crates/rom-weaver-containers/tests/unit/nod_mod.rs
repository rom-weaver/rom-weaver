//! Coverage for the error plumbing in `src/nod/mod.rs`, plus the synthetic
//! GameCube disc fixture shared by the other `nod` unit test modules.

use std::io;

use zerocopy::{FromBytes, FromZeros, IntoBytes};

use super::{
    Error, ErrorContext, ResultContext,
    disc::{
        ApploaderHeader, BB2_OFFSET, BI2_SIZE, BOOT_SIZE, BootHeader, DiscHeader, DolHeader,
        GCN_MAGIC, SECTOR_SIZE, fst::FstBuilder,
    },
    util::lfg::LaggedFibonacci,
};

// --- Shared GameCube disc fixture ----------------------------------------

/// Game ID of the synthetic disc. The first four bytes seed the junk data.
pub(crate) const GC_GAME_ID: [u8; 6] = *b"GTEST0";
pub(crate) const GC_GAME_TITLE: &str = "rom-weaver nod fixture";
/// Total image length. Chosen so the 2 MiB CISO block grid splits the disc
/// into one normal block, one all-junk block and one all-zero block.
pub(crate) const GC_DISC_SIZE: usize = 0x60_0000;
pub(crate) const GC_DOL_OFFSET: u64 = 0x2500;
pub(crate) const GC_DOL_SIZE: u64 = 0x200;
pub(crate) const GC_FST_OFFSET: u64 = 0x3000;
pub(crate) const GC_USER_OFFSET: u32 = 0x10_0000;
pub(crate) const GC_USER_SIZE: u32 = 0x30_0000;
pub(crate) const GC_USER_END: u64 = GC_USER_OFFSET as u64 + GC_USER_SIZE as u64;
pub(crate) const GC_FILE_A_OFFSET: u64 = 0x10_0000;
pub(crate) const GC_FILE_B_OFFSET: u64 = 0x11_0000;
pub(crate) const GC_FILE_SIZE: u32 = 0x8000;
pub(crate) const GC_FILE_A_PATH: &str = "files/a.bin";
pub(crate) const GC_FILE_B_PATH: &str = "files/b.bin";
const GC_APPLOADER_OFFSET: usize = BOOT_SIZE + BI2_SIZE;

/// The alignment `insert_junk_data` applies to the end of the previous file
/// when it decides where a junk run starts.
fn gcm_align(n: u64) -> u64 {
    (n + 31) & !3
}

pub(crate) fn gc_disc_id() -> [u8; 4] {
    let mut disc_id = [0u8; 4];
    disc_id.copy_from_slice(&GC_GAME_ID[..4]);
    disc_id
}

/// Builds a GameCube disc image in memory whose layout matches what nod's
/// GCM rebuilder produces: system files up front, two user files, and lagged
/// Fibonacci junk filling every gap after the FST, each run starting at the
/// `gcm_align` boundary `insert_junk_data` picks. That placement is what
/// makes the TGC round trip byte-exact and what lets `check_block` classify
/// whole CISO blocks as junk or zero.
pub(crate) fn build_gamecube_iso() -> Vec<u8> {
    let mut fst_builder = FstBuilder::new(false);
    fst_builder.add_file(GC_FILE_A_PATH, GC_FILE_A_OFFSET, GC_FILE_SIZE);
    fst_builder.add_file(GC_FILE_B_PATH, GC_FILE_B_OFFSET, GC_FILE_SIZE);
    let fst_data = fst_builder.finalize();

    let mut image = vec![0u8; GC_DISC_SIZE];

    let mut disc_header = DiscHeader::new_zeroed();
    disc_header.game_id = GC_GAME_ID;
    disc_header.gcn_magic = GCN_MAGIC;
    disc_header.game_title[..GC_GAME_TITLE.len()].copy_from_slice(GC_GAME_TITLE.as_bytes());
    image[..size_of::<DiscHeader>()].copy_from_slice(disc_header.as_bytes());

    let mut boot_header = BootHeader::new_zeroed();
    boot_header.set_dol_offset(GC_DOL_OFFSET, false);
    boot_header.set_fst_offset(GC_FST_OFFSET, false);
    boot_header.set_fst_size(fst_data.len() as u64, false);
    boot_header.set_fst_max_size(fst_data.len() as u64, false);
    boot_header.user_offset = GC_USER_OFFSET.into();
    boot_header.user_size = GC_USER_SIZE.into();
    image[BB2_OFFSET..BB2_OFFSET + size_of::<BootHeader>()].copy_from_slice(boot_header.as_bytes());

    let mut apploader = ApploaderHeader::new_zeroed();
    apploader.date[..10].copy_from_slice(b"2024/01/01");
    apploader.entry_point = 0x8130_0000.into();
    apploader.size = 0x40.into();
    apploader.trailer_size = 0x20.into();
    image[GC_APPLOADER_OFFSET..GC_APPLOADER_OFFSET + size_of::<ApploaderHeader>()]
        .copy_from_slice(apploader.as_bytes());
    for (index, byte) in image[GC_APPLOADER_OFFSET + size_of::<ApploaderHeader>()
        ..GC_APPLOADER_OFFSET + size_of::<ApploaderHeader>() + 0x60]
        .iter_mut()
        .enumerate()
    {
        *byte = (index % 199) as u8;
    }

    // `read_dol` derives the DOL length from the highest section end, so one
    // text section starting at 0x100 with length 0x100 yields GC_DOL_SIZE.
    let mut dol = DolHeader::new_zeroed();
    dol.text_offs[0] = 0x100.into();
    dol.text_sizes[0] = 0x100.into();
    dol.text_addrs[0] = 0x8000_3100.into();
    dol.entry_point = 0x8000_3100.into();
    let dol_start = GC_DOL_OFFSET as usize;
    image[dol_start..dol_start + size_of::<DolHeader>()].copy_from_slice(dol.as_bytes());
    for (index, byte) in image[dol_start + size_of::<DolHeader>()..dol_start + GC_DOL_SIZE as usize]
        .iter_mut()
        .enumerate()
    {
        *byte = (index % 241) as u8;
    }

    let fst_start = GC_FST_OFFSET as usize;
    image[fst_start..fst_start + fst_data.len()].copy_from_slice(&fst_data);

    for (offset, seed) in [(GC_FILE_A_OFFSET, 0x11u8), (GC_FILE_B_OFFSET, 0x77u8)] {
        let start = offset as usize;
        for (index, byte) in image[start..start + GC_FILE_SIZE as usize]
            .iter_mut()
            .enumerate()
        {
            *byte = seed.wrapping_add((index % 251) as u8);
        }
    }

    let disc_id = gc_disc_id();
    let mut lfg = LaggedFibonacci::default();
    for (start, end) in [
        (
            gcm_align(GC_FST_OFFSET + fst_data.len() as u64),
            GC_FILE_A_OFFSET,
        ),
        (
            gcm_align(GC_FILE_A_OFFSET + GC_FILE_SIZE as u64),
            GC_FILE_B_OFFSET,
        ),
        (
            gcm_align(GC_FILE_B_OFFSET + GC_FILE_SIZE as u64),
            GC_USER_END,
        ),
    ] {
        lfg.fill_sector_chunked(&mut image[start as usize..end as usize], disc_id, 0, start);
    }

    image
}

// --- src/nod/mod.rs error plumbing ---------------------------------------

#[test]
fn error_from_str_and_string_produce_other() {
    let from_str = Error::from("borrowed");
    assert!(matches!(&from_str, Error::Other(msg) if msg == "borrowed"));
    assert_eq!(from_str.to_string(), "error: borrowed");

    let from_string = Error::from("owned".to_string());
    assert!(matches!(&from_string, Error::Other(msg) if msg == "owned"));
}

#[test]
fn error_from_io_error_keeps_source_and_default_context() {
    let error = Error::from(io::Error::new(io::ErrorKind::NotFound, "missing"));
    let Error::Io(context, source) = &error else {
        panic!("expected an Io error, got {error:?}");
    };
    assert_eq!(context, "IO Error");
    assert_eq!(source.kind(), io::ErrorKind::NotFound);
    assert_eq!(error.to_string(), "IO Error: missing");
}

#[test]
fn error_from_alloc_error_reports_out_of_memory() {
    let error = Error::from(zerocopy::AllocError);
    let Error::Io(context, source) = &error else {
        panic!("expected an Io error, got {error:?}");
    };
    assert_eq!(context, "allocation failed");
    assert_eq!(source.kind(), io::ErrorKind::OutOfMemory);
}

#[test]
fn disc_format_error_displays_its_message() {
    let error = Error::DiscFormat("bad magic".to_string());
    assert_eq!(error.to_string(), "disc format error: bad magic");
}

#[test]
fn io_error_context_replaces_the_default_context() {
    let error = io::Error::new(io::ErrorKind::PermissionDenied, "denied").context("Opening disc");
    assert_eq!(error.to_string(), "Opening disc: denied");
}

#[test]
fn result_context_leaves_ok_values_untouched() {
    let ok: io::Result<u32> = Ok(7);
    assert_eq!(ok.context("unused").expect("ok value"), 7);

    let ok: io::Result<u32> = Ok(9);
    assert_eq!(
        ok.with_context(|| panic!("closure must not run on Ok"))
            .expect("ok value"),
        9
    );
}

#[test]
fn result_context_wraps_errors_with_the_supplied_context() {
    let err: io::Result<u32> = Err(io::Error::from(io::ErrorKind::UnexpectedEof));
    let error = err
        .context("Reading header")
        .expect_err("expected an error");
    assert!(
        error.to_string().starts_with("Reading header: "),
        "unexpected message: {error}"
    );

    let err: io::Result<u32> = Err(io::Error::from(io::ErrorKind::UnexpectedEof));
    let error = err
        .with_context(|| "Reading block 3".to_string())
        .expect_err("expected an error");
    assert!(
        error.to_string().starts_with("Reading block 3: "),
        "unexpected message: {error}"
    );
}

// --- fixture self-checks --------------------------------------------------

#[test]
fn gamecube_fixture_has_the_layout_the_nod_tests_rely_on() {
    let image = build_gamecube_iso();
    assert_eq!(image.len(), GC_DISC_SIZE);

    let disc_header =
        DiscHeader::read_from_bytes(&image[..size_of::<DiscHeader>()]).expect("disc header");
    assert!(disc_header.is_gamecube());
    assert!(!disc_header.is_wii());
    assert_eq!(disc_header.game_id_str(), "GTEST0");
    assert_eq!(disc_header.game_title_str(), GC_GAME_TITLE);

    let boot_header =
        BootHeader::read_from_bytes(&image[BB2_OFFSET..BB2_OFFSET + size_of::<BootHeader>()])
            .expect("boot header");
    assert_eq!(boot_header.dol_offset(false), GC_DOL_OFFSET);
    assert_eq!(boot_header.fst_offset(false), GC_FST_OFFSET);
    assert_eq!(boot_header.user_offset.get(), GC_USER_OFFSET);
    assert_eq!(boot_header.user_size.get(), GC_USER_SIZE);

    // The tail of the user region must be pure junk so `check_block`
    // classifies the second 2 MiB block as junk rather than normal data.
    let mut lfg = LaggedFibonacci::default();
    let junk_start = 0x20_0000usize;
    let matched = lfg.check_sector_chunked(
        &image[junk_start..GC_USER_END as usize],
        gc_disc_id(),
        0,
        junk_start as u64,
    );
    assert_eq!(matched, GC_USER_END as usize - junk_start);

    // Everything past the user region is zero-filled.
    assert!(image[GC_USER_END as usize..].iter().all(|&b| b == 0));
    assert_eq!(GC_DISC_SIZE % SECTOR_SIZE, 0);
}
