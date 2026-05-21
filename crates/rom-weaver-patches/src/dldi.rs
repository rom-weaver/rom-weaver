use std::{
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

use rayon::join;
use rom_weaver_core::{
    BlockCacheReader, DEFAULT_BLOCK_CACHE_MAX_BLOCKS, DEFAULT_BLOCK_CACHE_SIZE_BYTES,
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
const DO_CODE_I32: i32 = DO_CODE as i32;
const INPUT_NO_DLDI_SLOT_MESSAGE: &str = "input does not contain a patchable DLDI section";
const THREAD_WORK_CHUNK_BYTES: usize = 4 * 1024 * 1024;

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
        let header = parse_dldi_header_from_path(patch_path, "DLDI patch", false)?;

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
        let patch_path = crate::require_single_patch_file(&request.patches, self.descriptor.name)?;
        let patch_header = parse_dldi_header_from_path(patch_path, "DLDI patch", true)?;
        let patch_file_len = fs::metadata(patch_path)?.len();
        let patch_read_len = usize::try_from(
            patch_file_len.min(u64::try_from(patch_header.driver_size_bytes).unwrap_or(u64::MAX)),
        )
        .map_err(|_| RomWeaverError::Validation("DLDI patch length exceeded usize".into()))?;
        let patch = read_dldi_range_from_path(patch_path, 0, patch_read_len)?;
        let input_len = fs::metadata(&request.input)?.len();
        let input_len_usize = usize::try_from(input_len).unwrap_or(usize::MAX);
        let (execution, _pool) =
            context.build_pool(dldi_apply_thread_capability(input_len_usize))?;
        let apply =
            match apply_dldi_patch_to_file(&request.input, &request.output, &patch, input_len) {
                Ok(apply) => apply,
                Err(RomWeaverError::Validation(message))
                    if message == INPUT_NO_DLDI_SLOT_MESSAGE =>
                {
                    return Ok(OperationReport::unsupported(
                        OperationFamily::Patch,
                        Some(self.descriptor.name.to_string()),
                        "apply",
                        message,
                        Some(execution),
                    ));
                }
                Err(error) => return Err(error),
            };

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut label = format!(
            "applied {} driver `{}` over `{}` at 0x{:08X}",
            self.descriptor.name, apply.new_driver, apply.old_driver, apply.patch_offset
        );
        for warning in &apply.warnings {
            label.push_str("; warning=");
            label.push_str(warning);
        }

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "apply",
            label,
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let original_len = fs::metadata(&request.original)?.len();
        let modified_len = fs::metadata(&request.modified)?.len();
        let original_len_usize = usize::try_from(original_len).unwrap_or(usize::MAX);
        let modified_len_usize = usize::try_from(modified_len).unwrap_or(usize::MAX);
        let (execution, pool) = context.build_pool(dldi_create_thread_capability(
            original_len_usize,
            modified_len_usize,
        ))?;

        let (original_slot, modified_slot) = if execution.used_parallelism {
            let (left, right) = pool.install(|| {
                join(
                    || find_dldi_slot_in_path(&request.original),
                    || find_dldi_slot_in_path(&request.modified),
                )
            });
            (left?, right?)
        } else {
            (
                find_dldi_slot_in_path(&request.original)?,
                find_dldi_slot_in_path(&request.modified)?,
            )
        };

        let original_slot = original_slot.ok_or_else(|| {
            RomWeaverError::Validation(
                "original input does not contain a patchable DLDI section".into(),
            )
        })?;
        let modified_slot = modified_slot.ok_or_else(|| {
            RomWeaverError::Validation(
                "modified input does not contain a patchable DLDI section".into(),
            )
        })?;

        if original_slot != modified_slot {
            return Err(RomWeaverError::Validation(format!(
                "DLDI section moved between inputs (original: 0x{original_slot:08X}, modified: 0x{modified_slot:08X})"
            )));
        }

        let modified_header =
            read_dldi_header_for_apply_from_path(&request.modified, modified_slot, modified_len)?;
        let modified_slot_end = modified_slot
            .checked_add(modified_header.driver_size_bytes)
            .ok_or_else(|| {
                RomWeaverError::Validation("modified DLDI section range overflowed".into())
            })?;
        if u64::try_from(modified_slot_end)
            .ok()
            .is_none_or(|end| end > modified_len)
        {
            return Err(RomWeaverError::Validation(
                "modified DLDI section exceeded input length".into(),
            ));
        }

        let patch_bytes = read_dldi_range_from_path(
            &request.modified,
            modified_slot,
            modified_header.driver_size_bytes,
        )?;
        parse_dldi_bytes(&patch_bytes, "generated DLDI patch")?;

        // DLDI create is defined as extracting the relocated driver bytes from `modified`.
        // Validate determinism by replaying that patch against `original`.
        let replay_path = context
            .temp_paths()
            .next_path("dldi-create-replay", Some("bin"));
        apply_dldi_patch_to_file(&request.original, &replay_path, &patch_bytes, original_len)?;
        let replay_matches = files_equal(&replay_path, &request.modified)?;
        let _ = fs::remove_file(&replay_path);
        if !replay_matches {
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
            threaded_diff: true,
            threaded_output: true,
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
    patch_offset: usize,
    old_driver: String,
    new_driver: String,
    warnings: Vec<String>,
}

fn apply_dldi_patch_to_file(
    input_path: &Path,
    output_path: &Path,
    patch: &[u8],
    input_len: u64,
) -> Result<DldiApplyOutput> {
    let patch_header = parse_dldi_bytes_for_apply(patch, "DLDI patch")?;
    let mut input_reader = BlockCacheReader::open(
        input_path,
        DEFAULT_BLOCK_CACHE_SIZE_BYTES,
        DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
    )?;
    let patch_offset = find_dldi_slot_in_reader(&mut input_reader, input_len)?
        .ok_or_else(|| RomWeaverError::Validation(INPUT_NO_DLDI_SLOT_MESSAGE.into()))?;
    let patch_offset_u64 = u64::try_from(patch_offset)
        .map_err(|_| RomWeaverError::Validation("DLDI slot offset exceeded u64".into()))?;
    let available_len = input_len.saturating_sub(patch_offset_u64);
    let available_len_usize = usize::try_from(available_len)
        .map_err(|_| RomWeaverError::Validation("input DLDI section exceeded usize".into()))?;

    let header_len = usize::try_from(available_len.min(DO_CODE as u64))
        .map_err(|_| RomWeaverError::Validation("DLDI header length exceeded usize".into()))?;
    let mut header_bytes = vec![0u8; header_len];
    if header_len > 0 {
        input_reader.read_exact_at(patch_offset_u64, &mut header_bytes)?;
    }
    let existing_header = parse_dldi_bytes_for_apply(&header_bytes, "input DLDI section")?;
    if existing_header.driver_size_bytes > available_len_usize {
        return Err(RomWeaverError::Validation(format!(
            "input DLDI section declares {} byte(s), but only {} byte(s) are available",
            existing_header.driver_size_bytes, available_len_usize
        )));
    }

    let mut warnings = Vec::new();
    if patch_header.driver_size_log2 > existing_header.allocated_space_log2 {
        let available = size_from_log2(existing_header.allocated_space_log2, "input DLDI space")?;
        warnings.push(format!(
            "not enough space for DLDI patch (available {available} byte(s), need {} byte(s))",
            patch_header.driver_size_bytes
        ));
    }

    let patch_len_u64 = u64::try_from(patch_header.driver_size_bytes)
        .map_err(|_| RomWeaverError::Validation("DLDI patch length exceeded u64".into()))?;
    let patch_end = patch_offset_u64
        .checked_add(patch_len_u64)
        .ok_or_else(|| RomWeaverError::Validation("DLDI patch range overflowed".into()))?;
    if patch_end > input_len {
        warnings.push(format!(
            "input file ended before the DLDI patch slot; extending output from {} to {} byte(s)",
            input_len, patch_end
        ));
    }

    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(input_path, output_path)?;
    let mut output = OpenOptions::new()
        .read(true)
        .write(true)
        .open(output_path)?;
    output.set_len(patch_end.max(input_len))?;

    let mut slot = vec![0u8; patch_header.driver_size_bytes];
    let existing_slot_len = available_len_usize.min(patch_header.driver_size_bytes);
    if existing_slot_len > 0 {
        input_reader.read_exact_at(patch_offset_u64, &mut slot[..existing_slot_len])?;
    }

    let patch_copy_len = patch.len().min(patch_header.driver_size_bytes);
    slot[..patch_copy_len].copy_from_slice(&patch[..patch_copy_len]);
    slot[DO_ALLOCATED_SPACE] = existing_header.allocated_space_log2;

    let mut mem_offset = existing_header.text_start;
    if mem_offset == 0 {
        mem_offset = read_addr_i32(&slot, DO_STARTUP)?
            .checked_sub(DO_CODE_I32)
            .ok_or_else(|| {
                RomWeaverError::Validation(
                    "DLDI startup pointer underflowed while deriving memory offset".into(),
                )
            })?;
    }

    let relocation = i64::from(mem_offset) - i64::from(patch_header.text_start);
    relocate_header_pointers(&mut slot, relocation)?;

    let ddmem_start = i64::from(patch_header.text_start);
    let ddmem_end = ddmem_start
        .checked_add(i64::try_from(patch_header.driver_size_bytes).map_err(|_| {
            RomWeaverError::Validation("DLDI driver size exceeded 64-bit range".into())
        })?)
        .ok_or_else(|| RomWeaverError::Validation("DLDI address range overflowed".into()))?;

    if patch_header.fix_sections & FIX_ALL != 0 {
        relocate_pointer_range(
            &mut slot,
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
            &mut slot,
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
            &mut slot,
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
        clear_bss(&mut slot, patch, ddmem_start)?;
    }

    output.seek(SeekFrom::Start(patch_offset_u64))?;
    output.write_all(&slot)?;
    output.flush()?;

    Ok(DldiApplyOutput {
        patch_offset,
        old_driver: existing_header.friendly_name,
        new_driver: patch_header.friendly_name,
        warnings,
    })
}

fn parse_dldi_bytes(bytes: &[u8], label: &str) -> Result<DldiHeader> {
    parse_dldi_bytes_with_options(bytes, label, false)
}

fn parse_dldi_bytes_for_apply(bytes: &[u8], label: &str) -> Result<DldiHeader> {
    parse_dldi_bytes_with_options(bytes, label, true)
}

fn parse_dldi_header_from_path(
    path: &Path,
    label: &str,
    allow_truncated_driver_bytes: bool,
) -> Result<DldiHeader> {
    let file_len = fs::metadata(path)?.len();
    let read_len = usize::try_from(file_len.min(DO_CODE as u64))
        .map_err(|_| RomWeaverError::Validation("DLDI header length exceeded usize".into()))?;
    let mut reader = BlockCacheReader::open(
        path,
        DEFAULT_BLOCK_CACHE_SIZE_BYTES,
        DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
    )?;
    let mut header = vec![0u8; read_len];
    if read_len > 0 {
        reader.read_exact_at(0, &mut header)?;
    }
    let parsed = parse_dldi_bytes_with_options(&header, label, true)?;
    if !allow_truncated_driver_bytes
        && u64::try_from(parsed.driver_size_bytes)
            .ok()
            .is_some_and(|declared| declared > file_len)
    {
        return Err(RomWeaverError::Validation(format!(
            "{label} declares {} byte(s), but only {file_len} byte(s) are available",
            parsed.driver_size_bytes
        )));
    }
    Ok(parsed)
}

fn parse_dldi_bytes_with_options(
    bytes: &[u8],
    label: &str,
    allow_truncated_driver_bytes: bool,
) -> Result<DldiHeader> {
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
    if !allow_truncated_driver_bytes && driver_size_bytes > bytes.len() {
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

fn dldi_apply_thread_capability(input_len: usize) -> ThreadCapability {
    ThreadCapability::parallel(Some(dldi_thread_chunk_count(input_len)))
}

fn dldi_create_thread_capability(original_len: usize, modified_len: usize) -> ThreadCapability {
    let total_len = original_len.max(modified_len);
    ThreadCapability::parallel(Some(dldi_thread_chunk_count(total_len)))
}

fn dldi_thread_chunk_count(byte_len: usize) -> usize {
    if byte_len == 0 {
        return 1;
    }
    byte_len
        .saturating_add(THREAD_WORK_CHUNK_BYTES - 1)
        .saturating_div(THREAD_WORK_CHUNK_BYTES)
        .max(1)
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
    let value_bytes: [u8; 4] = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| {
            RomWeaverError::Validation(format!("DLDI address read out of bounds at 0x{offset:X}"))
        })?
        .try_into()
        .map_err(|_| {
            RomWeaverError::Validation(format!(
                "DLDI address read returned a non-4-byte slice at 0x{offset:X}"
            ))
        })?;
    Ok(i32::from_le_bytes(value_bytes))
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

fn find_dldi_slot_in_path(path: &Path) -> Result<Option<usize>> {
    let input_len = fs::metadata(path)?.len();
    let mut reader = BlockCacheReader::open(
        path,
        DEFAULT_BLOCK_CACHE_SIZE_BYTES,
        DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
    )?;
    find_dldi_slot_in_reader(&mut reader, input_len)
}

fn read_dldi_header_for_apply_from_path(
    path: &Path,
    start: usize,
    file_len: u64,
) -> Result<DldiHeader> {
    let offset = u64::try_from(start)
        .map_err(|_| RomWeaverError::Validation("DLDI offset exceeded u64".into()))?;
    if offset >= file_len {
        return Err(RomWeaverError::Validation(
            "modified DLDI section offset is outside file bounds".into(),
        ));
    }
    let mut reader = BlockCacheReader::open(
        path,
        DEFAULT_BLOCK_CACHE_SIZE_BYTES,
        DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
    )?;
    let read_len = usize::try_from((file_len - offset).min(DO_CODE as u64))
        .map_err(|_| RomWeaverError::Validation("DLDI header length exceeded usize".into()))?;
    let mut header = vec![0u8; read_len];
    reader.read_exact_at(offset, &mut header)?;
    parse_dldi_bytes_for_apply(&header, "modified DLDI section")
}

fn read_dldi_range_from_path(path: &Path, start: usize, len: usize) -> Result<Vec<u8>> {
    let offset = u64::try_from(start)
        .map_err(|_| RomWeaverError::Validation("DLDI offset exceeded u64".into()))?;
    let mut reader = BlockCacheReader::open(
        path,
        DEFAULT_BLOCK_CACHE_SIZE_BYTES,
        DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
    )?;
    let mut bytes = vec![0u8; len];
    reader.read_exact_at(offset, &mut bytes)?;
    Ok(bytes)
}

fn files_equal(left: &Path, right: &Path) -> Result<bool> {
    let left_len = fs::metadata(left)?.len();
    let right_len = fs::metadata(right)?.len();
    if left_len != right_len {
        return Ok(false);
    }

    let mut left_file = fs::File::open(left)?;
    let mut right_file = fs::File::open(right)?;
    let mut left_buffer = [0u8; 64 * 1024];
    let mut right_buffer = [0u8; 64 * 1024];
    loop {
        let left_read = left_file.read(&mut left_buffer)?;
        let right_read = right_file.read(&mut right_buffer)?;
        if left_read != right_read {
            return Ok(false);
        }
        if left_read == 0 {
            break;
        }
        if left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
    }
    Ok(true)
}

fn find_dldi_slot_in_reader(
    reader: &mut BlockCacheReader,
    input_len: u64,
) -> Result<Option<usize>> {
    let magic_len = u64::try_from(DLDI_MAGIC.len())
        .map_err(|_| RomWeaverError::Validation("DLDI magic length exceeded u64".into()))?;
    if input_len < magic_len {
        return Ok(None);
    }
    let search_end = input_len - magic_len;
    let mut offset = 0u64;
    let mut probe = [0u8; DLDI_MAGIC.len()];
    while offset <= search_end {
        reader.read_exact_at(offset, &mut probe)?;
        if probe == DLDI_MAGIC {
            let slot = usize::try_from(offset).map_err(|_| {
                RomWeaverError::Validation("DLDI slot offset exceeded usize".into())
            })?;
            return Ok(Some(slot));
        }
        offset = offset
            .checked_add(4)
            .ok_or_else(|| RomWeaverError::Validation("DLDI slot scan overflowed".into()))?;
    }
    Ok(None)
}

#[cfg(test)]
#[path = "../tests/unit/dldi.rs"]
mod tests;
