use std::{fs, path::Path};

use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchCreateRequest, PatchHandler, ProbeConfidence, Result, RomWeaverError,
    ThreadCapability,
};

const DLDI_VERSION: u8 = 1;
const DLDI_MAGIC: [u8; 12] = [
    0xED, 0xA5, 0x8D, 0xBF, b' ', b'C', b'h', b'i', b's', b'h', b'm', 0x00,
];

const FIX_ALL: u8 = 0x01;
const FIX_GLUE: u8 = 0x02;
const FIX_GOT: u8 = 0x04;
const FIX_BSS: u8 = 0x08;

const DO_MAGIC_STRING: usize = 0x00;
const DO_VERSION: usize = 0x0C;
const DO_DRIVER_SIZE: usize = 0x0D;
const DO_FIX_SECTIONS: usize = 0x0E;
const DO_ALLOCATED_SPACE: usize = 0x0F;
const DO_FRIENDLY_NAME: usize = 0x10;
const DO_TEXT_START: usize = 0x40;
const DO_DATA_END: usize = 0x44;
const DO_GLUE_START: usize = 0x48;
const DO_GLUE_END: usize = 0x4C;
const DO_GOT_START: usize = 0x50;
const DO_GOT_END: usize = 0x54;
const DO_BSS_START: usize = 0x58;
const DO_BSS_END: usize = 0x5C;
const DO_STARTUP: usize = 0x68;
const DO_IS_INSERTED: usize = 0x6C;
const DO_READ_SECTORS: usize = 0x70;
const DO_WRITE_SECTORS: usize = 0x74;
const DO_CLEAR_STATUS: usize = 0x78;
const DO_SHUTDOWN: usize = 0x7C;
const DO_CODE: usize = 0x80;

pub struct DldiPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl DldiPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl PatchHandler for DldiPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let patch = fs::read(patch_path)?;
        let header = parse_dldi_bytes(&patch, "DLDI patch")?;

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "parse",
            format!(
                "parsed {} patch for driver `{}` ({} byte(s))",
                self.descriptor.name, header.friendly_name, header.driver_size_bytes
            ),
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

        let patch = fs::read(&request.patches[0])?;
        let input = fs::read(&request.input)?;
        let apply = apply_dldi_patch(&input, &patch)?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&request.output, &apply.output)?;

        let execution = context.plan_threads(ThreadCapability::single_threaded());
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "apply",
            format!(
                "applied {} driver `{}` over `{}` at 0x{:08X}",
                self.descriptor.name, apply.new_driver, apply.old_driver, apply.patch_offset
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
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let original = fs::read(&request.original)?;
        let modified = fs::read(&request.modified)?;

        let original_slot = find_dldi_slot(&original).ok_or_else(|| {
            RomWeaverError::Validation(
                "original input does not contain a patchable DLDI section".into(),
            )
        })?;
        let modified_slot = find_dldi_slot(&modified).ok_or_else(|| {
            RomWeaverError::Validation(
                "modified input does not contain a patchable DLDI section".into(),
            )
        })?;

        if original_slot != modified_slot {
            return Err(RomWeaverError::Validation(format!(
                "DLDI section moved between inputs (original: 0x{original_slot:08X}, modified: 0x{modified_slot:08X})"
            )));
        }

        let modified_header = parse_dldi_at(&modified, modified_slot, "modified DLDI section")?;
        let modified_slot_end = modified_slot
            .checked_add(modified_header.driver_size_bytes)
            .ok_or_else(|| {
                RomWeaverError::Validation("modified DLDI section range overflowed".into())
            })?;
        if modified_slot_end > modified.len() {
            return Err(RomWeaverError::Validation(
                "modified DLDI section exceeded input length".into(),
            ));
        }

        let patch_bytes = modified[modified_slot..modified_slot_end].to_vec();
        parse_dldi_bytes(&patch_bytes, "generated DLDI patch")?;

        // DLDI create is defined as extracting the relocated driver bytes from `modified`.
        // Validate determinism by replaying that patch against `original`.
        let replay = apply_dldi_patch(&original, &patch_bytes)?;
        if replay.output != modified {
            return Err(RomWeaverError::Validation(
                "modified input is not representable as a pure DLDI patch over original".into(),
            ));
        }

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&request.output, &patch_bytes)?;

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created {} patch for driver `{}` ({} byte(s))",
                self.descriptor.name,
                modified_header.friendly_name,
                patch_bytes.len()
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
            threaded_diff: false,
            threaded_output: false,
        }
    }
}

#[derive(Debug)]
struct DldiHeader {
    friendly_name: String,
    driver_size_log2: u8,
    driver_size_bytes: usize,
    allocated_space_log2: u8,
    fix_sections: u8,
    text_start: i32,
}

#[derive(Debug)]
struct DldiApplyOutput {
    output: Vec<u8>,
    patch_offset: usize,
    old_driver: String,
    new_driver: String,
}

fn parse_dldi_at(bytes: &[u8], start: usize, label: &str) -> Result<DldiHeader> {
    if start >= bytes.len() {
        return Err(RomWeaverError::Validation(format!(
            "{label} offset is outside file bounds"
        )));
    }
    parse_dldi_bytes(
        bytes.get(start..).ok_or_else(|| {
            RomWeaverError::Validation(format!("{label} offset is outside file bounds"))
        })?,
        label,
    )
}

fn parse_dldi_bytes(bytes: &[u8], label: &str) -> Result<DldiHeader> {
    if bytes.len() < DO_CODE {
        return Err(RomWeaverError::Validation(format!(
            "{label} is too small to contain a valid DLDI header"
        )));
    }
    if bytes.get(DO_MAGIC_STRING..DO_MAGIC_STRING + DLDI_MAGIC.len()) != Some(&DLDI_MAGIC) {
        return Err(RomWeaverError::Validation(format!(
            "{label} has an invalid DLDI magic header"
        )));
    }

    let version = bytes[DO_VERSION];
    if version != DLDI_VERSION {
        return Err(RomWeaverError::Validation(format!(
            "{label} has unsupported DLDI version {version}; expected {DLDI_VERSION}"
        )));
    }

    let driver_size_log2 = bytes[DO_DRIVER_SIZE];
    let driver_size_bytes = size_from_log2(driver_size_log2, "DLDI driver size")?;
    if driver_size_bytes < DO_CODE {
        return Err(RomWeaverError::Validation(format!(
            "{label} driver size {driver_size_bytes} is smaller than header size {DO_CODE}"
        )));
    }
    if driver_size_bytes > bytes.len() {
        return Err(RomWeaverError::Validation(format!(
            "{label} declares {driver_size_bytes} byte(s), but only {} byte(s) are available",
            bytes.len()
        )));
    }

    let friendly_name = parse_friendly_name(bytes)?;
    let fix_sections = bytes[DO_FIX_SECTIONS];
    let allocated_space_log2 = bytes[DO_ALLOCATED_SPACE];
    let text_start = read_addr_i32(bytes, DO_TEXT_START)?;

    Ok(DldiHeader {
        friendly_name,
        driver_size_log2,
        driver_size_bytes,
        allocated_space_log2,
        fix_sections,
        text_start,
    })
}

fn parse_friendly_name(bytes: &[u8]) -> Result<String> {
    let name_bytes = bytes.get(DO_FRIENDLY_NAME..DO_TEXT_START).ok_or_else(|| {
        RomWeaverError::Validation("DLDI friendly-name field is truncated".into())
    })?;
    let end = name_bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(name_bytes.len());
    Ok(String::from_utf8_lossy(&name_bytes[..end])
        .trim()
        .to_string())
}

fn apply_dldi_patch(input: &[u8], patch: &[u8]) -> Result<DldiApplyOutput> {
    let patch_header = parse_dldi_bytes(patch, "DLDI patch")?;
    let patch_offset = find_dldi_slot(input).ok_or_else(|| {
        RomWeaverError::Validation("input does not contain a patchable DLDI section".into())
    })?;

    if patch_offset
        .checked_add(DO_CODE)
        .ok_or_else(|| RomWeaverError::Validation("DLDI slot range overflowed".into()))?
        > input.len()
    {
        return Err(RomWeaverError::Validation(
            "input DLDI section is truncated".into(),
        ));
    }

    let existing_header = parse_dldi_at(input, patch_offset, "input DLDI section")?;
    if patch_header.driver_size_log2 > existing_header.allocated_space_log2 {
        let available = size_from_log2(existing_header.allocated_space_log2, "input DLDI space")?;
        return Err(RomWeaverError::Validation(format!(
            "not enough space for DLDI patch (available {available} byte(s), need {} byte(s))",
            patch_header.driver_size_bytes
        )));
    }

    let mut output = input.to_vec();
    let patch_end = patch_offset
        .checked_add(patch_header.driver_size_bytes)
        .ok_or_else(|| RomWeaverError::Validation("DLDI patch range overflowed".into()))?;
    if patch_end > output.len() {
        return Err(RomWeaverError::Validation(
            "input file ended before the DLDI patch slot".into(),
        ));
    }

    output[patch_offset..patch_end].copy_from_slice(&patch[..patch_header.driver_size_bytes]);
    output[patch_offset + DO_ALLOCATED_SPACE] = existing_header.allocated_space_log2;

    let input_slot = &input[patch_offset..];
    let mut mem_offset = existing_header.text_start;
    if mem_offset == 0 {
        mem_offset = read_addr_i32(input_slot, DO_STARTUP)?
            .checked_sub(i32::try_from(DO_CODE).expect("DO_CODE fits i32"))
            .ok_or_else(|| {
                RomWeaverError::Validation(
                    "DLDI startup pointer underflowed while deriving memory offset".into(),
                )
            })?;
    }

    let relocation = i64::from(mem_offset) - i64::from(patch_header.text_start);
    let app_slot = &mut output[patch_offset..patch_end];
    relocate_header_pointers(app_slot, relocation)?;

    let ddmem_start = i64::from(patch_header.text_start);
    let ddmem_end = ddmem_start
        .checked_add(i64::try_from(patch_header.driver_size_bytes).expect("fits i64"))
        .ok_or_else(|| RomWeaverError::Validation("DLDI address range overflowed".into()))?;

    if patch_header.fix_sections & FIX_ALL != 0 {
        relocate_pointer_range(
            app_slot,
            patch,
            DO_TEXT_START,
            DO_DATA_END,
            ddmem_start,
            ddmem_end,
            relocation,
            "DLDI text/data",
        )?;
    }

    if patch_header.fix_sections & FIX_GLUE != 0 {
        relocate_pointer_range(
            app_slot,
            patch,
            DO_GLUE_START,
            DO_GLUE_END,
            ddmem_start,
            ddmem_end,
            relocation,
            "DLDI interwork glue",
        )?;
    }

    if patch_header.fix_sections & FIX_GOT != 0 {
        relocate_pointer_range(
            app_slot,
            patch,
            DO_GOT_START,
            DO_GOT_END,
            ddmem_start,
            ddmem_end,
            relocation,
            "DLDI global offset table",
        )?;
    }

    if patch_header.fix_sections & FIX_BSS != 0 {
        clear_bss(app_slot, patch, ddmem_start)?;
    }

    Ok(DldiApplyOutput {
        output,
        patch_offset,
        old_driver: existing_header.friendly_name,
        new_driver: patch_header.friendly_name,
    })
}

fn relocate_header_pointers(slot: &mut [u8], relocation: i64) -> Result<()> {
    const HEADER_POINTERS: [usize; 14] = [
        DO_TEXT_START,
        DO_DATA_END,
        DO_GLUE_START,
        DO_GLUE_END,
        DO_GOT_START,
        DO_GOT_END,
        DO_BSS_START,
        DO_BSS_END,
        DO_STARTUP,
        DO_IS_INSERTED,
        DO_READ_SECTORS,
        DO_WRITE_SECTORS,
        DO_CLEAR_STATUS,
        DO_SHUTDOWN,
    ];

    for &offset in &HEADER_POINTERS {
        let value = read_addr_i32(slot, offset)?;
        let relocated = add_relocation(value, relocation, "DLDI header pointer")?;
        write_addr_i32(slot, offset, relocated)?;
    }

    Ok(())
}

fn relocate_pointer_range(
    slot: &mut [u8],
    patch: &[u8],
    start_offset: usize,
    end_offset: usize,
    ddmem_start: i64,
    ddmem_end: i64,
    relocation: i64,
    section_label: &str,
) -> Result<()> {
    let (start, end) = section_range(patch, start_offset, end_offset, ddmem_start, section_label)?;
    for offset in start..end {
        if offset + 4 > slot.len() {
            break;
        }

        let pointer = read_addr_i32(slot, offset)?;
        let pointer_i64 = i64::from(pointer);
        if ddmem_start <= pointer_i64 && pointer_i64 < ddmem_end {
            let relocated = add_relocation(pointer, relocation, section_label)?;
            write_addr_i32(slot, offset, relocated)?;
        }
    }

    Ok(())
}

fn clear_bss(slot: &mut [u8], patch: &[u8], ddmem_start: i64) -> Result<()> {
    let (start, end) = section_range(patch, DO_BSS_START, DO_BSS_END, ddmem_start, "DLDI BSS")?;
    if end > slot.len() {
        return Err(RomWeaverError::Validation(
            "DLDI BSS range exceeds patch slot size".into(),
        ));
    }
    slot[start..end].fill(0);
    Ok(())
}

fn section_range(
    patch: &[u8],
    start_offset: usize,
    end_offset: usize,
    ddmem_start: i64,
    section_label: &str,
) -> Result<(usize, usize)> {
    let start_address = i64::from(read_addr_i32(patch, start_offset)?);
    let end_address = i64::from(read_addr_i32(patch, end_offset)?);

    let start_index = start_address
        .checked_sub(ddmem_start)
        .ok_or_else(|| RomWeaverError::Validation(format!("{section_label} range underflowed")))?;
    let end_index = end_address
        .checked_sub(ddmem_start)
        .ok_or_else(|| RomWeaverError::Validation(format!("{section_label} range underflowed")))?;

    if start_index < 0 || end_index < 0 {
        return Err(RomWeaverError::Validation(format!(
            "{section_label} range resolved to a negative offset"
        )));
    }
    if end_index < start_index {
        return Err(RomWeaverError::Validation(format!(
            "{section_label} range is inverted"
        )));
    }

    let start = usize::try_from(start_index).map_err(|_| {
        RomWeaverError::Validation(format!("{section_label} start offset exceeded usize"))
    })?;
    let end = usize::try_from(end_index).map_err(|_| {
        RomWeaverError::Validation(format!("{section_label} end offset exceeded usize"))
    })?;
    Ok((start, end))
}

fn add_relocation(value: i32, relocation: i64, field: &str) -> Result<i32> {
    let relocated = i64::from(value)
        .checked_add(relocation)
        .ok_or_else(|| RomWeaverError::Validation(format!("{field} relocation overflowed")))?;
    i32::try_from(relocated)
        .map_err(|_| RomWeaverError::Validation(format!("{field} relocation overflowed")))
}

fn read_addr_i32(bytes: &[u8], offset: usize) -> Result<i32> {
    let value = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| {
            RomWeaverError::Validation(format!("DLDI address read out of bounds at 0x{offset:X}"))
        })?
        .try_into()
        .expect("slice has exact length");
    Ok(i32::from_le_bytes(value))
}

fn write_addr_i32(bytes: &mut [u8], offset: usize, value: i32) -> Result<()> {
    let target = bytes.get_mut(offset..offset + 4).ok_or_else(|| {
        RomWeaverError::Validation(format!("DLDI address write out of bounds at 0x{offset:X}"))
    })?;
    target.copy_from_slice(&value.to_le_bytes());
    Ok(())
}

fn size_from_log2(log2: u8, label: &str) -> Result<usize> {
    let shift = u32::from(log2);
    if shift >= usize::BITS {
        return Err(RomWeaverError::Validation(format!(
            "{label} exponent {log2} exceeds platform limits"
        )));
    }
    Ok(1usize << shift)
}

fn find_dldi_slot(input: &[u8]) -> Option<usize> {
    input
        .windows(DLDI_MAGIC.len())
        .position(|window| window == DLDI_MAGIC)
}

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        path::PathBuf,
        sync::Arc,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use rom_weaver_core::{
        CancellationToken, NoopProgressSink, OperationContext, PatchApplyRequest,
        PatchCreateRequest, PatchHandler, ThreadBudget,
    };

    use super::{
        DLDI_MAGIC, DLDI_VERSION, DO_ALLOCATED_SPACE, DO_BSS_END, DO_BSS_START, DO_CODE,
        DO_DATA_END, DO_DRIVER_SIZE, DO_FIX_SECTIONS, DO_FRIENDLY_NAME, DO_GLUE_END, DO_GLUE_START,
        DO_GOT_END, DO_GOT_START, DO_MAGIC_STRING, DO_READ_SECTORS, DO_SHUTDOWN, DO_STARTUP,
        DO_TEXT_START, DO_VERSION, DO_WRITE_SECTORS, DldiPatchHandler, FIX_ALL, FIX_BSS, FIX_GLUE,
        FIX_GOT,
    };
    use crate::DLDI;

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
                "rom-weaver-dldi-tests-{}-{timestamp}-{sequence}",
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
    fn parse_rejects_invalid_magic() {
        let temp = TestDir::new();
        let patch_path = temp.child("broken.dldi");
        fs::write(&patch_path, vec![0xAA; 1 << 8]).expect("fixture");

        let handler = DldiPatchHandler::new(&DLDI);
        let error = handler
            .parse(&patch_path, &test_context_with_threads(&temp, 1))
            .expect_err("parse should fail");

        assert!(error.to_string().contains("invalid DLDI magic"));
    }

    #[test]
    fn apply_patches_slot_and_relocates_driver() {
        let temp = TestDir::new();
        let input_path = temp.child("input.nds");
        let patch_path = temp.child("driver.dldi");
        let output_path = temp.child("output.nds");

        let slot_offset = 0x200;
        let mem_offset = 0x0200_0000i32;
        let input = build_test_app_with_slot(slot_offset, 12, mem_offset, "Default driver");
        let patch = build_test_dldi_driver(
            8,
            0xBF80_0000u32 as i32,
            "Test Driver",
            FIX_ALL | FIX_GLUE | FIX_GOT | FIX_BSS,
        );

        fs::write(&input_path, &input).expect("fixture");
        fs::write(&patch_path, &patch).expect("fixture");

        let handler = DldiPatchHandler::new(&DLDI);
        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("apply");

        let output = fs::read(output_path).expect("output");
        let slot = &output[slot_offset..slot_offset + (1 << 8)];

        assert_eq!(
            &slot[DO_MAGIC_STRING..DO_MAGIC_STRING + DLDI_MAGIC.len()],
            DLDI_MAGIC
        );
        assert_eq!(slot[DO_VERSION], DLDI_VERSION);
        assert_eq!(slot[DO_DRIVER_SIZE], 8);
        assert_eq!(slot[DO_ALLOCATED_SPACE], 12);

        let startup = i32::from_le_bytes(slot[DO_STARTUP..DO_STARTUP + 4].try_into().expect("len"));
        assert_eq!(startup, mem_offset + i32::try_from(DO_CODE).expect("fits"));

        let bss_start = usize::try_from(
            i32::from_le_bytes(
                slot[DO_BSS_START..DO_BSS_START + 4]
                    .try_into()
                    .expect("len"),
            ) - mem_offset,
        )
        .expect("bss start");
        let bss_end = usize::try_from(
            i32::from_le_bytes(slot[DO_BSS_END..DO_BSS_END + 4].try_into().expect("len"))
                - mem_offset,
        )
        .expect("bss end");
        assert!(slot[bss_start..bss_end].iter().all(|byte| *byte == 0));
    }

    #[test]
    fn create_extracts_driver_and_round_trips() {
        let temp = TestDir::new();
        let original_path = temp.child("original.nds");
        let driver_path = temp.child("driver.dldi");
        let modified_path = temp.child("modified.nds");
        let created_patch_path = temp.child("created.dldi");
        let replay_path = temp.child("replay.nds");

        let original = build_test_app_with_slot(0x300, 12, 0x0200_0000, "Default driver");
        let driver = build_test_dldi_driver(
            8,
            0xBF80_0000u32 as i32,
            "Roundtrip Driver",
            FIX_ALL | FIX_GLUE | FIX_GOT | FIX_BSS,
        );
        fs::write(&original_path, &original).expect("fixture");
        fs::write(&driver_path, &driver).expect("fixture");

        let handler = DldiPatchHandler::new(&DLDI);
        handler
            .apply(
                &PatchApplyRequest {
                    input: original_path.clone(),
                    patches: vec![driver_path],
                    output: modified_path.clone(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("apply");

        handler
            .create(
                &PatchCreateRequest {
                    original: original_path.clone(),
                    modified: modified_path.clone(),
                    output: created_patch_path.clone(),
                    format: "dldi".into(),
                },
                &test_context_with_threads(&temp, 2),
            )
            .expect("create");

        handler
            .apply(
                &PatchApplyRequest {
                    input: original_path,
                    patches: vec![created_patch_path],
                    output: replay_path.clone(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("replay apply");

        assert_eq!(
            fs::read(replay_path).expect("replay"),
            fs::read(modified_path).expect("modified")
        );
    }

    fn build_test_app_with_slot(
        slot_offset: usize,
        allocated_log2: u8,
        mem_offset: i32,
        friendly_name: &str,
    ) -> Vec<u8> {
        let slot_size = 1usize << allocated_log2;
        let mut file = vec![0xCDu8; slot_offset + slot_size + 0x80];
        let mut slot = build_test_dldi_driver(
            allocated_log2,
            mem_offset,
            friendly_name,
            FIX_ALL | FIX_GLUE | FIX_GOT | FIX_BSS,
        );

        // Placeholder drivers usually advertise their reserved capacity.
        slot[DO_ALLOCATED_SPACE] = allocated_log2;
        file[slot_offset..slot_offset + slot_size].copy_from_slice(&slot);
        file
    }

    fn build_test_dldi_driver(
        driver_log2: u8,
        base_address: i32,
        friendly_name: &str,
        fix_flags: u8,
    ) -> Vec<u8> {
        let size = 1usize << driver_log2;
        let mut bytes = vec![0u8; size];

        bytes[DO_MAGIC_STRING..DO_MAGIC_STRING + DLDI_MAGIC.len()].copy_from_slice(&DLDI_MAGIC);
        bytes[DO_VERSION] = DLDI_VERSION;
        bytes[DO_DRIVER_SIZE] = driver_log2;
        bytes[DO_FIX_SECTIONS] = fix_flags;
        bytes[DO_ALLOCATED_SPACE] = driver_log2;

        let name_bytes = friendly_name.as_bytes();
        let max_name_len = DO_TEXT_START - DO_FRIENDLY_NAME;
        let copy_len = name_bytes.len().min(max_name_len.saturating_sub(1));
        bytes[DO_FRIENDLY_NAME..DO_FRIENDLY_NAME + copy_len]
            .copy_from_slice(&name_bytes[..copy_len]);

        let size_i32 = i32::try_from(size).expect("size fits");
        write_i32(&mut bytes, DO_TEXT_START, base_address);
        write_i32(&mut bytes, DO_DATA_END, base_address + size_i32);
        write_i32(&mut bytes, DO_GLUE_START, base_address + 0xA0);
        write_i32(&mut bytes, DO_GLUE_END, base_address + 0xA8);
        write_i32(&mut bytes, DO_GOT_START, base_address + 0xA8);
        write_i32(&mut bytes, DO_GOT_END, base_address + 0xB0);
        write_i32(&mut bytes, DO_BSS_START, base_address + 0xB0);
        write_i32(&mut bytes, DO_BSS_END, base_address + 0xC0);
        write_i32(
            &mut bytes,
            DO_STARTUP,
            base_address + i32::try_from(DO_CODE).expect("fits"),
        );
        write_i32(
            &mut bytes,
            DO_READ_SECTORS,
            base_address + i32::try_from(DO_CODE + 8).expect("fits"),
        );
        write_i32(
            &mut bytes,
            DO_WRITE_SECTORS,
            base_address + i32::try_from(DO_CODE + 12).expect("fits"),
        );
        write_i32(
            &mut bytes,
            DO_SHUTDOWN,
            base_address + i32::try_from(DO_CODE + 16).expect("fits"),
        );

        write_i32(&mut bytes, DO_CODE + 4, base_address + 0xD0);
        write_i32(&mut bytes, DO_CODE + 12, base_address + 0xD8);
        write_i32(&mut bytes, 0xA0, base_address + 0x80);
        write_i32(&mut bytes, 0xA8, base_address + 0x84);

        for byte in &mut bytes[0xB0..0xC0] {
            *byte = 0x7F;
        }

        bytes
    }

    fn write_i32(bytes: &mut [u8], offset: usize, value: i32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn test_context_with_threads(temp: &TestDir, threads: usize) -> OperationContext {
        OperationContext::new(
            ThreadBudget::Fixed(threads),
            temp.path.clone(),
            Arc::new(NoopProgressSink),
            CancellationToken::new(),
        )
    }
}
