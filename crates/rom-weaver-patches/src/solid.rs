use std::{
    fs::{self, File},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use md5::{Digest, Md5};
use memmap2::{Mmap, MmapOptions};
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchChecksumValidation, PatchCreateRequest, PatchHandler, ProbeConfidence,
    Result, RomWeaverError, ThreadCapability,
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
        let patch = map_file_read_only(patch_path)?;
        let parsed = parse_solid_patch_bytes(patch.as_ref())?;

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
        let patch = map_file_read_only(patch_path)?;
        let parsed = parse_solid_patch_bytes(patch.as_ref())?;
        let validate_checksums =
            context.patch_checksum_validation() == PatchChecksumValidation::Strict;
        let input = map_file_read_only(&request.input)?;
        if validate_checksums {
            validate_source_checksum(parsed.source_md5, input.as_ref())?;
        }
        let output = apply_parsed_patch(&parsed, input.as_ref())?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&request.output, output)?;

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
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let original = map_file_read_only(&request.original)?;
        let modified = map_file_read_only(&request.modified)?;

        let expansion = build_created_expansion(original.as_ref(), modified.as_ref())?;
        let mod_action = if expansion.is_some() {
            MOD_ACTION_EXPAND
        } else if modified.len() < original.len() {
            MOD_ACTION_TRUNCATE
        } else {
            MOD_ACTION_NONE
        };
        let descriptions = build_description_strings(&request.original, &request.output);
        let uses_big_fields = original.len() > u32::MAX as usize
            || modified.len() > u32::MAX as usize
            || diff_primitive_count(original.as_ref(), modified.as_ref(), expansion.is_none())?
                > u32::MAX as u64;
        let addr_param =
            build_created_addr_param(mod_action, uses_big_fields, descriptions.patch_info_flag);

        let primitives =
            build_created_primitives(original.as_ref(), modified.as_ref(), expansion.is_none())?;
        let primitive_count = primitives.len() as u64;
        let source_md5 = md5_bytes(original.as_ref());
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
                write_u64_le(
                    &mut patch,
                    modified.len() as u64,
                    field_width,
                    "SOLID truncate size",
                )?;
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
        let replay = apply_parsed_patch(&parsed, original.as_ref())?;
        if replay != modified.as_ref() {
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
            threaded_diff: false,
            threaded_output: false,
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
        return Err(RomWeaverError::Validation(format!(
            "SOLID patch has unsupported version {version}; expected {SOLID_FORMAT_VERSION}"
        )));
    }

    let addr_param = bytes[cursor];
    cursor += 1;
    let uses_big_fields = addr_param & BIG_FILE_FLAG != 0;
    let base_addr_len = decode_base_addr_len(addr_param)?;
    let mod_action = (addr_param & MOD_ACTION_MASK) >> 4;
    if mod_action > MOD_ACTION_TRUNCATE {
        return Err(RomWeaverError::Validation(format!(
            "SOLID patch uses unsupported modFileAction value {mod_action}"
        )));
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
            let literal = read_exact(bytes, &mut cursor, usize::from(size_byte))?.to_vec();
            PrimitivePayload::Literal(literal)
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
            let data = read_exact(bytes, &mut cursor, size_usize)?.to_vec();
            if data.len() != size_usize {
                return Err(RomWeaverError::Validation(
                    "SOLID expansion data length did not match resizeFileDataSize".into(),
                ));
            }
            data
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

fn apply_parsed_patch(parsed: &ParsedSolidPatch, source: &[u8]) -> Result<Vec<u8>> {
    let mut output = source.to_vec();
    let mut cursor = 0u64;

    for primitive in &parsed.primitives {
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
        let write_len = primitive.write_len();
        let end = checked_add_usize(start, write_len, "SOLID primitive write end")?;
        if end > output.len() {
            output.resize(end, 0);
        }
        primitive.write_into(&mut output[start..end]);
        cursor = checked_add_u64(
            cursor,
            write_len as u64,
            "SOLID primitive cursor advance overflow",
        )?;
    }

    match parsed.resize {
        ResizeAction::None => {}
        ResizeAction::Expand { address, size } => {
            if size != parsed.expansion_data.len() as u64 {
                return Err(RomWeaverError::Validation(
                    "SOLID expansion payload length does not match resizeFileDataSize".into(),
                ));
            }
            let at = usize_from_u64(address, "SOLID resizeFileAddr")?;
            if at > output.len() {
                return Err(RomWeaverError::Validation(format!(
                    "SOLID resizeFileAddr {address} exceeds output length {}",
                    output.len()
                )));
            }
            output.splice(at..at, parsed.expansion_data.iter().copied());
        }
        ResizeAction::Truncate { size } => {
            let size = usize_from_u64(size, "SOLID resizeFileDataSize")?;
            if size > output.len() {
                return Err(RomWeaverError::Validation(format!(
                    "SOLID truncate size {size} exceeds output length {}",
                    output.len()
                )));
            }
            output.truncate(size);
        }
    }

    Ok(output)
}

fn validate_source_checksum(expected: [u8; SOLID_MD5_LEN], input: &[u8]) -> Result<()> {
    let actual = md5_bytes(input);
    if actual != expected {
        return Err(RomWeaverError::Validation(format!(
            "SOLID source MD5 mismatch; expected {}, actual {}",
            format_md5_hex(expected),
            format_md5_hex(actual)
        )));
    }
    Ok(())
}

fn map_file_read_only(path: &Path) -> Result<Mmap> {
    let file = File::open(path)?;
    // SAFETY: This mapping is read-only and the file handle lives through map creation.
    let map = unsafe { MmapOptions::new().map(&file)? };
    Ok(map)
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

fn diff_primitive_count(original: &[u8], modified: &[u8], include_suffix: bool) -> Result<u64> {
    Ok(build_created_primitives(original, modified, include_suffix)?.len() as u64)
}

fn build_created_primitives(
    original: &[u8],
    modified: &[u8],
    include_suffix: bool,
) -> Result<Vec<CreatedPrimitive>> {
    let shared_len = original.len().min(modified.len());
    let mut chunks = Vec::<(u64, &[u8])>::new();

    let mut index = 0usize;
    while index < shared_len {
        if original[index] == modified[index] {
            index += 1;
            continue;
        }

        let start = index;
        while index < shared_len && original[index] != modified[index] {
            index += 1;
        }
        chunks.push((start as u64, &modified[start..index]));
    }

    if include_suffix && modified.len() > shared_len {
        chunks.push((shared_len as u64, &modified[shared_len..]));
    }

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

fn build_created_expansion(original: &[u8], modified: &[u8]) -> Result<Option<CreatedExpansion>> {
    if modified.len() <= original.len() {
        return Ok(None);
    }

    let address = original.len() as u64;
    let data = modified[original.len()..].to_vec();
    Ok(Some(CreatedExpansion { address, data }))
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
    match std::env::var(SOLID_PATCH_INFO7_ENV) {
        Ok(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
        }
        Err(_) => false,
    }
}

fn read_env_string(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

fn write_description_string(output: &mut Vec<u8>, value: &str) -> Result<()> {
    if value.as_bytes().contains(&0) {
        return Err(RomWeaverError::Validation(
            "SOLID description strings may not contain embedded NUL bytes".into(),
        ));
    }
    if value.len() > SOLID_MAX_DESCRIPTION_LEN {
        return Err(RomWeaverError::Validation(format!(
            "SOLID description string exceeded {} byte(s)",
            SOLID_MAX_DESCRIPTION_LEN
        )));
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
        return Err(RomWeaverError::Validation(format!(
            "SOLID description string exceeded {} byte(s)",
            SOLID_MAX_DESCRIPTION_LEN
        )));
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
        return Err(RomWeaverError::Validation(format!(
            "SOLID patch declared unsupported base address size of {len} byte(s)"
        )));
    }
    Ok(Some(len))
}

fn read_required_base_addr(
    bytes: &[u8],
    cursor: &mut usize,
    base_addr_len: Option<usize>,
    label: &str,
) -> Result<u64> {
    let Some(base_addr_len) = base_addr_len else {
        return Err(RomWeaverError::Validation(
            "SOLID patch references BaseAddr but baseAddrSize is disabled".into(),
        ));
    };
    read_u64_le(bytes, cursor, base_addr_len, label)
}

fn read_u8(bytes: &[u8], cursor: &mut usize, label: &str) -> Result<u8> {
    let value = *bytes.get(*cursor).ok_or_else(|| {
        RomWeaverError::Validation(format!(
            "{label} is missing because SOLID patch ended unexpectedly"
        ))
    })?;
    *cursor = checked_add_usize(*cursor, 1, label)?;
    Ok(value)
}

fn read_u64_le(bytes: &[u8], cursor: &mut usize, width: usize, label: &str) -> Result<u64> {
    if width == 0 || width > 8 {
        return Err(RomWeaverError::Validation(format!(
            "{label} requested unsupported integer width {width}"
        )));
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

fn write_u64_le(output: &mut Vec<u8>, value: u64, width: usize, label: &str) -> Result<()> {
    if width == 0 || width > 8 {
        return Err(RomWeaverError::Validation(format!(
            "{label} requested unsupported integer width {width}"
        )));
    }
    for index in 0..width {
        output.push(((value >> (index * 8)) & 0xFF) as u8);
    }
    Ok(())
}

fn md5_bytes(bytes: &[u8]) -> [u8; SOLID_MD5_LEN] {
    let mut digest = [0u8; SOLID_MD5_LEN];
    digest.copy_from_slice(Md5::digest(bytes).as_slice());
    digest
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

fn usize_from_u64(value: u64, label: &str) -> Result<usize> {
    usize::try_from(value)
        .map_err(|_| RomWeaverError::Validation(format!("{label} exceeded usize")))
}

fn checked_add_usize(lhs: usize, rhs: usize, label: &str) -> Result<usize> {
    lhs.checked_add(rhs)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} overflowed")))
}

fn checked_add_u64(lhs: u64, rhs: u64, label: &str) -> Result<u64> {
    lhs.checked_add(rhs)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} overflowed")))
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
mod tests {
    use std::{
        fs,
        sync::{Mutex, OnceLock},
    };

    use rom_weaver_core::{PatchApplyRequest, PatchCreateRequest, PatchHandler};

    use super::*;
    use crate::{
        SOLID,
        test_support::{TestDir, test_context_with_threads_in_root as test_context_with_threads},
    };

    static SOLID_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    struct EnvRestore {
        entries: Vec<(&'static str, Option<String>)>,
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            for (name, value) in &self.entries {
                if let Some(value) = value {
                    set_env_var(name, value);
                } else {
                    remove_env_var(name);
                }
            }
        }
    }

    fn set_env_vars(vars: &[(&'static str, Option<&str>)]) -> EnvRestore {
        let mut entries = Vec::with_capacity(vars.len());
        for (name, value) in vars {
            entries.push((*name, std::env::var(name).ok()));
            if let Some(value) = value {
                set_env_var(name, value);
            } else {
                remove_env_var(name);
            }
        }
        EnvRestore { entries }
    }

    fn set_env_var(name: &str, value: &str) {
        // SAFETY: This test module serializes all environment mutation through
        // SOLID_ENV_LOCK, and values are always restored via EnvRestore.
        unsafe { std::env::set_var(name, value) };
    }

    fn remove_env_var(name: &str) {
        // SAFETY: This test module serializes all environment mutation through
        // SOLID_ENV_LOCK, and values are always restored via EnvRestore.
        unsafe { std::env::remove_var(name) };
    }

    fn with_solid_env_vars(vars: &[(&'static str, Option<&str>)], run: impl FnOnce()) {
        let lock = SOLID_ENV_LOCK.get_or_init(|| Mutex::new(()));
        let _guard = lock.lock().expect("solid env lock");
        let _restore = set_env_vars(vars);
        run();
    }

    #[test]
    fn parse_rejects_invalid_magic() {
        let temp = TestDir::new();
        let patch = temp.child("broken.solid");
        fs::write(&patch, b"XX\x04\x00bad").expect("fixture");

        let handler = SolidPatchHandler::new(&SOLID);
        let error = handler
            .parse(&patch, &test_context_with_threads(&temp, 1))
            .expect_err("parse should fail");
        assert!(error.to_string().contains("SOLID patch"));
    }

    #[test]
    fn create_and_apply_round_trip_for_truncate_case() {
        let temp = TestDir::new();
        let original = temp.child("old.bin");
        let modified = temp.child("new.bin");
        let patch = temp.child("update.solid");
        let output = temp.child("output.bin");

        fs::write(&original, b"ABCDEFGHIJ").expect("fixture");
        fs::write(&modified, b"ABCDzzG").expect("fixture");

        let handler = SolidPatchHandler::new(&SOLID);
        handler
            .create(
                &PatchCreateRequest {
                    original: original.clone(),
                    modified: modified.clone(),
                    output: patch.clone(),
                    format: "solid".into(),
                },
                &test_context_with_threads(&temp, 2),
            )
            .expect("create");
        handler
            .apply(
                &PatchApplyRequest {
                    input: original,
                    patches: vec![patch],
                    output: output.clone(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("apply");

        assert_eq!(
            fs::read(output).expect("output"),
            fs::read(modified).expect("modified")
        );
    }

    #[test]
    fn create_and_apply_round_trip_for_expand_case() {
        let temp = TestDir::new();
        let original = temp.child("old.bin");
        let modified = temp.child("new.bin");
        let patch = temp.child("update.solid");
        let output = temp.child("output.bin");

        fs::write(&original, b"ABCDEF").expect("fixture");
        fs::write(&modified, b"ABXCDEFZ").expect("fixture");

        let handler = SolidPatchHandler::new(&SOLID);
        handler
            .create(
                &PatchCreateRequest {
                    original: original.clone(),
                    modified: modified.clone(),
                    output: patch.clone(),
                    format: "solid".into(),
                },
                &test_context_with_threads(&temp, 2),
            )
            .expect("create");
        handler
            .apply(
                &PatchApplyRequest {
                    input: original,
                    patches: vec![patch.clone()],
                    output: output.clone(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("apply");

        let patch_bytes = fs::read(&patch).expect("patch bytes");
        assert_eq!(&patch_bytes[..SOLID_MAGIC.len()], SOLID_MAGIC);
        let addr_param = patch_bytes[SOLID_MAGIC.len() + 1];
        assert_eq!((addr_param & MOD_ACTION_MASK) >> 4, MOD_ACTION_EXPAND);

        assert_eq!(
            fs::read(output).expect("output"),
            fs::read(modified).expect("modified")
        );
    }

    #[test]
    fn create_can_emit_patch_info_flag_with_seven_strings() {
        with_solid_env_vars(
            &[
                (SOLID_PATCH_INFO7_ENV, Some("1")),
                (SOLID_PATCH_SYSTEM_ENV, Some("NDS")),
                (SOLID_PATCH_GAME_ENV, Some("Example Game")),
                (SOLID_PATCH_HACK_ENV, Some("Example Hack")),
                (SOLID_PATCH_VERSION_ENV, Some("v1.0")),
                (SOLID_PATCH_AUTHOR_ENV, Some("rom-weaver")),
                (SOLID_PATCH_CONTACT_ENV, Some("example@example.com")),
                (SOLID_PATCH_COMMENT_ENV, Some("generated in tests")),
            ],
            || {
                let temp = TestDir::new();
                let original = temp.child("old.bin");
                let modified = temp.child("new.bin");
                let patch = temp.child("update.solid");
                fs::write(&original, b"abcdefgh").expect("fixture");
                fs::write(&modified, b"abcXefgh").expect("fixture");

                let handler = SolidPatchHandler::new(&SOLID);
                handler
                    .create(
                        &PatchCreateRequest {
                            original,
                            modified,
                            output: patch.clone(),
                            format: "solid".into(),
                        },
                        &test_context_with_threads(&temp, 1),
                    )
                    .expect("create");

                let patch_bytes = fs::read(&patch).expect("patch bytes");
                let addr_param = patch_bytes[SOLID_MAGIC.len() + 1];
                assert_ne!(addr_param & PATCH_INFO_FLAG, 0);

                let mut cursor = SOLID_MAGIC.len() + 2;
                let width = if addr_param & BIG_FILE_FLAG != 0 {
                    8
                } else {
                    4
                };
                let _primitive_count =
                    read_u64_le(&patch_bytes, &mut cursor, width, "SOLID primitive count")
                        .expect("primitive count");
                let _source_md5 = read_md5(&patch_bytes, &mut cursor).expect("md5");
                let _creation_date =
                    read_exact(&patch_bytes, &mut cursor, SOLID_DATE_LEN).expect("date");

                let mut description_strings = Vec::new();
                for _ in 0..SOLID_MAX_DESCRIPTION_COUNT {
                    description_strings.push(
                        read_null_terminated_string(&patch_bytes, &mut cursor)
                            .expect("description string"),
                    );
                }

                assert_eq!(description_strings[0], "NDS");
                assert_eq!(description_strings[1], "Example Game");
                assert_eq!(description_strings[2], "Example Hack");
                assert_eq!(description_strings[3], "v1.0");
                assert_eq!(description_strings[4], "rom-weaver");
                assert_eq!(description_strings[5], "example@example.com");
                assert_eq!(description_strings[6], "generated in tests");
            },
        );
    }

    #[test]
    fn apply_rejects_md5_mismatch() {
        let temp = TestDir::new();
        let original = temp.child("old.bin");
        let modified = temp.child("new.bin");
        let patch = temp.child("update.solid");
        let wrong_input = temp.child("wrong.bin");
        let output = temp.child("output.bin");

        fs::write(&original, b"ABCDEFGH").expect("fixture");
        fs::write(&modified, b"ABCXEFGH").expect("fixture");
        fs::write(&wrong_input, b"XXXXXXXX").expect("fixture");

        let handler = SolidPatchHandler::new(&SOLID);
        handler
            .create(
                &PatchCreateRequest {
                    original: original,
                    modified,
                    output: patch.clone(),
                    format: "solid".into(),
                },
                &test_context_with_threads(&temp, 2),
            )
            .expect("create");

        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: wrong_input,
                    patches: vec![patch],
                    output,
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect_err("apply should fail");
        assert!(error.to_string().contains("MD5 mismatch"));
    }
}
