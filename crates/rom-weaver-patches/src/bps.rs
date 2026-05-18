use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::Path,
};

use crc32fast::Hasher;
use rom_weaver_checksum::checksum_file_values;
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchChecksumValidation, PatchCreateRequest, PatchHandler, ProbeConfidence,
    Result, RomWeaverError, ThreadCapability,
};

const BPS_MAGIC: &[u8; 4] = b"BPS1";
const BPS_FOOTER_SIZE: usize = 12;
const COPY_BUFFER_SIZE: usize = 32 * 1024;
const CREATE_STREAM_BUFFER_SIZE: usize = 32 * 1024;
const RESYNC_LOOKAHEAD: usize = 4 * 1024;
const RESYNC_MATCH_LIMIT: usize = 64;
const MIN_RESYNC_MATCH: usize = 16;
const TARGET_READ_FLUSH_SIZE: usize = 16 * 1024;

pub struct BpsPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl BpsPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
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
                "parsed {} patch with {} record(s); source crc32 {:08x}; target crc32 {:08x}",
                self.descriptor.name,
                patch.actions.len(),
                patch.source_checksum,
                patch.target_checksum
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
        let validate_checksums =
            context.patch_checksum_validation() == PatchChecksumValidation::Strict;
        let patch = parse_bps_file_with_checksum_validation(patch_path, validate_checksums)?;
        let mut source = File::open(&request.input)?;
        validate_input_file(
            &request.input,
            &mut source,
            patch.source_size,
            patch.source_checksum,
            validate_checksums,
            context,
        )?;

        let mut output = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(&request.output)?;
        apply_patch_actions(&patch, &mut source, &mut output)?;
        validate_output_file(
            &request.output,
            &mut output,
            patch.target_size,
            patch.target_checksum,
            validate_checksums,
            context,
        )?;

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
                "applied {} patch with {} record(s){}",
                self.descriptor.name,
                patch.actions.len(),
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
        let original_len = fs::metadata(&request.original)?.len();
        let modified_len = fs::metadata(&request.modified)?.len();
        let source_checksum = crc32_path_cached(&request.original, context)?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let output_file = File::create(&request.output)?;
        let mut output = BufWriter::new(output_file);
        let created = create_bps_patch_streaming(
            &request.original,
            original_len,
            source_checksum,
            &request.modified,
            modified_len,
            &mut output,
            context,
        )?;
        output.flush()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created {} patch with {} record(s)",
                self.descriptor.name, created.action_count
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

#[derive(Debug, Default)]
struct CreatedBpsPatch {
    action_count: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResyncKind {
    Insert,
    Delete,
}

#[derive(Clone, Copy, Debug)]
struct ResyncCandidate {
    kind: ResyncKind,
    skip: usize,
    match_len: usize,
}

fn parse_bps_file(path: &Path) -> Result<ParsedBpsPatch> {
    parse_bps_file_with_checksum_validation(path, true)
}

fn parse_bps_file_with_checksum_validation(
    path: &Path,
    validate_patch_checksum: bool,
) -> Result<ParsedBpsPatch> {
    let bytes = fs::read(path)?;
    parse_bps_bytes_with_checksum_validation(&bytes, validate_patch_checksum)
}

#[cfg(test)]
fn parse_bps_bytes(bytes: &[u8]) -> Result<ParsedBpsPatch> {
    parse_bps_bytes_with_checksum_validation(bytes, true)
}

fn parse_bps_bytes_with_checksum_validation(
    bytes: &[u8],
    validate_patch_checksum: bool,
) -> Result<ParsedBpsPatch> {
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
    if validate_patch_checksum {
        let actual_patch_checksum = crc32_bytes(&bytes[..bytes.len() - 4]);
        if actual_patch_checksum != patch_checksum {
            return Err(RomWeaverError::Validation(format!(
                "Patch checksum invalid; expected: {patch_checksum:x}, Actual: {actual_patch_checksum:x}"
            )));
        }
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

fn create_bps_patch_streaming(
    original_path: &Path,
    original_len: u64,
    source_checksum: u32,
    modified_path: &Path,
    modified_len: u64,
    output: &mut impl Write,
    context: &OperationContext,
) -> Result<CreatedBpsPatch> {
    let mut original = BufferedByteStream::new(BufReader::new(File::open(original_path)?));
    let mut modified = BufferedByteStream::new(BufReader::new(File::open(modified_path)?));
    let mut target_checksum = Hasher::new();
    let mut target_read = Vec::with_capacity(TARGET_READ_FLUSH_SIZE);
    let mut created = CreatedBpsPatch::default();
    let mut writer = BpsCreateWriter::new(output);
    let mut source_relative_offset = 0i128;

    writer.write_bytes(BPS_MAGIC)?;
    writer.write_varint(original_len)?;
    writer.write_varint(modified_len)?;
    writer.write_varint(0)?;

    while modified.has_byte()? {
        context.cancel().check()?;

        if original.position() == modified.position()
            && current_bytes_equal(&mut original, &mut modified)?
        {
            flush_target_read(&mut writer, &mut target_read, &mut created)?;
            let length = consume_shared_run(&mut original, &mut modified, &mut target_checksum)?;
            if length > 0 {
                writer.write_source_read(length)?;
                created.action_count += 1;
            }
            continue;
        }

        if current_bytes_equal(&mut original, &mut modified)? {
            flush_target_read(&mut writer, &mut target_read, &mut created)?;
            let start = original.position();
            let length = consume_shared_run(&mut original, &mut modified, &mut target_checksum)?;
            if length > 0 {
                writer.write_source_copy(length, start, &mut source_relative_offset)?;
                created.action_count += 1;
            }
            continue;
        }

        if !original.has_byte()? {
            drain_remaining_target(
                &mut modified,
                &mut target_read,
                &mut target_checksum,
                &mut writer,
                &mut created,
            )?;
            break;
        }

        match find_resync(&mut original, &mut modified)? {
            Some(ResyncCandidate {
                kind: ResyncKind::Delete,
                skip,
                ..
            }) => {
                original.advance(skip)?;
            }
            Some(ResyncCandidate {
                kind: ResyncKind::Insert,
                skip,
                ..
            }) => {
                append_target_read_bytes(
                    &mut modified,
                    skip,
                    &mut target_read,
                    &mut target_checksum,
                    &mut writer,
                    &mut created,
                )?;
            }
            None => {
                append_target_read_bytes(
                    &mut modified,
                    1,
                    &mut target_read,
                    &mut target_checksum,
                    &mut writer,
                    &mut created,
                )?;
            }
        }
    }

    flush_target_read(&mut writer, &mut target_read, &mut created)?;
    writer.finish(source_checksum, target_checksum.finalize())?;
    Ok(created)
}

fn current_bytes_equal(
    original: &mut BufferedByteStream<impl Read>,
    modified: &mut BufferedByteStream<impl Read>,
) -> Result<bool> {
    match (original.peek(0)?, modified.peek(0)?) {
        (Some(left), Some(right)) => Ok(left == right),
        _ => Ok(false),
    }
}

fn consume_shared_run(
    original: &mut BufferedByteStream<impl Read>,
    modified: &mut BufferedByteStream<impl Read>,
    target_checksum: &mut Hasher,
) -> Result<u64> {
    let mut consumed = 0u64;

    loop {
        original.fill_at_least(1)?;
        modified.fill_at_least(1)?;

        let original_slice = original.available_slice();
        let modified_slice = modified.available_slice();
        if original_slice.is_empty() || modified_slice.is_empty() {
            break;
        }

        let limit = original_slice.len().min(modified_slice.len());
        let mut prefix = 0usize;
        while prefix < limit && original_slice[prefix] == modified_slice[prefix] {
            prefix += 1;
        }

        if prefix == 0 {
            break;
        }

        target_checksum.update(&modified_slice[..prefix]);
        original.advance(prefix)?;
        modified.advance(prefix)?;
        consumed = consumed
            .checked_add(prefix as u64)
            .ok_or_else(|| RomWeaverError::Validation("BPS create run overflowed".into()))?;

        if prefix < limit {
            break;
        }
    }

    Ok(consumed)
}

fn find_resync(
    original: &mut BufferedByteStream<impl Read>,
    modified: &mut BufferedByteStream<impl Read>,
) -> Result<Option<ResyncCandidate>> {
    let mut best = None;

    for skip in 1..=RESYNC_LOOKAHEAD {
        if let Some(match_len) = resync_match_len(original, skip, modified, 0)? {
            best = choose_resync(
                best,
                ResyncCandidate {
                    kind: ResyncKind::Delete,
                    skip,
                    match_len,
                },
            );
        }

        if let Some(match_len) = resync_match_len(original, 0, modified, skip)? {
            best = choose_resync(
                best,
                ResyncCandidate {
                    kind: ResyncKind::Insert,
                    skip,
                    match_len,
                },
            );
        }
    }

    Ok(best)
}

fn choose_resync(
    current: Option<ResyncCandidate>,
    candidate: ResyncCandidate,
) -> Option<ResyncCandidate> {
    match current {
        None => Some(candidate),
        Some(existing)
            if candidate.skip < existing.skip
                || (candidate.skip == existing.skip
                    && candidate.match_len > existing.match_len)
                || (candidate.skip == existing.skip
                    && candidate.match_len == existing.match_len
                    && candidate.kind == ResyncKind::Delete
                    && existing.kind == ResyncKind::Insert) =>
        {
            Some(candidate)
        }
        Some(existing) => Some(existing),
    }
}

fn resync_match_len(
    original: &mut BufferedByteStream<impl Read>,
    original_skip: usize,
    modified: &mut BufferedByteStream<impl Read>,
    modified_skip: usize,
) -> Result<Option<usize>> {
    let matched = common_prefix_len(
        original,
        original_skip,
        modified,
        modified_skip,
        RESYNC_MATCH_LIMIT,
    )?;
    if matched >= MIN_RESYNC_MATCH {
        return Ok(Some(matched));
    }
    if matched == 0 {
        return Ok(None);
    }

    let next_original = original.peek(original_skip + matched)?;
    let next_modified = modified.peek(modified_skip + matched)?;
    if next_original.is_none() || next_modified.is_none() {
        Ok(Some(matched))
    } else {
        Ok(None)
    }
}

fn common_prefix_len(
    original: &mut BufferedByteStream<impl Read>,
    original_skip: usize,
    modified: &mut BufferedByteStream<impl Read>,
    modified_skip: usize,
    limit: usize,
) -> Result<usize> {
    let mut matched = 0usize;
    while matched < limit {
        match (
            original.peek(original_skip + matched)?,
            modified.peek(modified_skip + matched)?,
        ) {
            (Some(left), Some(right)) if left == right => matched += 1,
            _ => break,
        }
    }
    Ok(matched)
}

fn append_target_read_bytes(
    modified: &mut BufferedByteStream<impl Read>,
    len: usize,
    target_read: &mut Vec<u8>,
    target_checksum: &mut Hasher,
    writer: &mut BpsCreateWriter<'_, impl Write>,
    created: &mut CreatedBpsPatch,
) -> Result<()> {
    let mut remaining = len;
    while remaining > 0 {
        modified.fill_at_least(1)?;
        let available = modified.available_slice();
        if available.is_empty() {
            return Err(RomWeaverError::Validation(
                "Modified file ended unexpectedly while building BPS patch".into(),
            ));
        }

        let free = TARGET_READ_FLUSH_SIZE.saturating_sub(target_read.len());
        let chunk = remaining.min(available.len()).min(free.max(1));
        target_checksum.update(&available[..chunk]);
        target_read.extend_from_slice(&available[..chunk]);
        modified.advance(chunk)?;
        remaining -= chunk;

        if target_read.len() >= TARGET_READ_FLUSH_SIZE {
            flush_target_read(writer, target_read, created)?;
        }
    }
    Ok(())
}

fn drain_remaining_target(
    modified: &mut BufferedByteStream<impl Read>,
    target_read: &mut Vec<u8>,
    target_checksum: &mut Hasher,
    writer: &mut BpsCreateWriter<'_, impl Write>,
    created: &mut CreatedBpsPatch,
) -> Result<()> {
    while modified.has_byte()? {
        let available = modified.available_slice();
        if available.is_empty() {
            break;
        }

        let free = TARGET_READ_FLUSH_SIZE.saturating_sub(target_read.len());
        let chunk = available.len().min(free.max(1));
        target_checksum.update(&available[..chunk]);
        target_read.extend_from_slice(&available[..chunk]);
        modified.advance(chunk)?;

        if target_read.len() >= TARGET_READ_FLUSH_SIZE {
            flush_target_read(writer, target_read, created)?;
        }
    }
    Ok(())
}

fn flush_target_read(
    writer: &mut BpsCreateWriter<'_, impl Write>,
    target_read: &mut Vec<u8>,
    created: &mut CreatedBpsPatch,
) -> Result<()> {
    if target_read.is_empty() {
        return Ok(());
    }

    writer.write_target_read(target_read)?;
    created.action_count += 1;
    target_read.clear();
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
    source_path: &Path,
    source: &mut File,
    expected_size: u64,
    expected_checksum: u32,
    validate_checksum: bool,
    context: &OperationContext,
) -> Result<()> {
    let actual_size = source.seek(SeekFrom::End(0))?;
    if actual_size != expected_size {
        return Err(RomWeaverError::Validation(format!(
            "Input size invalid; Expected: {expected_size}, Actual: {actual_size}"
        )));
    }

    if !validate_checksum {
        source.seek(SeekFrom::Start(0))?;
        return Ok(());
    }

    let actual_checksum = crc32_path_cached(source_path, context)?;
    if actual_checksum != expected_checksum {
        return Err(RomWeaverError::Validation(format!(
            "Input checksum invalid; expected: {expected_checksum:x}, Actual: {actual_checksum:x}"
        )));
    }

    source.seek(SeekFrom::Start(0))?;
    Ok(())
}

fn validate_output_file(
    output_path: &Path,
    output: &mut File,
    expected_size: u64,
    expected_checksum: u32,
    validate_checksum: bool,
    context: &OperationContext,
) -> Result<()> {
    output.seek(SeekFrom::End(0))?;
    let actual_size = output.stream_position()?;
    if actual_size != expected_size {
        return Err(RomWeaverError::Validation(format!(
            "Output size invalid; Expected: {expected_size}, Actual: {actual_size}"
        )));
    }

    if !validate_checksum {
        return Ok(());
    }

    let actual_checksum = crc32_path_cached(output_path, context)?;
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

fn encode_signed_offset(delta: i128) -> Result<u64> {
    let magnitude = if delta < 0 {
        delta.checked_neg().ok_or_else(|| {
            RomWeaverError::Validation("BPS relative offset magnitude overflowed".into())
        })?
    } else {
        delta
    };

    let magnitude = u64::try_from(magnitude)
        .map_err(|_| RomWeaverError::Validation("BPS relative offset exceeded u64".into()))?;
    let shifted = magnitude.checked_shl(1).ok_or_else(|| {
        RomWeaverError::Validation("BPS relative offset exceeded encodable range".into())
    })?;
    Ok(shifted | u64::from(delta < 0))
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

fn crc32_path_cached(path: &Path, context: &OperationContext) -> Result<u32> {
    let results = checksum_file_values(path, &["crc32"], context)?;
    let Some(value) = results.get("crc32") else {
        return Err(RomWeaverError::Validation(
            "native checksum engine did not return crc32 result".into(),
        ));
    };
    u32::from_str_radix(value, 16).map_err(|error| {
        RomWeaverError::Validation(format!(
            "native checksum engine returned invalid crc32: {error}"
        ))
    })
}

#[cfg(test)]
fn push_varint(bytes: &mut Vec<u8>, mut data: u64) {
    loop {
        let value = (data & 0x7f) as u8;
        data >>= 7;
        if data == 0 {
            bytes.push(0x80 | value);
            break;
        }
        bytes.push(value);
        data -= 1;
    }
}

struct BpsCreateWriter<'a, W> {
    output: &'a mut W,
    patch_hasher: Hasher,
}

impl<'a, W: Write> BpsCreateWriter<'a, W> {
    fn new(output: &'a mut W) -> Self {
        Self {
            output,
            patch_hasher: Hasher::new(),
        }
    }

    fn write_bytes(&mut self, bytes: &[u8]) -> Result<()> {
        self.output.write_all(bytes)?;
        self.patch_hasher.update(bytes);
        Ok(())
    }

    fn write_varint(&mut self, mut data: u64) -> Result<()> {
        let mut bytes = [0u8; 10];
        let mut len = 0usize;

        loop {
            let value = (data & 0x7f) as u8;
            data >>= 7;
            if data == 0 {
                bytes[len] = 0x80 | value;
                len += 1;
                break;
            }
            bytes[len] = value;
            len += 1;
            data -= 1;
        }

        self.write_bytes(&bytes[..len])
    }

    fn write_source_read(&mut self, length: u64) -> Result<()> {
        self.write_varint(encode_action_header(length, 0)?)
    }

    fn write_target_read(&mut self, data: &[u8]) -> Result<()> {
        let len = u64::try_from(data.len()).map_err(|_| {
            RomWeaverError::Validation("BPS target-read data exceeded u64 length".into())
        })?;
        self.write_varint(encode_action_header(len, 1)?)?;
        self.write_bytes(data)
    }

    fn write_source_copy(
        &mut self,
        length: u64,
        start: u64,
        source_relative_offset: &mut i128,
    ) -> Result<()> {
        self.write_varint(encode_action_header(length, 2)?)?;
        let delta = i128::from(start)
            .checked_sub(*source_relative_offset)
            .ok_or_else(|| RomWeaverError::Validation("BPS source delta overflowed".into()))?;
        self.write_varint(encode_signed_offset(delta)?)?;
        let end = start
            .checked_add(length)
            .ok_or_else(|| RomWeaverError::Validation("BPS source-copy end overflowed".into()))?;
        *source_relative_offset = i128::from(end);
        Ok(())
    }

    fn finish(&mut self, source_checksum: u32, target_checksum: u32) -> Result<()> {
        self.write_bytes(&source_checksum.to_le_bytes())?;
        self.write_bytes(&target_checksum.to_le_bytes())?;
        let patch_checksum = std::mem::replace(&mut self.patch_hasher, Hasher::new()).finalize();
        self.output.write_all(&patch_checksum.to_le_bytes())?;
        Ok(())
    }
}

fn encode_action_header(length: u64, command: u64) -> Result<u64> {
    if length == 0 {
        return Err(RomWeaverError::Validation(
            "BPS cannot encode a zero-length action".into(),
        ));
    }

    let value = length
        .checked_sub(1)
        .ok_or_else(|| RomWeaverError::Validation("BPS action length underflowed".into()))?;
    let shifted = value.checked_shl(2).ok_or_else(|| {
        RomWeaverError::Validation("BPS action header exceeded encodable range".into())
    })?;
    shifted
        .checked_add(command)
        .ok_or_else(|| RomWeaverError::Validation("BPS action header overflowed".into()))
}

struct BufferedByteStream<R> {
    reader: R,
    buffer: Vec<u8>,
    start: usize,
    end: usize,
    eof: bool,
    position: u64,
}

impl<R: Read> BufferedByteStream<R> {
    fn new(reader: R) -> Self {
        Self {
            reader,
            buffer: vec![0u8; CREATE_STREAM_BUFFER_SIZE],
            start: 0,
            end: 0,
            eof: false,
            position: 0,
        }
    }

    fn position(&self) -> u64 {
        self.position
    }

    fn available_len(&self) -> usize {
        self.end - self.start
    }

    fn available_slice(&self) -> &[u8] {
        &self.buffer[self.start..self.end]
    }

    fn has_byte(&mut self) -> io::Result<bool> {
        self.fill_at_least(1)?;
        Ok(self.available_len() > 0)
    }

    fn peek(&mut self, offset: usize) -> io::Result<Option<u8>> {
        self.fill_at_least(offset.saturating_add(1))?;
        if offset < self.available_len() {
            Ok(Some(self.buffer[self.start + offset]))
        } else {
            Ok(None)
        }
    }

    fn advance(&mut self, count: usize) -> io::Result<()> {
        let mut remaining = count;
        while remaining > 0 {
            self.fill_at_least(1)?;
            let available = self.available_len();
            if available == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "stream ended unexpectedly while advancing",
                ));
            }

            let chunk = remaining.min(available);
            self.start += chunk;
            self.position += chunk as u64;
            remaining -= chunk;

            if self.start == self.end {
                self.start = 0;
                self.end = 0;
            }
        }

        Ok(())
    }

    fn fill_at_least(&mut self, min_bytes: usize) -> io::Result<()> {
        if min_bytes > self.buffer.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "requested BPS lookahead exceeded the streaming buffer",
            ));
        }

        while self.available_len() < min_bytes && !self.eof {
            if self.start > 0 {
                let len = self.available_len();
                self.buffer.copy_within(self.start..self.end, 0);
                self.start = 0;
                self.end = len;
            }

            let bytes_read = self.reader.read(&mut self.buffer[self.end..])?;
            if bytes_read == 0 {
                self.eof = true;
                break;
            }
            self.end += bytes_read;
        }

        Ok(())
    }
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

#[cfg(test)]
mod tests {
    use std::fs;

    use rom_weaver_core::{
        PatchApplyRequest, PatchChecksumValidation, PatchCreateRequest, PatchHandler,
    };

    use super::{
        BPS_MAGIC, BpsAction, BpsPatchHandler, crc32_bytes, encode_signed_offset, parse_bps_bytes,
        push_varint,
    };
    use crate::{
        BPS,
        test_support::{TestDir, test_context_with_threads},
    };

    #[derive(Debug)]
    enum TestAction {
        SourceRead(u64),
        TargetRead(Vec<u8>),
        SourceCopy { length: u64, relative_offset: i128 },
        TargetCopy { length: u64, relative_offset: i128 },
    }

    #[test]
    fn parse_and_apply_round_trip_for_bps() {
        let temp = TestDir::new();
        let input_path = temp.child("input.bin");
        let patch_path = temp.child("update.bps");
        let output_path = temp.child("output.bin");
        let source = b"abcabcabcabc";
        let target = b"abcabcZZabcabc";
        fs::write(&input_path, source).expect("fixture");
        fs::write(
            &patch_path,
            build_bps_patch(
                source,
                target,
                vec![
                    TestAction::SourceRead(6),
                    TestAction::TargetRead(b"ZZ".to_vec()),
                    TestAction::SourceCopy {
                        length: 6,
                        relative_offset: 6,
                    },
                ],
            ),
        )
        .expect("fixture");

        let handler = BpsPatchHandler::new(&BPS);
        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("report");

        let execution = report.thread_execution.expect("thread execution");
        assert_eq!(execution.requested_threads, 4);
        assert_eq!(execution.effective_threads, 1);
        assert!(!execution.used_parallelism);
        assert_eq!(fs::read(output_path).expect("output"), target);
    }

    #[test]
    fn apply_supports_overlapping_target_copy() {
        let temp = TestDir::new();
        let input_path = temp.child("input.bin");
        let patch_path = temp.child("update.bps");
        let output_path = temp.child("output.bin");
        fs::write(&input_path, []).expect("fixture");
        fs::write(
            &patch_path,
            build_bps_patch(
                b"",
                b"AAAAAA",
                vec![
                    TestAction::TargetRead(vec![b'A']),
                    TestAction::TargetCopy {
                        length: 5,
                        relative_offset: 0,
                    },
                ],
            ),
        )
        .expect("fixture");

        let handler = BpsPatchHandler::new(&BPS);
        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("apply");

        assert_eq!(fs::read(output_path).expect("output"), b"AAAAAA");
    }

    #[test]
    fn apply_rejects_multiple_patch_files() {
        let temp = TestDir::new();
        let input_path = temp.child("input.bin");
        let patch_a = temp.child("a.bps");
        let patch_b = temp.child("b.bps");
        let output_path = temp.child("output.bin");
        fs::write(&input_path, b"input").expect("fixture");
        fs::write(&patch_a, []).expect("fixture");
        fs::write(&patch_b, []).expect("fixture");

        let handler = BpsPatchHandler::new(&BPS);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_a, patch_b],
                    output: output_path,
                },
                &test_context_with_threads(&temp, 2),
            )
            .expect_err("multiple patch files should fail");

        assert!(error.to_string().contains("expects exactly one patch file"));
    }

    #[test]
    fn apply_fails_when_input_checksum_does_not_match() {
        let temp = TestDir::new();
        let input_path = temp.child("input.bin");
        let patch_path = temp.child("update.bps");
        let output_path = temp.child("output.bin");
        fs::write(&input_path, b"wrong input").expect("fixture");
        fs::write(
            &patch_path,
            build_bps_patch(
                b"expected input",
                b"expected output",
                vec![TestAction::TargetRead(b"expected output".to_vec())],
            ),
        )
        .expect("fixture");

        let handler = BpsPatchHandler::new(&BPS);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect_err("checksum mismatch should fail");

        assert!(
            error.to_string().contains("Input size invalid")
                || error.to_string().contains("Input checksum invalid")
        );
    }

    #[test]
    fn apply_can_ignore_patch_checksum_mismatch() {
        let temp = TestDir::new();
        let input_path = temp.child("input.bin");
        let patch_path = temp.child("update.bps");
        let output_path = temp.child("output.bin");
        let source = b"hello old world";
        let target = b"hello new world";
        fs::write(&input_path, source).expect("fixture");

        let mut patch = build_bps_patch(
            source,
            target,
            vec![TestAction::TargetRead(target.to_vec())],
        );
        let footer_index = patch.len().checked_sub(1).expect("patch footer");
        patch[footer_index] ^= 0x01;
        fs::write(&patch_path, patch).expect("fixture");

        let handler = BpsPatchHandler::new(&BPS);

        let strict_error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path.clone(),
                    patches: vec![patch_path.clone()],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect_err("strict patch checksum validation should fail");
        assert!(strict_error.to_string().contains("Patch checksum invalid"));

        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 1)
                    .with_patch_checksum_validation(PatchChecksumValidation::Ignore),
            )
            .expect("ignore checksum validation should apply patch");

        assert_eq!(fs::read(output_path).expect("output"), target);
    }

    #[test]
    fn create_round_trips_for_small_patch() {
        let temp = TestDir::new();
        let original_path = temp.child("original.bin");
        let modified_path = temp.child("modified.bin");
        let patch_path = temp.child("update.bps");
        let output_path = temp.child("output.bin");
        fs::write(&original_path, b"hello old world").expect("fixture");
        fs::write(&modified_path, b"hello new world").expect("fixture");

        let handler = BpsPatchHandler::new(&BPS);
        let report = handler
            .create(
                &PatchCreateRequest {
                    original: original_path.clone(),
                    modified: modified_path.clone(),
                    output: patch_path.clone(),
                    format: "BPS".into(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("create");

        let execution = report.thread_execution.expect("thread execution");
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 1);
        assert!(!execution.used_parallelism);

        let patch = parse_bps_bytes(&fs::read(&patch_path).expect("patch")).expect("parse");
        assert!(!patch.actions.is_empty());

        handler
            .apply(
                &PatchApplyRequest {
                    input: original_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("apply");

        assert_eq!(
            fs::read(output_path).expect("output"),
            fs::read(modified_path).expect("modified")
        );
    }

    #[test]
    fn create_uses_source_copy_to_resync_after_insertion() {
        let temp = TestDir::new();
        let original_path = temp.child("original.bin");
        let modified_path = temp.child("modified.bin");
        let patch_path = temp.child("update.bps");
        let output_path = temp.child("output.bin");
        let tail = vec![b'A'; 8192];
        let mut modified = b"prefix-".to_vec();
        modified.extend_from_slice(b"INSERT-");
        modified.extend_from_slice(&tail);
        let mut original = b"prefix-".to_vec();
        original.extend_from_slice(&tail);
        fs::write(&original_path, &original).expect("fixture");
        fs::write(&modified_path, &modified).expect("fixture");

        let handler = BpsPatchHandler::new(&BPS);
        handler
            .create(
                &PatchCreateRequest {
                    original: original_path.clone(),
                    modified: modified_path.clone(),
                    output: patch_path.clone(),
                    format: "BPS".into(),
                },
                &test_context_with_threads(&temp, 2),
            )
            .expect("create");

        let patch = parse_bps_bytes(&fs::read(&patch_path).expect("patch")).expect("parse");
        assert!(
            patch
                .actions
                .iter()
                .any(|action| matches!(action, BpsAction::SourceCopy { .. }))
        );

        handler
            .apply(
                &PatchApplyRequest {
                    input: original_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 2),
            )
            .expect("apply");

        assert_eq!(fs::read(output_path).expect("output"), modified);
    }

    #[test]
    fn create_uses_source_copy_to_resync_after_deletion() {
        let temp = TestDir::new();
        let original_path = temp.child("original.bin");
        let modified_path = temp.child("modified.bin");
        let patch_path = temp.child("update.bps");
        let output_path = temp.child("output.bin");
        let head = vec![b'B'; 4096];
        let tail = vec![b'C'; 4096];
        let mut original = head.clone();
        original.extend_from_slice(b"REMOVE-ME");
        original.extend_from_slice(&tail);
        let mut modified = head;
        modified.extend_from_slice(&tail);
        fs::write(&original_path, &original).expect("fixture");
        fs::write(&modified_path, &modified).expect("fixture");

        let handler = BpsPatchHandler::new(&BPS);
        handler
            .create(
                &PatchCreateRequest {
                    original: original_path.clone(),
                    modified: modified_path.clone(),
                    output: patch_path.clone(),
                    format: "BPS".into(),
                },
                &test_context_with_threads(&temp, 2),
            )
            .expect("create");

        let patch = parse_bps_bytes(&fs::read(&patch_path).expect("patch")).expect("parse");
        assert!(
            patch
                .actions
                .iter()
                .any(|action| matches!(action, BpsAction::SourceCopy { .. }))
        );

        handler
            .apply(
                &PatchApplyRequest {
                    input: original_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 2),
            )
            .expect("apply");

        assert_eq!(fs::read(output_path).expect("output"), modified);
    }

    fn build_bps_patch(source: &[u8], target: &[u8], actions: Vec<TestAction>) -> Vec<u8> {
        let mut bytes = BPS_MAGIC.to_vec();
        push_varint(&mut bytes, source.len() as u64);
        push_varint(&mut bytes, target.len() as u64);
        push_varint(&mut bytes, 0);

        for action in actions {
            match action {
                TestAction::SourceRead(length) => {
                    push_varint(&mut bytes, ((length - 1) << 2) & !0x03);
                }
                TestAction::TargetRead(data) => {
                    push_varint(&mut bytes, (((data.len() as u64) - 1) << 2) | 1);
                    bytes.extend_from_slice(&data);
                }
                TestAction::SourceCopy {
                    length,
                    relative_offset,
                } => {
                    push_varint(&mut bytes, ((length - 1) << 2) | 2);
                    push_varint(
                        &mut bytes,
                        encode_signed_offset(relative_offset).expect("offset"),
                    );
                }
                TestAction::TargetCopy {
                    length,
                    relative_offset,
                } => {
                    push_varint(&mut bytes, ((length - 1) << 2) | 3);
                    push_varint(
                        &mut bytes,
                        encode_signed_offset(relative_offset).expect("offset"),
                    );
                }
            }
        }

        bytes.extend_from_slice(&crc32_bytes(source).to_le_bytes());
        bytes.extend_from_slice(&crc32_bytes(target).to_le_bytes());
        let patch_checksum = crc32_bytes(&bytes);
        bytes.extend_from_slice(&patch_checksum.to_le_bytes());
        bytes
    }
}
