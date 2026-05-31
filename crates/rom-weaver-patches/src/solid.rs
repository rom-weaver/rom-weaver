use std::{
    fs::{self, File, OpenOptions},
    io::{BufReader, BufWriter, ErrorKind, Read, Seek, SeekFrom, Write},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use rayon::prelude::*;
use rom_weaver_checksum::md5_file;
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchChecksumValidation, PatchCreateRequest, PatchHandler, ProbeConfidence,
    Result, RomWeaverError, SharedThreadPool, ThreadCapability, ValidationCodeError,
};

const SOLID_MAGIC: &[u8; 2] = b"SP";
const SOLID_FORMAT_VERSION: u8 = 4;
const SOLID_MD5_LEN: usize = 16;
const SOLID_DATE_LEN: usize = 3;
const SOLID_MAX_DESCRIPTION_LEN: usize = 512;
const SOLID_MAX_DESCRIPTION_COUNT: usize = 7;

const BASE_ADDR_SIZE_MASK: u8 = 0b0000_0111;
const BIG_FILE_FLAG: u8 = 0b0000_1000;
const MOD_ACTION_MASK: u8 = 0b0011_0000;
const PATCH_INFO_FLAG: u8 = 0b0100_0000;
const EXTENSION_FLAG: u8 = 0b1000_0000;

const MOD_ACTION_NONE: u8 = 0;
const MOD_ACTION_EXPAND: u8 = 1;
const MOD_ACTION_TRUNCATE: u8 = 2;

const CREATED_BASE_ADDR_FIELD: u8 = 7; // 8-byte base address deltas.
const SOLID_PATCH_INFO7_ENV: &str = "ROM_WEAVER_SOLID_PATCH_INFO7";
const SOLID_PATCH_SYSTEM_ENV: &str = "ROM_WEAVER_SOLID_SYSTEM";
const SOLID_PATCH_GAME_ENV: &str = "ROM_WEAVER_SOLID_GAME";
const SOLID_PATCH_HACK_ENV: &str = "ROM_WEAVER_SOLID_HACK";
const SOLID_PATCH_VERSION_ENV: &str = "ROM_WEAVER_SOLID_VERSION";
const SOLID_PATCH_AUTHOR_ENV: &str = "ROM_WEAVER_SOLID_AUTHOR";
const SOLID_PATCH_CONTACT_ENV: &str = "ROM_WEAVER_SOLID_CONTACT";
const SOLID_PATCH_COMMENT_ENV: &str = "ROM_WEAVER_SOLID_COMMENT";
const CREATE_THREAD_SCAN_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const CREATE_IO_BUFFER_SIZE: usize = 64 * 1024;

fn solid_validation_code(code: &'static str) -> ValidationCodeError {
    ValidationCodeError::new(code)
}

pub struct SolidPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl SolidPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl PatchHandler for SolidPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let parsed = parse_solid_patch_file(patch_path)?;

        let mut label = format!(
            "parsed {} v{} patch with {} {}",
            self.descriptor.name,
            parsed.version,
            parsed.primitives.len(),
            pluralize(parsed.primitives.len(), "primitive", "primitives"),
        );
        if let Some(date) = parsed.creation_date {
            label.push_str(&format!(
                "; created {:04}-{:02}-{:02}",
                date.year, date.month, date.day
            ));
        }
        match parsed.resize {
            ResizeAction::None => {}
            ResizeAction::Expand { address, size } => {
                label.push_str(&format!("; expand at {address} for {size} byte(s)"));
            }
            ResizeAction::Truncate { size } => {
                label.push_str(&format!("; truncate output to {size} byte(s)"));
            }
        }
        label.push_str(&format!(
            "; source md5 {}",
            format_md5_hex(parsed.source_md5)
        ));

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
        let patch_path = crate::require_single_patch_file(&request.patches, self.descriptor.name)?;
        let parsed = parse_solid_patch_file(patch_path)?;
        let validate_checksums =
            context.patch_checksum_validation() == PatchChecksumValidation::Strict;
        if validate_checksums {
            validate_source_checksum(parsed.source_md5, &request.input)?;
        }
        let thread_capability = solid_apply_thread_capability(parsed.primitives.len());
        let planned_execution = context.plan_threads(thread_capability.clone());
        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let execution = if planned_execution.used_parallelism {
            let (execution, pool) = context.build_pool(thread_capability)?;
            apply_parsed_patch_parallel_to_file(
                &parsed,
                &request.input,
                &request.output,
                &pool,
                context,
            )?;
            execution
        } else {
            apply_parsed_patch_to_file(&parsed, &request.input, &request.output, context)?;
            planned_execution
        };

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
                "applied {} patch with {} {}{}",
                self.descriptor.name,
                parsed.primitives.len(),
                pluralize(parsed.primitives.len(), "primitive", "primitives"),
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
        let original_len = fs::metadata(&request.original)?.len();
        let modified_len = fs::metadata(&request.modified)?.len();
        let shared_len = original_len.min(modified_len);
        let (execution, pool) = context.build_pool(solid_create_thread_capability(shared_len))?;
        let expansion =
            build_created_expansion_from_paths(original_len, &request.modified, modified_len)?;
        let mod_action = if expansion.is_some() {
            MOD_ACTION_EXPAND
        } else if modified_len < original_len {
            MOD_ACTION_TRUNCATE
        } else {
            MOD_ACTION_NONE
        };
        let descriptions = build_description_strings(&request.original, &request.output);
        let primitives = build_created_primitives_with_threads_from_paths(
            &request.original,
            original_len,
            &request.modified,
            modified_len,
            expansion.is_none(),
            &pool,
            execution.used_parallelism,
            context,
        )?;
        let uses_big_fields = original_len > u64::from(u32::MAX)
            || modified_len > u64::from(u32::MAX)
            || primitives.len() > u32::MAX as usize;
        let addr_param =
            build_created_addr_param(mod_action, uses_big_fields, descriptions.patch_info_flag);
        let primitive_count = primitives.len() as u64;
        let source_md5 = md5_file(&request.original)?;
        let date = current_patch_date();

        let mut patch = Vec::new();
        patch.extend_from_slice(SOLID_MAGIC);
        patch.push(SOLID_FORMAT_VERSION);
        patch.push(addr_param);
        write_u64_le(
            &mut patch,
            primitive_count,
            if uses_big_fields { 8 } else { 4 },
            "SOLID primitive count",
        )?;
        patch.extend_from_slice(&source_md5);
        patch.extend_from_slice(&encode_patch_date(date));
        for description in &descriptions.values {
            write_description_string(&mut patch, description)?;
        }
        let field_width = if uses_big_fields { 8 } else { 4 };
        match mod_action {
            MOD_ACTION_EXPAND => {
                let expansion = expansion.as_ref().ok_or_else(|| {
                    RomWeaverError::Validation("SOLID expansion data missing during create".into())
                })?;
                write_u64_le(
                    &mut patch,
                    expansion.address,
                    field_width,
                    "SOLID resizeFileAddr",
                )?;
                write_u64_le(
                    &mut patch,
                    expansion.data.len() as u64,
                    field_width,
                    "SOLID resizeFileDataSize",
                )?;
            }
            MOD_ACTION_TRUNCATE => {
                write_u64_le(&mut patch, modified_len, field_width, "SOLID truncate size")?;
            }
            MOD_ACTION_NONE => {}
            _ => unreachable!(),
        }

        let base_addr_len = decode_base_addr_len(addr_param)?;
        for primitive in &primitives {
            patch.push(0);
            patch.push(primitive.data.len() as u8);
            write_u64_le(
                &mut patch,
                primitive.base_delta,
                base_addr_len.unwrap_or(0),
                "SOLID base address delta",
            )?;
            patch.extend_from_slice(&primitive.data);
        }
        if let Some(expansion) = expansion.as_ref() {
            patch.extend_from_slice(&expansion.data);
        }

        // Validate that created patches are deterministic by replaying them.
        let parsed = parse_solid_patch_bytes(&patch)?;
        let replay_path = context
            .temp_paths()
            .next_path("solid-create-replay", Some("bin"));
        apply_parsed_patch_to_file(&parsed, &request.original, &replay_path, context)?;
        let replay_matches = files_equal(&replay_path, &request.modified)?;
        let _ = fs::remove_file(&replay_path);
        if !replay_matches {
            return Err(RomWeaverError::Validation(
                "created SOLID patch does not round-trip to modified input".into(),
            ));
        }

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&request.output, patch)?;

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created {} patch with {} {}",
                self.descriptor.name,
                primitive_count,
                pluralize(primitive_count as usize, "primitive", "primitives")
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

#[derive(Clone, Copy, Debug)]
struct PatchDate {
    year: u16,
    month: u8,
    day: u8,
}

#[derive(Debug)]
struct ParsedSolidPatch {
    version: u8,
    source_md5: [u8; SOLID_MD5_LEN],
    creation_date: Option<PatchDate>,
    resize: ResizeAction,
    primitives: Vec<ParsedPrimitive>,
    expansion_data: Vec<u8>,
}

#[derive(Debug)]
enum ResizeAction {
    None,
    Expand { address: u64, size: u64 },
    Truncate { size: u64 },
}

#[derive(Debug)]
struct ParsedPrimitive {
    addr_byte: u8,
    base_delta: Option<u64>,
    payload: PrimitivePayload,
}

#[derive(Debug)]
enum PrimitivePayload {
    Literal(Vec<u8>),
    Rle { len: u8, value: u8 },
}

#[derive(Debug)]
struct CreatedPrimitive {
    base_delta: u64,
    data: Vec<u8>,
}

struct PrimitiveWritePlan {
    primitive_index: usize,
    start: usize,
    len: usize,
}

struct PreparedSolidWrite {
    start: usize,
    data: Vec<u8>,
}

#[derive(Debug)]
struct CreatedExpansion {
    address: u64,
    data: Vec<u8>,
}

#[derive(Debug)]
struct SolidDescriptionStrings {
    values: Vec<String>,
    patch_info_flag: bool,
}

fn parse_solid_patch_file(path: &Path) -> Result<ParsedSolidPatch> {
    let file_len = fs::metadata(path)?.len();
    if file_len < (SOLID_MAGIC.len() + 2 + SOLID_MD5_LEN + SOLID_DATE_LEN) as u64 {
        return Err(RomWeaverError::Validation(
            "SOLID patch is too small to contain a valid header".into(),
        ));
    }

    let mut parser = SolidFileParser::new(BufReader::new(File::open(path)?), file_len);
    let magic = parser.read_exact(SOLID_MAGIC.len(), "SOLID magic header")?;
    if magic.as_slice() != SOLID_MAGIC {
        return Err(RomWeaverError::Validation(
            "SOLID patch has an invalid magic header".into(),
        ));
    }

    let version = parser.read_u8("SOLID version")?;
    if version != SOLID_FORMAT_VERSION {
        return Err(RomWeaverError::ValidationCode(
            solid_validation_code("SOLID_VERSION_UNSUPPORTED")
                .with_message("SOLID patch has unsupported version")
                .with_field("version", version)
                .with_field("expected_version", SOLID_FORMAT_VERSION),
        ));
    }

    let addr_param = parser.read_u8("SOLID addrParam")?;
    let uses_big_fields = addr_param & BIG_FILE_FLAG != 0;
    let base_addr_len = decode_base_addr_len(addr_param)?;
    let mod_action = (addr_param & MOD_ACTION_MASK) >> 4;
    if mod_action > MOD_ACTION_TRUNCATE {
        return Err(RomWeaverError::ValidationCode(
            solid_validation_code("SOLID_MOD_FILE_ACTION_UNSUPPORTED")
                .with_message("SOLID patch uses unsupported modFileAction value")
                .with_field("mod_file_action", mod_action),
        ));
    }
    if addr_param & EXTENSION_FLAG != 0 {
        return Err(RomWeaverError::Validation(
            "SOLID patch uses extensionFlag, which is unsupported in specification v4".into(),
        ));
    }

    let primitive_count =
        parser.read_u64_le(if uses_big_fields { 8 } else { 4 }, "SOLID primitive count")?;
    let primitive_count = usize::try_from(primitive_count).map_err(|_| {
        RomWeaverError::Validation("SOLID primitive count exceeded addressable memory".into())
    })?;

    let source_md5 = parser.read_md5()?;
    let creation_date = decode_patch_date(
        parser
            .read_exact(SOLID_DATE_LEN, "SOLID patch date")?
            .as_slice(),
    );

    let description_count = if addr_param & PATCH_INFO_FLAG != 0 {
        SOLID_MAX_DESCRIPTION_COUNT
    } else {
        3
    };
    for _ in 0..description_count {
        let _ = parser.read_null_terminated_string()?;
    }

    let field_size = if uses_big_fields { 8 } else { 4 };
    let resize = match mod_action {
        MOD_ACTION_NONE => ResizeAction::None,
        MOD_ACTION_EXPAND => {
            let address = parser.read_u64_le(field_size, "SOLID resizeFileAddr")?;
            let size = parser.read_u64_le(field_size, "SOLID resizeFileDataSize")?;
            ResizeAction::Expand { address, size }
        }
        MOD_ACTION_TRUNCATE => {
            let size = parser.read_u64_le(field_size, "SOLID resizeFileDataSize")?;
            ResizeAction::Truncate { size }
        }
        _ => unreachable!(),
    };

    let mut primitives = Vec::with_capacity(primitive_count);
    for _ in 0..primitive_count {
        let addr_byte = parser.read_u8("SOLID primitive addrByteArr")?;
        let size_byte = parser.read_u8("SOLID primitive sizeByteArr")?;
        let base_delta = if addr_byte == 0 {
            let Some(base_addr_len) = base_addr_len else {
                return Err(RomWeaverError::Validation(
                    "SOLID patch references BaseAddr but baseAddrSize is disabled".into(),
                ));
            };
            Some(parser.read_u64_le(base_addr_len, "SOLID primitive base address")?)
        } else {
            None
        };

        let payload = if size_byte == 0 {
            let len = parser.read_u8("SOLID RLE length")?;
            let value = parser.read_u8("SOLID RLE value")?;
            PrimitivePayload::Rle { len, value }
        } else {
            PrimitivePayload::Literal(
                parser.read_exact(usize::from(size_byte), "SOLID literal payload")?,
            )
        };
        primitives.push(ParsedPrimitive {
            addr_byte,
            base_delta,
            payload,
        });
    }

    let expansion_data = match resize {
        ResizeAction::Expand { size, .. } => {
            let size_usize = usize::try_from(size).map_err(|_| {
                RomWeaverError::Validation("SOLID expansion size exceeded usize".into())
            })?;
            parser.read_exact(size_usize, "SOLID expansion data")?
        }
        _ => Vec::new(),
    };

    if !parser.is_at_end() {
        return Err(RomWeaverError::Validation(
            "SOLID patch contained unexpected trailing data".into(),
        ));
    }

    Ok(ParsedSolidPatch {
        version,
        source_md5,
        creation_date,
        resize,
        primitives,
        expansion_data,
    })
}

fn parse_solid_patch_bytes(bytes: &[u8]) -> Result<ParsedSolidPatch> {
    if bytes.len() < SOLID_MAGIC.len() + 2 + SOLID_MD5_LEN + SOLID_DATE_LEN {
        return Err(RomWeaverError::Validation(
            "SOLID patch is too small to contain a valid header".into(),
        ));
    }
    if &bytes[..SOLID_MAGIC.len()] != SOLID_MAGIC {
        return Err(RomWeaverError::Validation(
            "SOLID patch has an invalid magic header".into(),
        ));
    }

    let mut cursor = SOLID_MAGIC.len();
    let version = bytes[cursor];
    cursor += 1;
    if version != SOLID_FORMAT_VERSION {
        return Err(RomWeaverError::ValidationCode(
            solid_validation_code("SOLID_VERSION_UNSUPPORTED")
                .with_message("SOLID patch has unsupported version")
                .with_field("version", version)
                .with_field("expected_version", SOLID_FORMAT_VERSION),
        ));
    }

    let addr_param = bytes[cursor];
    cursor += 1;
    let uses_big_fields = addr_param & BIG_FILE_FLAG != 0;
    let base_addr_len = decode_base_addr_len(addr_param)?;
    let mod_action = (addr_param & MOD_ACTION_MASK) >> 4;
    if mod_action > MOD_ACTION_TRUNCATE {
        return Err(RomWeaverError::ValidationCode(
            solid_validation_code("SOLID_MOD_FILE_ACTION_UNSUPPORTED")
                .with_message("SOLID patch uses unsupported modFileAction value")
                .with_field("mod_file_action", mod_action),
        ));
    }
    if addr_param & EXTENSION_FLAG != 0 {
        return Err(RomWeaverError::Validation(
            "SOLID patch uses extensionFlag, which is unsupported in specification v4".into(),
        ));
    }

    let primitive_count = read_u64_le(
        bytes,
        &mut cursor,
        if uses_big_fields { 8 } else { 4 },
        "SOLID primitive count",
    )?;
    let primitive_count = usize::try_from(primitive_count).map_err(|_| {
        RomWeaverError::Validation("SOLID primitive count exceeded addressable memory".into())
    })?;

    let source_md5 = read_md5(bytes, &mut cursor)?;
    let creation_date = decode_patch_date(read_exact(bytes, &mut cursor, SOLID_DATE_LEN)?);

    let description_count = if addr_param & PATCH_INFO_FLAG != 0 {
        SOLID_MAX_DESCRIPTION_COUNT
    } else {
        3
    };
    for _ in 0..description_count {
        let _ = read_null_terminated_string(bytes, &mut cursor)?;
    }

    let field_size = if uses_big_fields { 8 } else { 4 };
    let resize = match mod_action {
        MOD_ACTION_NONE => ResizeAction::None,
        MOD_ACTION_EXPAND => {
            let address = read_u64_le(bytes, &mut cursor, field_size, "SOLID resizeFileAddr")?;
            let size = read_u64_le(bytes, &mut cursor, field_size, "SOLID resizeFileDataSize")?;
            ResizeAction::Expand { address, size }
        }
        MOD_ACTION_TRUNCATE => {
            let size = read_u64_le(bytes, &mut cursor, field_size, "SOLID resizeFileDataSize")?;
            ResizeAction::Truncate { size }
        }
        _ => unreachable!(),
    };

    let mut primitives = Vec::with_capacity(primitive_count);
    for _ in 0..primitive_count {
        let addr_byte = read_u8(bytes, &mut cursor, "SOLID primitive addrByteArr")?;
        let size_byte = read_u8(bytes, &mut cursor, "SOLID primitive sizeByteArr")?;
        let base_delta = if addr_byte == 0 {
            Some(read_required_base_addr(
                bytes,
                &mut cursor,
                base_addr_len,
                "SOLID primitive base address",
            )?)
        } else {
            None
        };

        let payload = if size_byte == 0 {
            let len = read_u8(bytes, &mut cursor, "SOLID RLE length")?;
            let value = read_u8(bytes, &mut cursor, "SOLID RLE value")?;
            PrimitivePayload::Rle { len, value }
        } else {
            let literal = read_exact(bytes, &mut cursor, usize::from(size_byte))?;
            PrimitivePayload::Literal(literal.to_vec())
        };
        primitives.push(ParsedPrimitive {
            addr_byte,
            base_delta,
            payload,
        });
    }

    let expansion_data = match resize {
        ResizeAction::Expand { size, .. } => {
            let size_usize = usize::try_from(size).map_err(|_| {
                RomWeaverError::Validation("SOLID expansion size exceeded usize".into())
            })?;
            let data = read_exact(bytes, &mut cursor, size_usize)?;
            if data.len() != size_usize {
                return Err(RomWeaverError::Validation(
                    "SOLID expansion data length did not match resizeFileDataSize".into(),
                ));
            }
            data.to_vec()
        }
        _ => Vec::new(),
    };

    if cursor != bytes.len() {
        return Err(RomWeaverError::Validation(
            "SOLID patch contained unexpected trailing data".into(),
        ));
    }

    Ok(ParsedSolidPatch {
        version,
        source_md5,
        creation_date,
        resize,
        primitives,
        expansion_data,
    })
}

fn apply_parsed_patch_to_file(
    parsed: &ParsedSolidPatch,
    source_path: &Path,
    output_path: &Path,
    context: &OperationContext,
) -> Result<()> {
    let source_len = usize_from_u64(fs::metadata(source_path)?.len(), "SOLID source length")?;
    let (plans, required_output_len) = build_primitive_write_plans(parsed, source_len)?;

    let writes = plans
        .iter()
        .map(|plan| {
            let primitive = parsed.primitives.get(plan.primitive_index).ok_or_else(|| {
                RomWeaverError::Validation(
                    "SOLID primitive plan referenced an out-of-range primitive".into(),
                )
            })?;
            let mut data = vec![0u8; plan.len];
            primitive.write_into(&mut data);
            Ok(PreparedSolidWrite {
                start: plan.start,
                data,
            })
        })
        .collect::<Result<Vec<_>>>()?;

    apply_solid_writes_and_resize_to_file(
        parsed,
        source_path,
        output_path,
        required_output_len,
        writes,
        context,
    )
}

fn apply_parsed_patch_parallel_to_file(
    parsed: &ParsedSolidPatch,
    source_path: &Path,
    output_path: &Path,
    pool: &SharedThreadPool,
    context: &OperationContext,
) -> Result<()> {
    let source_len = usize_from_u64(fs::metadata(source_path)?.len(), "SOLID source length")?;
    let (plans, required_output_len) = build_primitive_write_plans(parsed, source_len)?;
    let writes = pool.install(|| {
        plans
            .par_iter()
            .map(|plan| {
                context.cancel().check()?;
                let primitive = parsed.primitives.get(plan.primitive_index).ok_or_else(|| {
                    RomWeaverError::Validation(
                        "SOLID primitive plan referenced an out-of-range primitive".into(),
                    )
                })?;
                let mut data = vec![0u8; plan.len];
                primitive.write_into(&mut data);
                Ok(PreparedSolidWrite {
                    start: plan.start,
                    data,
                })
            })
            .collect::<Result<Vec<_>>>()
    })?;

    apply_solid_writes_and_resize_to_file(
        parsed,
        source_path,
        output_path,
        required_output_len,
        writes,
        context,
    )
}

fn apply_solid_writes_and_resize_to_file(
    parsed: &ParsedSolidPatch,
    source_path: &Path,
    output_path: &Path,
    required_output_len: usize,
    writes: Vec<PreparedSolidWrite>,
    context: &OperationContext,
) -> Result<()> {
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(source_path, output_path)?;
    let mut output = OpenOptions::new()
        .read(true)
        .write(true)
        .open(output_path)?;
    let required_output_len_u64 = u64::try_from(required_output_len)
        .map_err(|_| RomWeaverError::Validation("SOLID output length exceeded u64".into()))?;
    if output.metadata()?.len() < required_output_len_u64 {
        output.set_len(required_output_len_u64)?;
    }

    for write in writes {
        let start = u64::try_from(write.start)
            .map_err(|_| RomWeaverError::Validation("SOLID write start exceeded u64".into()))?;
        output.seek(SeekFrom::Start(start))?;
        output.write_all(&write.data)?;
    }
    output.flush()?;
    drop(output);

    apply_resize_action_to_file(parsed, output_path, context)
}

fn apply_resize_action_to_file(
    parsed: &ParsedSolidPatch,
    output_path: &Path,
    context: &OperationContext,
) -> Result<()> {
    match parsed.resize {
        ResizeAction::None => {}
        ResizeAction::Expand { address, size } => {
            if size != parsed.expansion_data.len() as u64 {
                return Err(RomWeaverError::Validation(
                    "SOLID expansion payload length does not match resizeFileDataSize".into(),
                ));
            }
            let output_len = fs::metadata(output_path)?.len();
            if address > output_len {
                return Err(RomWeaverError::ValidationCode(
                    solid_validation_code("SOLID_RESIZE_ADDR_EXCEEDED_OUTPUT_LENGTH")
                        .with_message("SOLID resizeFileAddr exceeds output length")
                        .with_field("resize_addr", address)
                        .with_field("output_len", output_len),
                ));
            }
            if size == 0 {
                return Ok(());
            }

            let temp_path = context
                .temp_paths()
                .next_path("solid-apply-expand", Some("bin"));
            if let Some(parent) = temp_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut output = File::open(output_path)?;
            let temp_file = File::create(&temp_path)?;
            let mut temp = BufWriter::new(temp_file);
            copy_file_range(&mut output, &mut temp, 0, address)?;
            temp.write_all(&parsed.expansion_data)?;
            copy_file_range(
                &mut output,
                &mut temp,
                address,
                output_len.saturating_sub(address),
            )?;
            temp.flush()?;
            drop(temp);

            if let Err(error) = fs::rename(&temp_path, output_path) {
                if error.kind() == ErrorKind::AlreadyExists
                    || error.kind() == ErrorKind::PermissionDenied
                {
                    fs::remove_file(output_path)?;
                    fs::rename(&temp_path, output_path)?;
                } else {
                    let _ = fs::remove_file(&temp_path);
                    return Err(error.into());
                }
            }
        }
        ResizeAction::Truncate { size } => {
            let output_len = fs::metadata(output_path)?.len();
            if size > output_len {
                return Err(RomWeaverError::ValidationCode(
                    solid_validation_code("SOLID_TRUNCATE_SIZE_EXCEEDED_OUTPUT_LENGTH")
                        .with_message("SOLID truncate size exceeds output length")
                        .with_field("truncate_size", size)
                        .with_field("output_len", output_len),
                ));
            }
            OpenOptions::new()
                .write(true)
                .open(output_path)?
                .set_len(size)?;
        }
    }
    Ok(())
}

fn copy_file_range(reader: &mut File, writer: &mut dyn Write, start: u64, len: u64) -> Result<()> {
    if len == 0 {
        return Ok(());
    }
    reader.seek(SeekFrom::Start(start))?;
    let mut remaining = len;
    let mut buffer = [0u8; 64 * 1024];
    while remaining > 0 {
        let chunk_len = usize::try_from(remaining.min(buffer.len() as u64))
            .map_err(|_| RomWeaverError::Validation("SOLID copy chunk exceeded usize".into()))?;
        reader.read_exact(&mut buffer[..chunk_len])?;
        writer.write_all(&buffer[..chunk_len])?;
        remaining -= chunk_len as u64;
    }
    Ok(())
}

fn build_primitive_write_plans(
    parsed: &ParsedSolidPatch,
    initial_output_len: usize,
) -> Result<(Vec<PrimitiveWritePlan>, usize)> {
    let mut plans = Vec::with_capacity(parsed.primitives.len());
    let mut cursor = 0u64;
    let mut required_output_len = initial_output_len;

    for (primitive_index, primitive) in parsed.primitives.iter().enumerate() {
        match primitive.addr_byte {
            0 => {
                let delta = primitive.base_delta.ok_or_else(|| {
                    RomWeaverError::Validation(
                        "SOLID primitive used base addressing without base address bytes".into(),
                    )
                })?;
                cursor = checked_add_u64(cursor, delta, "SOLID primitive address overflow")?;
            }
            0xFF => {}
            relative => {
                cursor = checked_add_u64(
                    cursor,
                    u64::from(relative),
                    "SOLID primitive relative address overflow",
                )?;
            }
        }

        let start = usize_from_u64(cursor, "SOLID primitive address")?;
        let len = primitive.write_len();
        let end = checked_add_usize(start, len, "SOLID primitive write end")?;
        required_output_len = required_output_len.max(end);
        plans.push(PrimitiveWritePlan {
            primitive_index,
            start,
            len,
        });

        cursor = checked_add_u64(
            cursor,
            len as u64,
            "SOLID primitive cursor advance overflow",
        )?;
    }

    Ok((plans, required_output_len))
}

fn validate_source_checksum(expected: [u8; SOLID_MD5_LEN], input_path: &Path) -> Result<()> {
    let actual = md5_file(input_path)?;
    if actual != expected {
        return Err(RomWeaverError::ValidationCode(
            solid_validation_code("SOLID_SOURCE_MD5_MISMATCH")
                .with_message("SOLID source MD5 mismatch")
                .with_field("expected", format_md5_hex(expected))
                .with_field("actual", format_md5_hex(actual)),
        ));
    }
    Ok(())
}

fn build_created_addr_param(mod_action: u8, uses_big_fields: bool, patch_info_flag: bool) -> u8 {
    let mut addr_param = CREATED_BASE_ADDR_FIELD | ((mod_action & 0b11) << 4);
    if uses_big_fields {
        addr_param |= BIG_FILE_FLAG;
    }
    if patch_info_flag {
        addr_param |= PATCH_INFO_FLAG;
    }
    addr_param
}

fn solid_create_thread_capability(shared_len: u64) -> ThreadCapability {
    let chunk_count = solid_create_chunk_count(shared_len).max(1);
    ThreadCapability::parallel(Some(chunk_count))
}

fn solid_apply_thread_capability(primitive_count: usize) -> ThreadCapability {
    ThreadCapability::parallel(Some(primitive_count.max(1)))
}

fn solid_create_chunk_count(shared_len: u64) -> usize {
    if shared_len == 0 {
        return 1;
    }
    let chunk_bytes = CREATE_THREAD_SCAN_CHUNK_BYTES as u64;
    let chunk_count = shared_len.saturating_add(chunk_bytes - 1) / chunk_bytes;
    usize::try_from(chunk_count).unwrap_or(usize::MAX)
}

fn build_created_primitives_with_threads_from_paths(
    original_path: &Path,
    original_len: u64,
    modified_path: &Path,
    modified_len: u64,
    include_suffix: bool,
    pool: &SharedThreadPool,
    use_parallel_scan: bool,
    context: &OperationContext,
) -> Result<Vec<CreatedPrimitive>> {
    let effective_parallel = use_parallel_scan && !crate::patches_reads_source_on_main_thread();
    let chunks = if effective_parallel {
        collect_created_chunks_parallel_from_paths(
            original_path,
            original_len,
            modified_path,
            modified_len,
            include_suffix,
            pool,
            context,
        )?
    } else {
        collect_created_chunks_sequential_from_paths(
            original_path,
            original_len,
            modified_path,
            modified_len,
            include_suffix,
            context,
        )?
    };
    build_created_primitives_from_chunks(chunks)
}

fn collect_created_chunks_sequential_from_paths(
    original_path: &Path,
    original_len: u64,
    modified_path: &Path,
    modified_len: u64,
    include_suffix: bool,
    context: &OperationContext,
) -> Result<Vec<(u64, Vec<u8>)>> {
    let shared_len = original_len.min(modified_len);
    if shared_len == 0 {
        if include_suffix && modified_len > 0 {
            let suffix = read_solid_suffix(modified_path, 0, modified_len)?;
            return Ok(vec![(0, suffix)]);
        }
        return Ok(Vec::new());
    }

    let mut original = File::open(original_path)?;
    let mut modified = File::open(modified_path)?;
    let mut original_buffer = vec![0u8; CREATE_IO_BUFFER_SIZE];
    let mut modified_buffer = vec![0u8; CREATE_IO_BUFFER_SIZE];
    let mut chunks = Vec::<(u64, Vec<u8>)>::new();
    let mut pending_start: Option<u64> = None;
    let mut pending_bytes = Vec::<u8>::new();
    let mut cursor = 0u64;

    while cursor < shared_len {
        context.cancel().check()?;
        let chunk_len = usize::try_from((shared_len - cursor).min(CREATE_IO_BUFFER_SIZE as u64))
            .map_err(|_| RomWeaverError::Validation("SOLID compare chunk exceeded usize".into()))?;
        original.read_exact(&mut original_buffer[..chunk_len])?;
        modified.read_exact(&mut modified_buffer[..chunk_len])?;

        for index in 0..chunk_len {
            let source = original_buffer[index];
            let target = modified_buffer[index];
            if source == target {
                if !pending_bytes.is_empty() {
                    chunks.push((
                        pending_start.expect("pending start exists"),
                        std::mem::take(&mut pending_bytes),
                    ));
                    pending_start = None;
                }
            } else {
                if pending_start.is_none() {
                    pending_start = Some(cursor + index as u64);
                }
                pending_bytes.push(target);
            }
        }
        cursor = cursor
            .checked_add(chunk_len as u64)
            .ok_or_else(|| RomWeaverError::Validation("SOLID compare cursor overflowed".into()))?;
    }

    if !pending_bytes.is_empty() {
        chunks.push((pending_start.expect("pending start exists"), pending_bytes));
    }
    if include_suffix && modified_len > shared_len {
        chunks.push((
            shared_len,
            read_solid_suffix(modified_path, shared_len, modified_len)?,
        ));
    }
    Ok(chunks)
}

fn collect_created_chunks_parallel_from_paths(
    original_path: &Path,
    original_len: u64,
    modified_path: &Path,
    modified_len: u64,
    include_suffix: bool,
    pool: &SharedThreadPool,
    context: &OperationContext,
) -> Result<Vec<(u64, Vec<u8>)>> {
    let shared_len = original_len.min(modified_len);
    if shared_len == 0 {
        if include_suffix && modified_len > 0 {
            let suffix = read_solid_suffix(modified_path, 0, modified_len)?;
            return Ok(vec![(0, suffix)]);
        }
        return Ok(Vec::new());
    }

    let chunk_count = solid_create_chunk_count(shared_len);
    let per_chunk = pool.install(|| {
        (0..chunk_count)
            .into_par_iter()
            .map(|chunk_index| {
                context.cancel().check()?;
                collect_created_chunk_ranges_from_file_chunk(
                    original_path,
                    original_len,
                    modified_path,
                    modified_len,
                    chunk_index,
                )
            })
            .collect::<Result<Vec<_>>>()
    })?;

    let mut merged = Vec::<(u64, Vec<u8>)>::new();
    for chunks in per_chunk {
        for mut chunk in chunks {
            if let Some(last) = merged.last_mut() {
                let last_len = u64::try_from(last.1.len()).map_err(|_| {
                    RomWeaverError::Validation(
                        "SOLID create chunk length exceeded 64-bit range".into(),
                    )
                })?;
                let last_end = last.0.checked_add(last_len).ok_or_else(|| {
                    RomWeaverError::Validation("SOLID create chunk offset overflowed".into())
                })?;
                if last_end == chunk.0 {
                    last.1.append(&mut chunk.1);
                    continue;
                }
            }
            merged.push(chunk);
        }
    }

    if include_suffix && modified_len > shared_len {
        let mut suffix = (
            shared_len,
            read_solid_suffix(modified_path, shared_len, modified_len)?,
        );
        if let Some(last) = merged.last_mut() {
            let last_len = u64::try_from(last.1.len()).map_err(|_| {
                RomWeaverError::Validation("SOLID create chunk length exceeded 64-bit range".into())
            })?;
            let last_end = last.0.checked_add(last_len).ok_or_else(|| {
                RomWeaverError::Validation("SOLID create chunk offset overflowed".into())
            })?;
            if last_end == suffix.0 {
                last.1.append(&mut suffix.1);
                return Ok(merged);
            }
        }
        merged.push(suffix);
    }

    Ok(merged)
}

fn collect_created_chunk_ranges_from_file_chunk(
    original_path: &Path,
    original_len: u64,
    modified_path: &Path,
    modified_len: u64,
    chunk_index: usize,
) -> Result<Vec<(u64, Vec<u8>)>> {
    let shared_len = original_len.min(modified_len);
    let start = u64::try_from(chunk_index)
        .ok()
        .and_then(|index| index.checked_mul(CREATE_THREAD_SCAN_CHUNK_BYTES as u64))
        .ok_or_else(|| RomWeaverError::Validation("SOLID chunk offset overflowed".into()))?;
    if start >= shared_len {
        return Ok(Vec::new());
    }
    let end = start
        .saturating_add(CREATE_THREAD_SCAN_CHUNK_BYTES as u64)
        .min(shared_len);

    let mut original = File::open(original_path)?;
    let mut modified = File::open(modified_path)?;
    original.seek(SeekFrom::Start(start))?;
    modified.seek(SeekFrom::Start(start))?;

    let mut original_buffer = vec![0u8; CREATE_IO_BUFFER_SIZE];
    let mut modified_buffer = vec![0u8; CREATE_IO_BUFFER_SIZE];
    let mut chunks = Vec::<(u64, Vec<u8>)>::new();
    let mut pending_start: Option<u64> = None;
    let mut pending_bytes = Vec::<u8>::new();
    let mut cursor = start;

    while cursor < end {
        let chunk_len = usize::try_from((end - cursor).min(CREATE_IO_BUFFER_SIZE as u64))
            .map_err(|_| RomWeaverError::Validation("SOLID compare chunk exceeded usize".into()))?;
        original.read_exact(&mut original_buffer[..chunk_len])?;
        modified.read_exact(&mut modified_buffer[..chunk_len])?;

        for index in 0..chunk_len {
            let source = original_buffer[index];
            let target = modified_buffer[index];
            if source == target {
                if !pending_bytes.is_empty() {
                    chunks.push((
                        pending_start.expect("pending start exists"),
                        std::mem::take(&mut pending_bytes),
                    ));
                    pending_start = None;
                }
            } else {
                if pending_start.is_none() {
                    pending_start = Some(cursor + index as u64);
                }
                pending_bytes.push(target);
            }
        }
        cursor = cursor
            .checked_add(chunk_len as u64)
            .ok_or_else(|| RomWeaverError::Validation("SOLID compare cursor overflowed".into()))?;
    }

    if !pending_bytes.is_empty() {
        chunks.push((pending_start.expect("pending start exists"), pending_bytes));
    }
    Ok(chunks)
}

fn build_created_primitives_from_chunks(
    chunks: Vec<(u64, Vec<u8>)>,
) -> Result<Vec<CreatedPrimitive>> {
    let mut primitives = Vec::new();
    let mut cursor = 0u64;
    for (offset, bytes) in chunks {
        let mut consumed = 0usize;
        while consumed < bytes.len() {
            let end = (consumed + u8::MAX as usize).min(bytes.len());
            let segment = &bytes[consumed..end];
            let absolute = checked_add_u64(offset, consumed as u64, "SOLID segment offset")?;
            if absolute < cursor {
                return Err(RomWeaverError::Validation(
                    "SOLID create produced non-monotonic primitive addresses".into(),
                ));
            }
            let delta = absolute - cursor;
            primitives.push(CreatedPrimitive {
                base_delta: delta,
                data: segment.to_vec(),
            });
            cursor = checked_add_u64(
                absolute,
                segment.len() as u64,
                "SOLID create cursor overflow",
            )?;
            consumed = end;
        }
    }

    Ok(primitives)
}

fn read_solid_suffix(path: &Path, start: u64, end: u64) -> Result<Vec<u8>> {
    if end <= start {
        return Ok(Vec::new());
    }
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let capacity = usize::try_from(end - start)
        .map_err(|_| RomWeaverError::Validation("SOLID suffix length exceeded usize".into()))?;
    let mut data = Vec::with_capacity(capacity);
    let mut buffer = [0u8; CREATE_IO_BUFFER_SIZE];
    let mut remaining = end - start;
    while remaining > 0 {
        let chunk_len = usize::try_from(remaining.min(buffer.len() as u64))
            .map_err(|_| RomWeaverError::Validation("SOLID suffix chunk exceeded usize".into()))?;
        file.read_exact(&mut buffer[..chunk_len])?;
        data.extend_from_slice(&buffer[..chunk_len]);
        remaining -= chunk_len as u64;
    }
    Ok(data)
}

fn build_created_expansion_from_paths(
    original_len: u64,
    modified_path: &Path,
    modified_len: u64,
) -> Result<Option<CreatedExpansion>> {
    if modified_len <= original_len {
        return Ok(None);
    }

    let address = original_len;
    let data = read_solid_suffix(modified_path, original_len, modified_len)?;
    Ok(Some(CreatedExpansion { address, data }))
}

fn files_equal(left: &Path, right: &Path) -> Result<bool> {
    let left_len = fs::metadata(left)?.len();
    let right_len = fs::metadata(right)?.len();
    if left_len != right_len {
        return Ok(false);
    }
    let mut left_file = File::open(left)?;
    let mut right_file = File::open(right)?;
    let mut left_buffer = [0u8; CREATE_IO_BUFFER_SIZE];
    let mut right_buffer = [0u8; CREATE_IO_BUFFER_SIZE];
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

fn build_description_strings(original: &Path, output_patch: &Path) -> SolidDescriptionStrings {
    let file_type = original
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("bin")
        .to_string();
    let game = original
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("input")
        .to_string();
    let hack = output_patch
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("patch")
        .to_string();

    if solid_patch_info7_enabled() {
        let system = read_env_string(SOLID_PATCH_SYSTEM_ENV).unwrap_or(file_type);
        let game = read_env_string(SOLID_PATCH_GAME_ENV).unwrap_or(game);
        let hack = read_env_string(SOLID_PATCH_HACK_ENV).unwrap_or(hack);
        let version = read_env_string(SOLID_PATCH_VERSION_ENV).unwrap_or_default();
        let author = read_env_string(SOLID_PATCH_AUTHOR_ENV).unwrap_or_default();
        let contact = read_env_string(SOLID_PATCH_CONTACT_ENV).unwrap_or_default();
        let comment = read_env_string(SOLID_PATCH_COMMENT_ENV).unwrap_or_default();
        return SolidDescriptionStrings {
            values: vec![system, game, hack, version, author, contact, comment],
            patch_info_flag: true,
        };
    }

    SolidDescriptionStrings {
        values: vec![file_type, game, hack],
        patch_info_flag: false,
    }
}

fn solid_patch_info7_enabled() -> bool {
    match read_env_string(SOLID_PATCH_INFO7_ENV) {
        Some(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
        }
        None => false,
    }
}

fn read_env_string(name: &str) -> Option<String> {
    #[cfg(test)]
    if let Some(value) = solid_test_env_lookup(name) {
        return value;
    }
    std::env::var(name).ok()
}

#[cfg(test)]
thread_local! {
    static SOLID_TEST_ENV_OVERRIDES: std::cell::RefCell<std::collections::HashMap<String, Option<String>>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
}

#[cfg(test)]
fn solid_test_env_lookup(name: &str) -> Option<Option<String>> {
    SOLID_TEST_ENV_OVERRIDES.with(|state| state.borrow().get(name).cloned())
}

#[cfg(test)]
fn set_solid_test_env_override(name: &'static str, value: Option<&str>) -> Option<Option<String>> {
    SOLID_TEST_ENV_OVERRIDES.with(|state| {
        let mut state = state.borrow_mut();
        state.insert(name.to_string(), value.map(|entry| entry.to_string()))
    })
}

#[cfg(test)]
fn restore_solid_test_env_override(name: &'static str, previous: Option<Option<String>>) {
    SOLID_TEST_ENV_OVERRIDES.with(|state| {
        let mut state = state.borrow_mut();
        if let Some(value) = previous {
            state.insert(name.to_string(), value);
        } else {
            state.remove(name);
        }
    });
}

fn write_description_string(output: &mut Vec<u8>, value: &str) -> Result<()> {
    if value.as_bytes().contains(&0) {
        return Err(RomWeaverError::Validation(
            "SOLID description strings may not contain embedded NUL bytes".into(),
        ));
    }
    if value.len() > SOLID_MAX_DESCRIPTION_LEN {
        return Err(RomWeaverError::ValidationCode(
            solid_validation_code("SOLID_DESCRIPTION_STRING_EXCEEDED_MAX_LEN")
                .with_message("SOLID description string exceeded max length")
                .with_field("max_len", SOLID_MAX_DESCRIPTION_LEN)
                .with_field("actual_len", value.len()),
        ));
    }
    output.extend_from_slice(value.as_bytes());
    output.push(0);
    Ok(())
}

fn read_null_terminated_string(bytes: &[u8], cursor: &mut usize) -> Result<String> {
    if *cursor >= bytes.len() {
        return Err(RomWeaverError::Validation(
            "SOLID patch ended unexpectedly while reading description strings".into(),
        ));
    }

    let start = *cursor;
    let remaining = &bytes[start..];
    let Some(terminator) = remaining.iter().position(|value| *value == 0) else {
        return Err(RomWeaverError::Validation(
            "SOLID description string is missing a terminating NUL byte".into(),
        ));
    };
    if terminator > SOLID_MAX_DESCRIPTION_LEN {
        return Err(RomWeaverError::ValidationCode(
            solid_validation_code("SOLID_DESCRIPTION_STRING_EXCEEDED_MAX_LEN")
                .with_message("SOLID description string exceeded max length")
                .with_field("max_len", SOLID_MAX_DESCRIPTION_LEN)
                .with_field("actual_len", terminator),
        ));
    }
    let string_bytes = &remaining[..terminator];
    let string = std::str::from_utf8(string_bytes)
        .map_err(|_| {
            RomWeaverError::Validation("SOLID description string is not valid UTF-8".into())
        })?
        .to_string();
    *cursor = checked_add_usize(start, terminator + 1, "SOLID description cursor")?;
    Ok(string)
}

struct SolidFileParser<R> {
    reader: R,
    file_len: u64,
    cursor: u64,
}

impl<R: Read> SolidFileParser<R> {
    fn new(reader: R, file_len: u64) -> Self {
        Self {
            reader,
            file_len,
            cursor: 0,
        }
    }

    fn is_at_end(&self) -> bool {
        self.cursor == self.file_len
    }

    fn read_exact(&mut self, len: usize, label: &'static str) -> Result<Vec<u8>> {
        let len_u64 = u64::try_from(len).map_err(|_| {
            RomWeaverError::ValidationCode(
                solid_validation_code("SOLID_USIZE_CONVERSION_OVERFLOW")
                    .with_field("label", label)
                    .with_field("value", len),
            )
        })?;
        let next = self.cursor.checked_add(len_u64).ok_or_else(|| {
            RomWeaverError::ValidationCode(
                solid_validation_code("SOLID_U64_ADD_OVERFLOW")
                    .with_field("label", label)
                    .with_field("lhs", self.cursor)
                    .with_field("rhs", len_u64),
            )
        })?;
        if next > self.file_len {
            return Err(RomWeaverError::Validation(
                "SOLID patch ended unexpectedly while reading binary data".into(),
            ));
        }

        let mut bytes = vec![0u8; len];
        self.reader.read_exact(&mut bytes)?;
        self.cursor = next;
        Ok(bytes)
    }

    fn read_u8(&mut self, label: &'static str) -> Result<u8> {
        Ok(self.read_exact(1, label)?[0])
    }

    fn read_u64_le(&mut self, width: usize, label: &'static str) -> Result<u64> {
        if width == 0 || width > 8 {
            return Err(RomWeaverError::ValidationCode(
                solid_validation_code("SOLID_INTEGER_WIDTH_UNSUPPORTED")
                    .with_field("label", label)
                    .with_field("width", width),
            ));
        }
        let raw = self.read_exact(width, label)?;
        let mut value = 0u64;
        for (index, byte) in raw.iter().enumerate() {
            value |= u64::from(*byte) << (index * 8);
        }
        Ok(value)
    }

    fn read_md5(&mut self) -> Result<[u8; SOLID_MD5_LEN]> {
        let raw = self.read_exact(SOLID_MD5_LEN, "SOLID source md5")?;
        let mut md5 = [0u8; SOLID_MD5_LEN];
        md5.copy_from_slice(&raw);
        Ok(md5)
    }

    fn read_null_terminated_string(&mut self) -> Result<String> {
        if self.cursor >= self.file_len {
            return Err(RomWeaverError::Validation(
                "SOLID patch ended unexpectedly while reading description strings".into(),
            ));
        }

        let mut bytes = Vec::new();
        loop {
            let byte = self.read_u8("SOLID description string byte")?;
            if byte == 0 {
                break;
            }
            bytes.push(byte);
            if bytes.len() > SOLID_MAX_DESCRIPTION_LEN {
                return Err(RomWeaverError::ValidationCode(
                    solid_validation_code("SOLID_DESCRIPTION_STRING_EXCEEDED_MAX_LEN")
                        .with_message("SOLID description string exceeded max length")
                        .with_field("max_len", SOLID_MAX_DESCRIPTION_LEN)
                        .with_field("actual_len", bytes.len()),
                ));
            }
        }

        let string = std::str::from_utf8(&bytes)
            .map_err(|_| {
                RomWeaverError::Validation("SOLID description string is not valid UTF-8".into())
            })?
            .to_string();
        Ok(string)
    }
}

fn current_patch_date() -> PatchDate {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| std::time::Duration::from_secs(0));
    let days_since_epoch = (now.as_secs() / 86_400) as i64;
    let (year, month, day) = civil_from_days(days_since_epoch);
    PatchDate {
        year: year as u16,
        month: month as u8,
        day: day as u8,
    }
}

fn encode_patch_date(date: PatchDate) -> [u8; SOLID_DATE_LEN] {
    let year_bits = date.year.saturating_sub(1900);
    let packed = u32::from(year_bits)
        | (u32::from(date.day) << 15)
        | (u32::from(date.month.saturating_sub(1)) << 20);
    let bytes = packed.to_le_bytes();
    [bytes[0], bytes[1], bytes[2]]
}

fn decode_patch_date(bytes: &[u8]) -> Option<PatchDate> {
    if bytes.len() != SOLID_DATE_LEN {
        return None;
    }
    let packed = u32::from(bytes[0]) | (u32::from(bytes[1]) << 8) | (u32::from(bytes[2]) << 16);
    let year = (packed & 0x7FFF) as u16 + 1900;
    let day = ((packed >> 15) & 0x1F) as u8;
    let month = ((packed >> 20) & 0x0F) as u8 + 1;
    if day == 0 || month == 0 || month > 12 {
        return None;
    }
    Some(PatchDate { year, month, day })
}

fn civil_from_days(days_since_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = (yoe + era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (mp + if mp < 10 { 3 } else { -9 }) as u32;
    if month <= 2 {
        year += 1;
    }
    (year, month, day)
}

fn decode_base_addr_len(addr_param: u8) -> Result<Option<usize>> {
    let encoded = addr_param & BASE_ADDR_SIZE_MASK;
    if encoded == 0 {
        return Ok(None);
    }
    let len = usize::from(encoded) + 1;
    if !(2..=8).contains(&len) {
        return Err(RomWeaverError::ValidationCode(
            solid_validation_code("SOLID_BASE_ADDR_SIZE_UNSUPPORTED")
                .with_field("base_addr_size", len),
        ));
    }
    Ok(Some(len))
}

fn read_required_base_addr(
    bytes: &[u8],
    cursor: &mut usize,
    base_addr_len: Option<usize>,
    label: &'static str,
) -> Result<u64> {
    let Some(base_addr_len) = base_addr_len else {
        return Err(RomWeaverError::Validation(
            "SOLID patch references BaseAddr but baseAddrSize is disabled".into(),
        ));
    };
    read_u64_le(bytes, cursor, base_addr_len, label)
}

fn read_u8(bytes: &[u8], cursor: &mut usize, label: &'static str) -> Result<u8> {
    let value = *bytes.get(*cursor).ok_or_else(|| {
        RomWeaverError::ValidationCode(
            solid_validation_code("SOLID_READ_U8_UNEXPECTED_EOF")
                .with_field("label", label)
                .with_field("cursor", *cursor)
                .with_field("len", bytes.len()),
        )
    })?;
    *cursor = checked_add_usize(*cursor, 1, label)?;
    Ok(value)
}

fn read_u64_le(bytes: &[u8], cursor: &mut usize, width: usize, label: &'static str) -> Result<u64> {
    if width == 0 || width > 8 {
        return Err(RomWeaverError::ValidationCode(
            solid_validation_code("SOLID_INTEGER_WIDTH_UNSUPPORTED")
                .with_field("label", label)
                .with_field("width", width),
        ));
    }
    let raw = read_exact(bytes, cursor, width)?;
    let mut value = 0u64;
    for (index, byte) in raw.iter().enumerate() {
        value |= u64::from(*byte) << (index * 8);
    }
    Ok(value)
}

fn read_md5(bytes: &[u8], cursor: &mut usize) -> Result<[u8; SOLID_MD5_LEN]> {
    let raw = read_exact(bytes, cursor, SOLID_MD5_LEN)?;
    let mut md5 = [0u8; SOLID_MD5_LEN];
    md5.copy_from_slice(raw);
    Ok(md5)
}

fn read_exact<'a>(bytes: &'a [u8], cursor: &mut usize, len: usize) -> Result<&'a [u8]> {
    let start = *cursor;
    let end = checked_add_usize(start, len, "SOLID read cursor")?;
    if end > bytes.len() {
        return Err(RomWeaverError::Validation(
            "SOLID patch ended unexpectedly while reading binary data".into(),
        ));
    }
    *cursor = end;
    Ok(&bytes[start..end])
}

fn write_u64_le(output: &mut Vec<u8>, value: u64, width: usize, label: &'static str) -> Result<()> {
    if width == 0 || width > 8 {
        return Err(RomWeaverError::ValidationCode(
            solid_validation_code("SOLID_INTEGER_WIDTH_UNSUPPORTED")
                .with_field("label", label)
                .with_field("width", width),
        ));
    }
    for index in 0..width {
        output.push(((value >> (index * 8)) & 0xFF) as u8);
    }
    Ok(())
}

fn format_md5_hex(value: [u8; SOLID_MD5_LEN]) -> String {
    let mut output = String::with_capacity(SOLID_MD5_LEN * 2);
    for byte in value {
        output.push(hex_nibble(byte >> 4));
        output.push(hex_nibble(byte & 0x0F));
    }
    output
}

fn hex_nibble(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        10..=15 => (b'a' + (value - 10)) as char,
        _ => '0',
    }
}

fn usize_from_u64(value: u64, label: &'static str) -> Result<usize> {
    usize::try_from(value).map_err(|_| {
        RomWeaverError::ValidationCode(
            solid_validation_code("SOLID_USIZE_CONVERSION_OVERFLOW")
                .with_field("label", label)
                .with_field("value", value),
        )
    })
}

fn checked_add_usize(lhs: usize, rhs: usize, label: &'static str) -> Result<usize> {
    lhs.checked_add(rhs).ok_or_else(|| {
        RomWeaverError::ValidationCode(
            solid_validation_code("SOLID_USIZE_ADD_OVERFLOW")
                .with_field("label", label)
                .with_field("lhs", lhs)
                .with_field("rhs", rhs),
        )
    })
}

fn checked_add_u64(lhs: u64, rhs: u64, label: &'static str) -> Result<u64> {
    lhs.checked_add(rhs).ok_or_else(|| {
        RomWeaverError::ValidationCode(
            solid_validation_code("SOLID_U64_ADD_OVERFLOW")
                .with_field("label", label)
                .with_field("lhs", lhs)
                .with_field("rhs", rhs),
        )
    })
}

fn pluralize<'a>(count: usize, singular: &'a str, plural: &'a str) -> &'a str {
    if count == 1 { singular } else { plural }
}

impl ParsedPrimitive {
    fn write_len(&self) -> usize {
        match self.payload {
            PrimitivePayload::Literal(ref data) => data.len(),
            PrimitivePayload::Rle { len, .. } => usize::from(len),
        }
    }

    fn write_into(&self, output: &mut [u8]) {
        match self.payload {
            PrimitivePayload::Literal(ref data) => output.copy_from_slice(data),
            PrimitivePayload::Rle { value, .. } => output.fill(value),
        }
    }
}

#[cfg(test)]
#[path = "../tests/unit/solid.rs"]
mod tests;
