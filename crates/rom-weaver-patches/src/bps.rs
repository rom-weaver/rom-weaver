use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

use crc32fast::Hasher;
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchCreateRequest, PatchHandler, ProbeConfidence, Result, RomWeaverError,
    ThreadCapability,
};

const BPS_MAGIC: &[u8; 4] = b"BPS1";
const BPS_FOOTER_SIZE: usize = 12;
const COPY_BUFFER_SIZE: usize = 32 * 1024;

pub struct BpsPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl BpsPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }

    fn unsupported_label(&self, operation: &str) -> String {
        format!(
            "{operation} is not implemented yet for {}",
            self.descriptor.name
        )
    }
}

impl PatchHandler for BpsPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let patch = parse_bps_file(patch_path)?;
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "parse",
            format!(
                "parsed {} patch with {} record(s)",
                self.descriptor.name,
                patch.actions.len()
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

        let patch = parse_bps_file(&request.patches[0])?;
        let mut source = File::open(&request.input)?;
        validate_input_file(&mut source, patch.source_size, patch.source_checksum)?;

        let mut output = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&request.output)?;
        apply_patch_actions(&patch, &mut source, &mut output)?;
        validate_output_file(&mut output, patch.target_size, patch.target_checksum)?;

        let execution = context.plan_threads(ThreadCapability::single_threaded());
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "apply",
            format!(
                "applied {} patch with {} record(s)",
                self.descriptor.name,
                patch.actions.len()
            ),
            Some(1.0),
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
            self.unsupported_label("create"),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> PatchCapabilities {
        PatchCapabilities {
            parse: true,
            apply: true,
            create: false,
            threaded_scan: false,
            threaded_diff: false,
            threaded_output: false,
        }
    }
}

#[derive(Debug)]
struct ParsedBpsPatch {
    source_size: u64,
    target_size: u64,
    source_checksum: u32,
    target_checksum: u32,
    actions: Vec<BpsAction>,
}

#[derive(Debug)]
enum BpsAction {
    SourceRead { length: u64 },
    TargetRead { data: Vec<u8> },
    SourceCopy { length: u64, relative_offset: i128 },
    TargetCopy { length: u64, relative_offset: i128 },
}

fn parse_bps_file(path: &Path) -> Result<ParsedBpsPatch> {
    let bytes = fs::read(path)?;
    parse_bps_bytes(&bytes)
}

fn parse_bps_bytes(bytes: &[u8]) -> Result<ParsedBpsPatch> {
    if bytes.len() < BPS_MAGIC.len() + BPS_FOOTER_SIZE {
        return Err(RomWeaverError::Validation(
            "BPS patch is too small to contain a valid header and footer".into(),
        ));
    }

    let footer_offset = bytes
        .len()
        .checked_sub(BPS_FOOTER_SIZE)
        .expect("validated footer size");
    let mut parser = BpsParser::new(bytes, footer_offset);

    if parser.read_exact(BPS_MAGIC.len())? != BPS_MAGIC {
        return Err(RomWeaverError::Validation("Patch header invalid".into()));
    }

    let source_size = parser.read_varint()?;
    let target_size = parser.read_varint()?;
    let metadata_size = usize::try_from(parser.read_varint()?).map_err(|_| {
        RomWeaverError::Validation("BPS metadata size exceeded addressable memory".into())
    })?;
    let _metadata = parser.read_exact(metadata_size)?;

    let mut actions = Vec::new();
    let mut output_size = 0u64;
    while !parser.is_at_end() {
        let raw = parser.read_varint()?;
        let command = raw & 0x03;
        let length = (raw >> 2)
            .checked_add(1)
            .ok_or_else(|| RomWeaverError::Validation("BPS action length overflowed".into()))?;
        output_size = output_size
            .checked_add(length)
            .ok_or_else(|| RomWeaverError::Validation("BPS target size overflowed".into()))?;

        let action = match command {
            0 => BpsAction::SourceRead { length },
            1 => {
                let data = parser
                    .read_exact(usize::try_from(length).map_err(|_| {
                        RomWeaverError::Validation(
                            "BPS target-read length exceeded addressable memory".into(),
                        )
                    })?)?
                    .to_vec();
                BpsAction::TargetRead { data }
            }
            2 => BpsAction::SourceCopy {
                length,
                relative_offset: decode_signed_offset(parser.read_varint()?),
            },
            3 => BpsAction::TargetCopy {
                length,
                relative_offset: decode_signed_offset(parser.read_varint()?),
            },
            _ => unreachable!(),
        };
        actions.push(action);
    }

    if output_size != target_size {
        return Err(RomWeaverError::Validation(format!(
            "Output size invalid; Expected: {target_size}, Actual: {output_size}"
        )));
    }

    let footer = &bytes[footer_offset..];
    let source_checksum = read_u32_le(&footer[0..4]);
    let target_checksum = read_u32_le(&footer[4..8]);
    let patch_checksum = read_u32_le(&footer[8..12]);
    let actual_patch_checksum = crc32_bytes(&bytes[..bytes.len() - 4]);
    if actual_patch_checksum != patch_checksum {
        return Err(RomWeaverError::Validation(format!(
            "Patch checksum invalid; expected: {patch_checksum:x}, Actual: {actual_patch_checksum:x}"
        )));
    }

    Ok(ParsedBpsPatch {
        source_size,
        target_size,
        source_checksum,
        target_checksum,
        actions,
    })
}

fn apply_patch_actions(patch: &ParsedBpsPatch, source: &mut File, output: &mut File) -> Result<()> {
    let mut output_offset = 0u64;
    let mut source_relative_offset = 0i128;
    let mut target_relative_offset = 0i128;

    for action in &patch.actions {
        match action {
            BpsAction::SourceRead { length } => {
                let end = output_offset.checked_add(*length).ok_or_else(|| {
                    RomWeaverError::Validation("BPS source-read offset overflowed".into())
                })?;
                if end > patch.source_size {
                    return Err(RomWeaverError::Validation(format!(
                        "SourceRead exceeded input size at output offset {output_offset}"
                    )));
                }
                copy_source_range(source, output, output_offset, &mut output_offset, *length)?;
            }
            BpsAction::TargetRead { data } => {
                append_bytes(output, &mut output_offset, data)?;
            }
            BpsAction::SourceCopy {
                length,
                relative_offset,
            } => {
                let start = adjust_relative_offset(
                    source_relative_offset,
                    *relative_offset,
                    patch.source_size,
                    "source",
                )?;
                let end = start.checked_add(*length).ok_or_else(|| {
                    RomWeaverError::Validation("BPS source-copy length overflowed".into())
                })?;
                if end > patch.source_size {
                    return Err(RomWeaverError::Validation(format!(
                        "SourceCopy exceeded input size at source offset {start}"
                    )));
                }
                copy_source_range(source, output, start, &mut output_offset, *length)?;
                source_relative_offset = i128::from(end);
            }
            BpsAction::TargetCopy {
                length,
                relative_offset,
            } => {
                let start = adjust_relative_offset(
                    target_relative_offset,
                    *relative_offset,
                    output_offset,
                    "target",
                )?;
                if start >= output_offset {
                    return Err(RomWeaverError::Validation(format!(
                        "TargetCopy started beyond produced output at offset {start}"
                    )));
                }
                copy_target_range(output, &mut output_offset, start, *length)?;
                target_relative_offset =
                    i128::from(start.checked_add(*length).ok_or_else(|| {
                        RomWeaverError::Validation("BPS target-copy length overflowed".into())
                    })?);
            }
        }

        if output_offset > patch.target_size {
            return Err(RomWeaverError::Validation(format!(
                "Output size invalid; Expected: {}, Actual: {output_offset}",
                patch.target_size
            )));
        }
    }

    if output_offset != patch.target_size {
        return Err(RomWeaverError::Validation(format!(
            "Output size invalid; Expected: {}, Actual: {output_offset}",
            patch.target_size
        )));
    }

    Ok(())
}

fn copy_source_range(
    source: &mut File,
    output: &mut File,
    source_offset: u64,
    output_offset: &mut u64,
    length: u64,
) -> Result<()> {
    let mut buffer = [0u8; COPY_BUFFER_SIZE];
    let mut remaining = length;
    source.seek(SeekFrom::Start(source_offset))?;
    output.seek(SeekFrom::Start(*output_offset))?;

    while remaining > 0 {
        let chunk = remaining.min(buffer.len() as u64) as usize;
        source.read_exact(&mut buffer[..chunk])?;
        output.write_all(&buffer[..chunk])?;
        remaining -= chunk as u64;
        *output_offset += chunk as u64;
    }

    Ok(())
}

fn append_bytes(output: &mut File, output_offset: &mut u64, data: &[u8]) -> Result<()> {
    output.seek(SeekFrom::Start(*output_offset))?;
    output.write_all(data)?;
    *output_offset = output_offset
        .checked_add(data.len() as u64)
        .ok_or_else(|| RomWeaverError::Validation("BPS output offset overflowed".into()))?;
    Ok(())
}

fn copy_target_range(
    output: &mut File,
    output_offset: &mut u64,
    start: u64,
    length: u64,
) -> Result<()> {
    let mut buffer = [0u8; COPY_BUFFER_SIZE];
    let mut remaining = length;
    let mut read_offset = start;

    while remaining > 0 {
        if read_offset >= *output_offset {
            return Err(RomWeaverError::Validation(format!(
                "TargetCopy referenced unavailable output at offset {read_offset}"
            )));
        }

        let available = *output_offset - read_offset;
        let chunk = remaining.min(available).min(buffer.len() as u64) as usize;
        output.seek(SeekFrom::Start(read_offset))?;
        output.read_exact(&mut buffer[..chunk])?;
        output.seek(SeekFrom::Start(*output_offset))?;
        output.write_all(&buffer[..chunk])?;

        remaining -= chunk as u64;
        read_offset += chunk as u64;
        *output_offset += chunk as u64;
    }

    Ok(())
}

fn validate_input_file(
    source: &mut File,
    expected_size: u64,
    expected_checksum: u32,
) -> Result<()> {
    let actual_size = source.seek(SeekFrom::End(0))?;
    if actual_size != expected_size {
        return Err(RomWeaverError::Validation(format!(
            "Input size invalid; Expected: {expected_size}, Actual: {actual_size}"
        )));
    }

    source.seek(SeekFrom::Start(0))?;
    let actual_checksum = crc32_reader(source)?;
    if actual_checksum != expected_checksum {
        return Err(RomWeaverError::Validation(format!(
            "Input checksum invalid; expected: {expected_checksum:x}, Actual: {actual_checksum:x}"
        )));
    }

    source.seek(SeekFrom::Start(0))?;
    Ok(())
}

fn validate_output_file(
    output: &mut File,
    expected_size: u64,
    expected_checksum: u32,
) -> Result<()> {
    output.seek(SeekFrom::End(0))?;
    let actual_size = output.stream_position()?;
    if actual_size != expected_size {
        return Err(RomWeaverError::Validation(format!(
            "Output size invalid; Expected: {expected_size}, Actual: {actual_size}"
        )));
    }

    output.seek(SeekFrom::Start(0))?;
    let actual_checksum = crc32_reader(output)?;
    if actual_checksum != expected_checksum {
        return Err(RomWeaverError::Validation(format!(
            "Output checksum invalid; expected: {expected_checksum:x}, Actual: {actual_checksum:x}"
        )));
    }

    Ok(())
}

fn adjust_relative_offset(current: i128, delta: i128, limit: u64, label: &str) -> Result<u64> {
    let next = current.checked_add(delta).ok_or_else(|| {
        RomWeaverError::Validation(format!("BPS {label} relative offset overflowed"))
    })?;
    if next < 0 {
        return Err(RomWeaverError::Validation(format!(
            "BPS {label} relative offset moved before the start of the file"
        )));
    }

    let next = u64::try_from(next).map_err(|_| {
        RomWeaverError::Validation(format!("BPS {label} relative offset exceeded u64"))
    })?;
    if next >= limit {
        return Err(RomWeaverError::Validation(format!(
            "BPS {label} relative offset exceeded available data"
        )));
    }

    Ok(next)
}

fn decode_signed_offset(raw: u64) -> i128 {
    let magnitude = i128::from(raw >> 1);
    if raw & 1 != 0 { -magnitude } else { magnitude }
}

fn read_u32_le(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().expect("u32 slice"))
}

fn crc32_bytes(bytes: &[u8]) -> u32 {
    crc32fast::hash(bytes)
}

fn crc32_reader(reader: &mut impl Read) -> std::io::Result<u32> {
    let mut hasher = Hasher::new();
    let mut buffer = [0u8; COPY_BUFFER_SIZE];
    loop {
        let bytes_read = reader.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }
    Ok(hasher.finalize())
}

struct BpsParser<'a> {
    bytes: &'a [u8],
    offset: usize,
    end: usize,
}

impl<'a> BpsParser<'a> {
    fn new(bytes: &'a [u8], end: usize) -> Self {
        Self {
            bytes,
            offset: 0,
            end,
        }
    }

    fn is_at_end(&self) -> bool {
        self.offset == self.end
    }

    fn read_exact(&mut self, len: usize) -> Result<&'a [u8]> {
        let end = self
            .offset
            .checked_add(len)
            .ok_or_else(|| RomWeaverError::Validation("BPS parser offset overflowed".into()))?;
        if end > self.end {
            return Err(RomWeaverError::Validation(
                "BPS patch ended unexpectedly while reading command data".into(),
            ));
        }

        let start = self.offset;
        self.offset = end;
        Ok(&self.bytes[start..end])
    }

    fn read_varint(&mut self) -> Result<u64> {
        let mut data = 0u64;
        let mut shift = 1u64;
        loop {
            let byte = u64::from(self.read_exact(1)?[0]);
            data = data.checked_add((byte & 0x7f) * shift).ok_or_else(|| {
                RomWeaverError::Validation("BPS varint overflowed available range".into())
            })?;
            if byte & 0x80 != 0 {
                return Ok(data);
            }
            shift = shift
                .checked_shl(7)
                .ok_or_else(|| RomWeaverError::Validation("BPS varint shift overflowed".into()))?;
            data = data.checked_add(shift).ok_or_else(|| {
                RomWeaverError::Validation("BPS varint overflowed available range".into())
            })?;
        }
    }
}
