use std::{fs, path::Path};

use rayon::{join, prelude::*};
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchCreateRequest, PatchHandler, ProbeConfidence, Result, RomWeaverError,
    SharedThreadPool, ThreadCapability,
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
        let patch = crate::map_file_read_only(patch_path)?;
        let header = parse_dldi_bytes(patch.as_ref(), "DLDI patch")?;

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
        let patch = crate::map_file_read_only(patch_path)?;
        let input = crate::map_file_read_only(&request.input)?;
        let (execution, pool) = context.build_pool(dldi_apply_thread_capability(input.len()))?;
        let apply = match apply_dldi_patch(input.as_ref(), patch.as_ref(), &pool, &execution) {
            Ok(apply) => apply,
            Err(RomWeaverError::Validation(message)) if message == INPUT_NO_DLDI_SLOT_MESSAGE => {
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
        fs::write(&request.output, &apply.output)?;

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
        let original = crate::map_file_read_only(&request.original)?;
        let modified = crate::map_file_read_only(&request.modified)?;
        let (execution, pool) = context.build_pool(dldi_create_thread_capability(
            original.len(),
            modified.len(),
        ))?;

        let (original_slot, modified_slot) = if execution.used_parallelism {
            pool.install(|| {
                join(
                    || find_dldi_slot(original.as_ref()),
                    || find_dldi_slot(modified.as_ref()),
                )
            })
        } else {
            (
                find_dldi_slot(original.as_ref()),
                find_dldi_slot(modified.as_ref()),
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
            parse_dldi_at(modified.as_ref(), modified_slot, "modified DLDI section")?;
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
        let replay = apply_dldi_patch(original.as_ref(), &patch_bytes, &pool, &execution)?;
        let replay_matches = if execution.used_parallelism {
            bytes_equal_parallel(replay.output.as_slice(), modified.as_slice(), &pool)
        } else {
            replay.output == modified.as_slice()
        };
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
    output: Vec<u8>,
    patch_offset: usize,
    old_driver: String,
    new_driver: String,
    warnings: Vec<String>,
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
    parse_dldi_bytes_with_options(bytes, label, false)
}

fn parse_dldi_bytes_for_apply(bytes: &[u8], label: &str) -> Result<DldiHeader> {
    parse_dldi_bytes_with_options(bytes, label, true)
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

fn apply_dldi_patch(
    input: &[u8],
    patch: &[u8],
    pool: &SharedThreadPool,
    execution: &rom_weaver_core::ThreadExecution,
) -> Result<DldiApplyOutput> {
    let patch_header = parse_dldi_bytes_for_apply(patch, "DLDI patch")?;
    let patch_offset = find_dldi_slot(input)
        .ok_or_else(|| RomWeaverError::Validation(INPUT_NO_DLDI_SLOT_MESSAGE.into()))?;
    let mut warnings = Vec::new();

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
        warnings.push(format!(
            "not enough space for DLDI patch (available {available} byte(s), need {} byte(s))",
            patch_header.driver_size_bytes
        ));
    }

    let patch_end = patch_offset
        .checked_add(patch_header.driver_size_bytes)
        .ok_or_else(|| RomWeaverError::Validation("DLDI patch range overflowed".into()))?;
    if patch_end > input.len() {
        warnings.push(format!(
            "input file ended before the DLDI patch slot; extending output from {} to {} byte(s)",
            input.len(),
            patch_end
        ));
    }
    let output_len = patch_end.max(input.len());
    let mut output = vec![0u8; output_len];
    copy_input_bytes(&mut output, input, pool, execution);

    // Keep oversized applies deterministic: legacy dlditool overflow behavior is undefined,
    // so we copy only available patch bytes and still run full relocation/BSS fixups.
    let patch_copy_len = patch.len().min(patch_header.driver_size_bytes);
    output[patch_offset..patch_offset + patch_copy_len].copy_from_slice(&patch[..patch_copy_len]);
    output[patch_offset + DO_ALLOCATED_SPACE] = existing_header.allocated_space_log2;

    let input_slot = &input[patch_offset..];
    let mut mem_offset = existing_header.text_start;
    if mem_offset == 0 {
        mem_offset = read_addr_i32(input_slot, DO_STARTUP)?
            .checked_sub(DO_CODE_I32)
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
        .checked_add(i64::try_from(patch_header.driver_size_bytes).map_err(|_| {
            RomWeaverError::Validation("DLDI driver size exceeded 64-bit range".into())
        })?)
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
        warnings,
    })
}

fn copy_input_bytes(
    output: &mut [u8],
    input: &[u8],
    pool: &SharedThreadPool,
    execution: &rom_weaver_core::ThreadExecution,
) {
    let input_len = input.len();
    if execution.used_parallelism {
        pool.install(|| {
            output[..input_len]
                .par_chunks_mut(THREAD_WORK_CHUNK_BYTES)
                .enumerate()
                .for_each(|(chunk_index, chunk)| {
                    let start = chunk_index * THREAD_WORK_CHUNK_BYTES;
                    let end = start + chunk.len();
                    chunk.copy_from_slice(&input[start..end]);
                });
        });
    } else {
        output[..input_len].copy_from_slice(input);
    }
}

fn bytes_equal_parallel(left: &[u8], right: &[u8], pool: &SharedThreadPool) -> bool {
    if left.len() != right.len() {
        return false;
    }
    pool.install(|| {
        left.par_chunks(THREAD_WORK_CHUNK_BYTES)
            .zip(right.par_chunks(THREAD_WORK_CHUNK_BYTES))
            .all(|(lhs, rhs)| lhs == rhs)
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

fn find_dldi_slot(input: &[u8]) -> Option<usize> {
    let search_end = input.len().checked_sub(DLDI_MAGIC.len())?;
    let mut offset = 0usize;
    while offset <= search_end {
        if input[offset..offset + DLDI_MAGIC.len()] == DLDI_MAGIC {
            return Some(offset);
        }
        offset = offset.checked_add(4)?;
    }
    None
}

#[cfg(test)]
#[path = "../tests/unit/dldi.rs"]
mod tests;
