/* jscpd:ignore-start */
use std::{
    cmp::min,
    fs::{self, File},
    io::{BufReader, BufWriter, ErrorKind, Read, Seek, SeekFrom, Write},
    path::Path,
};

use tracing::info;

use rayon::prelude::*;
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchCreateRequest, PatchHandler, PatchValidateRequest, ProbeConfidence,
    Result, RomWeaverError, SharedThreadPool, ThreadCapability,
};

use crate::shared::threading::{parallel_chunked_capability, parallel_per_record_capability};

const GDIFF_MAGIC: [u8; 4] = [0xD1, 0xFF, 0xD1, 0xFF];
const GDIFF_VERSION: u8 = 4;
const GDIFF_IO_BUFFER_SIZE: usize = 64 * 1024;
const GDIFF_INLINE_DATA_MAX: usize = 246;
const CREATE_COMMAND_CHUNK_BYTES: usize = u16::MAX as usize;

pub struct GdiffPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl GdiffPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl PatchHandler for GdiffPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let mut scratch = vec![0u8; GDIFF_IO_BUFFER_SIZE];
        let summary = parse_gdiff_patch(patch_path, |command, reader| match command {
            GdiffCommand::Data { len } => consume_data(reader, len, &mut scratch),
            GdiffCommand::Copy { .. } => Ok(()),
        })?;

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "parse",
            format!(
                "parsed {} patch with {} command(s): {} copy / {} data; output {} byte(s)",
                self.descriptor.name,
                summary.command_count,
                summary.copy_commands,
                summary.data_commands,
                summary.output_bytes
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
        let source_len = fs::metadata(&request.input)?.len();
        let (summary, commands) = parse_gdiff_apply_plan(patch_path)?;
        let thread_capability = parallel_per_record_capability(commands.len());
        let planned_execution = context.plan_threads(thread_capability.clone());

        let execution = if planned_execution.used_parallelism
            && !crate::patches_reads_source_on_main_thread()
        {
            let tasks = build_gdiff_apply_tasks(&commands);
            let (execution, pool) = context.build_pool(thread_capability)?;
            let prepared = pool.install(|| {
                tasks
                    .par_iter()
                    .map(|task| {
                        prepare_gdiff_apply_task(task, patch_path, &request.input, source_len)
                    })
                    .collect::<Result<Vec<_>>>()
            })?;
            apply_gdiff_prepared_chunks(&prepared, &request.output, context)?;
            execution
        } else {
            apply_gdiff_plan_sequential(
                &commands,
                patch_path,
                &request.input,
                &request.output,
                source_len,
            )?;
            planned_execution
        };

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "apply",
            format!(
                "applied {} patch with {} command(s): {} copy / {} data; output {} byte(s)",
                self.descriptor.name,
                summary.command_count,
                summary.copy_commands,
                summary.data_commands,
                summary.output_bytes
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn validate(
        &self,
        request: &PatchValidateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let patch_path = crate::require_single_patch_file(&request.patches, self.descriptor.name)?;
        let source_len = fs::metadata(&request.input)?.len();
        let (summary, commands) = parse_gdiff_apply_plan(patch_path)?;
        for command in &commands {
            context.cancel().check()?;
            if let GdiffApplyCommandKind::Copy { source_offset, len } = command.kind {
                ensure_copy_range(source_len, source_offset, len)?;
            }
        }

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "validate",
            format!(
                "validated {} patch source with {} command(s): {} copy / {} data; output would be {} byte(s)",
                self.descriptor.name,
                summary.command_count,
                summary.copy_commands,
                summary.data_commands,
                summary.output_bytes
            ),
            Some(100.0),
            Some(context.plan_threads(ThreadCapability::single_threaded())),
        ))
    }

    fn create(
        &self,
        request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let _ = fs::metadata(&request.original)?;
        let modified_len = fs::metadata(&request.modified)?.len();
        let (execution, pool) = context.build_pool(parallel_chunked_capability(
            modified_len,
            CREATE_COMMAND_CHUNK_BYTES as u64,
        ))?;
        let mut output = crate::create_buffered_output(&request.output)?;
        let (command_count, output_bytes) = create_gdiff_patch(
            &request.modified,
            &pool,
            execution.used_parallelism,
            &mut output,
        )?;
        output.flush()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created {} patch with {} data command(s); output {} byte(s)",
                self.descriptor.name, command_count, output_bytes
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> PatchCapabilities {
        crate::threaded_create_capabilities()
    }
}

#[derive(Clone, Copy)]
enum GdiffCommand {
    Data { len: u64 },
    Copy { offset: u64, len: u64 },
}

#[derive(Clone, Copy)]
enum GdiffApplyCommandKind {
    Data { patch_data_offset: u64, len: u64 },
    Copy { source_offset: u64, len: u64 },
}

#[derive(Clone, Copy)]
struct GdiffApplyCommand {
    output_offset: u64,
    kind: GdiffApplyCommandKind,
}

#[derive(Clone)]
struct GdiffApplyTask {
    command: GdiffApplyCommand,
}

struct GdiffPreparedChunk {
    command: GdiffApplyCommand,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct GdiffSummary {
    command_count: usize,
    data_commands: usize,
    copy_commands: usize,
    output_bytes: u64,
}

fn parse_gdiff_patch<F>(patch_path: &Path, mut on_command: F) -> Result<GdiffSummary>
where
    F: FnMut(GdiffCommand, &mut BufReader<File>) -> Result<()>,
{
    let file = File::open(patch_path)?;
    let mut reader = BufReader::new(file);
    read_gdiff_header(&mut reader)?;

    let mut summary = GdiffSummary::default();
    loop {
        let opcode = read_u8(&mut reader, "command opcode")?;
        if opcode == 0 {
            break;
        }

        summary.command_count = checked_add_usize(summary.command_count, 1, "command count")?;
        let command = read_gdiff_command(&mut reader, opcode)?;
        match command {
            GdiffCommand::Data { len } => {
                summary.data_commands =
                    checked_add_usize(summary.data_commands, 1, "data command count")?;
                summary.output_bytes = checked_add_u64(summary.output_bytes, len, "output length")?;
            }
            GdiffCommand::Copy { len, .. } => {
                summary.copy_commands =
                    checked_add_usize(summary.copy_commands, 1, "copy command count")?;
                summary.output_bytes = checked_add_u64(summary.output_bytes, len, "output length")?;
            }
        }

        on_command(command, &mut reader)?;
    }

    Ok(summary)
}

fn parse_gdiff_apply_plan(patch_path: &Path) -> Result<(GdiffSummary, Vec<GdiffApplyCommand>)> {
    let file = File::open(patch_path)?;
    let mut reader = BufReader::new(file);
    read_gdiff_header(&mut reader)?;

    let mut summary = GdiffSummary::default();
    let mut commands = Vec::new();
    let mut scratch = vec![0u8; GDIFF_IO_BUFFER_SIZE];
    let mut output_offset = 0u64;

    loop {
        let opcode = read_u8(&mut reader, "command opcode")?;
        if opcode == 0 {
            break;
        }

        summary.command_count = checked_add_usize(summary.command_count, 1, "command count")?;
        let command = read_gdiff_command(&mut reader, opcode)?;
        match command {
            GdiffCommand::Data { len } => {
                summary.data_commands =
                    checked_add_usize(summary.data_commands, 1, "data command count")?;
                summary.output_bytes = checked_add_u64(summary.output_bytes, len, "output length")?;
                let patch_data_offset = reader.stream_position()?;
                consume_data(&mut reader, len, &mut scratch)?;
                commands.push(GdiffApplyCommand {
                    output_offset,
                    kind: GdiffApplyCommandKind::Data {
                        patch_data_offset,
                        len,
                    },
                });
                output_offset = checked_add_u64(output_offset, len, "output offset")?;
            }
            GdiffCommand::Copy { offset, len } => {
                summary.copy_commands =
                    checked_add_usize(summary.copy_commands, 1, "copy command count")?;
                summary.output_bytes = checked_add_u64(summary.output_bytes, len, "output length")?;
                commands.push(GdiffApplyCommand {
                    output_offset,
                    kind: GdiffApplyCommandKind::Copy {
                        source_offset: offset,
                        len,
                    },
                });
                output_offset = checked_add_u64(output_offset, len, "output offset")?;
            }
        }
    }

    Ok((summary, commands))
}

fn build_gdiff_apply_tasks(commands: &[GdiffApplyCommand]) -> Vec<GdiffApplyTask> {
    commands
        .iter()
        .copied()
        .map(|command| GdiffApplyTask { command })
        .collect()
}

fn apply_gdiff_plan_sequential(
    commands: &[GdiffApplyCommand],
    patch_path: &Path,
    source_path: &Path,
    output_path: &Path,
    source_len: u64,
) -> Result<()> {
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut patch = BufReader::new(File::open(patch_path)?);
    let mut source = File::open(source_path)?;
    let mut output = BufWriter::new(File::create(output_path)?);
    let mut scratch = vec![0u8; GDIFF_IO_BUFFER_SIZE];
    for command in commands {
        output.seek(SeekFrom::Start(command.output_offset))?;
        match command.kind {
            GdiffApplyCommandKind::Data {
                patch_data_offset,
                len,
            } => {
                patch.seek(SeekFrom::Start(patch_data_offset))?;
                copy_patch_data(&mut patch, &mut output, len, &mut scratch)?;
            }
            GdiffApplyCommandKind::Copy { source_offset, len } => {
                copy_from_source(
                    &mut source,
                    &mut output,
                    source_len,
                    source_offset,
                    len,
                    &mut scratch,
                )?;
            }
        }
    }
    output.flush()?;
    Ok(())
}

fn prepare_gdiff_apply_task(
    task: &GdiffApplyTask,
    patch_path: &Path,
    source_path: &Path,
    source_len: u64,
) -> Result<GdiffPreparedChunk> {
    let mut bytes = Vec::new();
    let mut scratch = vec![0u8; GDIFF_IO_BUFFER_SIZE];
    {
        let mut output = BufWriter::new(&mut bytes);
        match task.command.kind {
            GdiffApplyCommandKind::Data {
                patch_data_offset,
                len,
            } => {
                let mut patch = BufReader::new(File::open(patch_path)?);
                patch.seek(SeekFrom::Start(patch_data_offset))?;
                copy_patch_data(&mut patch, &mut output, len, &mut scratch)?;
            }
            GdiffApplyCommandKind::Copy { source_offset, len } => {
                let mut source = File::open(source_path)?;
                copy_from_source(
                    &mut source,
                    &mut output,
                    source_len,
                    source_offset,
                    len,
                    &mut scratch,
                )?;
            }
        }
        output.flush()?;
    }
    Ok(GdiffPreparedChunk {
        command: task.command,
        bytes,
    })
}

fn apply_gdiff_prepared_chunks(
    chunks: &[GdiffPreparedChunk],
    output_path: &Path,
    context: &OperationContext,
) -> Result<()> {
    let mut output = crate::create_buffered_output(output_path)?;
    for chunk in chunks {
        context.cancel().check()?;
        output.seek(SeekFrom::Start(chunk.command.output_offset))?;
        output.write_all(&chunk.bytes)?;
    }
    output.flush()?;
    Ok(())
}

fn read_gdiff_header(reader: &mut dyn Read) -> Result<()> {
    let mut magic = [0u8; GDIFF_MAGIC.len()];
    read_exact_into(reader, &mut magic, "header magic")?;
    if magic != GDIFF_MAGIC {
        return Err(RomWeaverError::Validation(
            "GDIFF patch header magic is invalid".into(),
        ));
    }

    let version = read_u8(reader, "header version")?;
    if version != GDIFF_VERSION {
        return Err(RomWeaverError::Validation(format!(
            "GDIFF patch version {version} is not supported"
        )));
    }

    Ok(())
}

fn read_gdiff_command(reader: &mut dyn Read, opcode: u8) -> Result<GdiffCommand> {
    match opcode {
        1..=246 => Ok(GdiffCommand::Data {
            len: u64::from(opcode),
        }),
        247 => Ok(GdiffCommand::Data {
            len: u64::from(read_u16_be(reader, "data length")?),
        }),
        248 => Ok(GdiffCommand::Data {
            len: read_non_negative_i32(reader, "data length")?,
        }),
        249 => Ok(GdiffCommand::Copy {
            offset: u64::from(read_u16_be(reader, "copy position")?),
            len: u64::from(read_u8(reader, "copy length")?),
        }),
        250 => Ok(GdiffCommand::Copy {
            offset: u64::from(read_u16_be(reader, "copy position")?),
            len: u64::from(read_u16_be(reader, "copy length")?),
        }),
        251 => Ok(GdiffCommand::Copy {
            offset: u64::from(read_u16_be(reader, "copy position")?),
            len: read_non_negative_i32(reader, "copy length")?,
        }),
        252 => Ok(GdiffCommand::Copy {
            offset: read_non_negative_i32(reader, "copy position")?,
            len: u64::from(read_u8(reader, "copy length")?),
        }),
        253 => Ok(GdiffCommand::Copy {
            offset: read_non_negative_i32(reader, "copy position")?,
            len: u64::from(read_u16_be(reader, "copy length")?),
        }),
        254 => Ok(GdiffCommand::Copy {
            offset: read_non_negative_i32(reader, "copy position")?,
            len: read_non_negative_i32(reader, "copy length")?,
        }),
        255 => Ok(GdiffCommand::Copy {
            offset: read_non_negative_i64(reader, "copy position")?,
            len: read_non_negative_i32(reader, "copy length")?,
        }),
        _ => Err(RomWeaverError::Validation(format!(
            "GDIFF opcode {opcode} is not supported"
        ))),
    }
}

fn write_gdiff_header(writer: &mut dyn Write) -> Result<()> {
    writer.write_all(&GDIFF_MAGIC)?;
    writer.write_all(&[GDIFF_VERSION])?;
    Ok(())
}

fn create_gdiff_patch(
    modified_path: &Path,
    pool: &SharedThreadPool,
    use_parallel_scan: bool,
    output: &mut dyn Write,
) -> Result<(usize, u64)> {
    if use_parallel_scan {
        let modified_len = fs::metadata(modified_path)?.len();
        if crate::create_exceeds_main_thread_cap(modified_len) {
            info!(
                modified_len,
                "GDIFF create: modified size exceeds in-memory limit; falling back to serial path"
            );
            return create_gdiff_patch_streaming(modified_path, output);
        }
        create_gdiff_patch_parallel(modified_path, pool, output)
    } else {
        create_gdiff_patch_streaming(modified_path, output)
    }
}

fn create_gdiff_patch_streaming(
    modified_path: &Path,
    output: &mut dyn Write,
) -> Result<(usize, u64)> {
    let mut modified = BufReader::new(File::open(modified_path)?);
    write_gdiff_header(output)?;

    let mut scratch = vec![0u8; CREATE_COMMAND_CHUNK_BYTES];
    let mut command_count = 0usize;
    let mut output_bytes = 0u64;
    loop {
        let read = modified.read(&mut scratch)?;
        if read == 0 {
            break;
        }
        encode_data_command(output, &scratch[..read])?;
        command_count = checked_add_usize(command_count, 1, "create command count")?;
        output_bytes = checked_add_u64(
            output_bytes,
            u64::try_from(read)
                .map_err(|_| RomWeaverError::Validation("GDIFF data length overflowed".into()))?,
            "create output length",
        )?;
    }
    output.write_all(&[0])?;
    Ok((command_count, output_bytes))
}

fn create_gdiff_patch_parallel(
    modified_path: &Path,
    pool: &SharedThreadPool,
    output: &mut dyn Write,
) -> Result<(usize, u64)> {
    let modified_len = fs::metadata(modified_path)?.len();
    write_gdiff_header(output)?;
    if modified_len == 0 {
        output.write_all(&[0])?;
        return Ok((0, 0));
    }

    let chunk_ranges = (0..modified_len)
        .step_by(CREATE_COMMAND_CHUNK_BYTES)
        .map(|start| {
            let len =
                usize::try_from((modified_len - start).min(CREATE_COMMAND_CHUNK_BYTES as u64))
                    .map_err(|_| {
                        RomWeaverError::Validation(
                            "GDIFF create chunk length exceeded usize".into(),
                        )
                    })?;
            Ok::<(u64, usize), RomWeaverError>((start, len))
        })
        .collect::<Result<Vec<_>>>()?;

    let command_count = chunk_ranges.len();
    let command_bytes = if crate::patches_reads_source_on_main_thread() {
        let buffered = chunk_ranges
            .iter()
            .map(|&(offset, len)| {
                let mut f = File::open(modified_path)?;
                f.seek(SeekFrom::Start(offset))?;
                let mut chunk = vec![0u8; len];
                f.read_exact(&mut chunk)?;
                Ok(chunk)
            })
            .collect::<Result<Vec<_>>>()?;
        pool.install(|| {
            buffered
                .into_par_iter()
                .map(|chunk| encode_data_command_bytes(&chunk))
                .collect::<Result<Vec<_>>>()
        })?
    } else {
        pool.install(|| {
            chunk_ranges
                .into_par_iter()
                .map(|(offset, len)| {
                    encode_data_command_bytes_for_chunk(modified_path, offset, len)
                })
                .collect::<Result<Vec<_>>>()
        })?
    };

    for command in command_bytes {
        output.write_all(&command)?;
    }
    output.write_all(&[0])?;
    Ok((command_count, modified_len))
}

fn encode_data_command_bytes_for_chunk(
    modified_path: &Path,
    offset: u64,
    len: usize,
) -> Result<Vec<u8>> {
    let mut modified = BufReader::new(File::open(modified_path)?);
    modified.seek(SeekFrom::Start(offset))?;
    let mut chunk = vec![0u8; len];
    modified.read_exact(&mut chunk)?;
    encode_data_command_bytes(&chunk)
}

fn encode_data_command_bytes(data: &[u8]) -> Result<Vec<u8>> {
    let mut bytes = Vec::with_capacity(data.len() + 3);
    if data.len() <= GDIFF_INLINE_DATA_MAX {
        let inline_len = u8::try_from(data.len()).map_err(|_| {
            RomWeaverError::Validation("GDIFF inline data command length exceeded u8 range".into())
        })?;
        bytes.push(inline_len);
    } else {
        let len = u16::try_from(data.len()).map_err(|_| {
            RomWeaverError::Validation(
                "GDIFF create data command exceeded maximum chunk size".into(),
            )
        })?;
        bytes.push(247);
        bytes.extend_from_slice(&len.to_be_bytes());
    }
    bytes.extend_from_slice(data);
    Ok(bytes)
}

fn encode_data_command(writer: &mut dyn Write, data: &[u8]) -> Result<()> {
    if data.len() <= GDIFF_INLINE_DATA_MAX {
        let inline_len = u8::try_from(data.len()).map_err(|_| {
            RomWeaverError::Validation("GDIFF inline data command length exceeded u8 range".into())
        })?;
        writer.write_all(&[inline_len])?;
    } else {
        let len = u16::try_from(data.len()).map_err(|_| {
            RomWeaverError::Validation(
                "GDIFF create data command exceeded maximum chunk size".into(),
            )
        })?;
        writer.write_all(&[247])?;
        writer.write_all(&len.to_be_bytes())?;
    }
    writer.write_all(data)?;
    Ok(())
}

fn copy_patch_data(
    reader: &mut dyn Read,
    writer: &mut dyn Write,
    len: u64,
    scratch: &mut [u8],
) -> Result<()> {
    if len == 0 {
        return Ok(());
    }

    let mut remaining = len;
    while remaining > 0 {
        let chunk_len = min(
            usize::try_from(remaining).unwrap_or(usize::MAX),
            scratch.len(),
        );
        read_exact_into(reader, &mut scratch[..chunk_len], "data bytes")?;
        writer.write_all(&scratch[..chunk_len])?;
        remaining -= chunk_len as u64;
    }

    Ok(())
}

fn consume_data(reader: &mut dyn Read, len: u64, scratch: &mut [u8]) -> Result<()> {
    if len == 0 {
        return Ok(());
    }

    let mut remaining = len;
    while remaining > 0 {
        let chunk_len = min(
            usize::try_from(remaining).unwrap_or(usize::MAX),
            scratch.len(),
        );
        read_exact_into(reader, &mut scratch[..chunk_len], "data bytes")?;
        remaining -= chunk_len as u64;
    }

    Ok(())
}

fn copy_from_source(
    source: &mut File,
    output: &mut dyn Write,
    source_len: u64,
    offset: u64,
    len: u64,
    scratch: &mut [u8],
) -> Result<()> {
    ensure_copy_range(source_len, offset, len)?;
    if len == 0 {
        return Ok(());
    }

    source.seek(SeekFrom::Start(offset))?;
    let mut remaining = len;
    while remaining > 0 {
        let chunk_len = min(
            usize::try_from(remaining).unwrap_or(usize::MAX),
            scratch.len(),
        );
        source.read_exact(&mut scratch[..chunk_len])?;
        output.write_all(&scratch[..chunk_len])?;
        remaining -= chunk_len as u64;
    }

    Ok(())
}

fn ensure_copy_range(source_len: u64, offset: u64, len: u64) -> Result<()> {
    let end = offset
        .checked_add(len)
        .ok_or_else(|| RomWeaverError::Validation("GDIFF copy range overflowed".into()))?;
    if end > source_len {
        return Err(RomWeaverError::Validation(format!(
            "GDIFF copy command exceeded available source length ({end} > {source_len})"
        )));
    }
    Ok(())
}

fn checked_add_u64(lhs: u64, rhs: u64, label: &str) -> Result<u64> {
    lhs.checked_add(rhs)
        .ok_or_else(|| RomWeaverError::Validation(format!("GDIFF {label} overflowed")))
}

fn checked_add_usize(lhs: usize, rhs: usize, label: &str) -> Result<usize> {
    lhs.checked_add(rhs)
        .ok_or_else(|| RomWeaverError::Validation(format!("GDIFF {label} overflowed")))
}

fn read_u8(reader: &mut dyn Read, label: &str) -> Result<u8> {
    let mut bytes = [0u8; 1];
    read_exact_into(reader, &mut bytes, label)?;
    Ok(bytes[0])
}

fn read_u16_be(reader: &mut dyn Read, label: &str) -> Result<u16> {
    let mut bytes = [0u8; 2];
    read_exact_into(reader, &mut bytes, label)?;
    Ok(u16::from_be_bytes(bytes))
}

fn read_i32_be(reader: &mut dyn Read, label: &str) -> Result<i32> {
    let mut bytes = [0u8; 4];
    read_exact_into(reader, &mut bytes, label)?;
    Ok(i32::from_be_bytes(bytes))
}

fn read_i64_be(reader: &mut dyn Read, label: &str) -> Result<i64> {
    let mut bytes = [0u8; 8];
    read_exact_into(reader, &mut bytes, label)?;
    Ok(i64::from_be_bytes(bytes))
}

fn read_non_negative_i32(reader: &mut dyn Read, label: &str) -> Result<u64> {
    let value = read_i32_be(reader, label)?;
    if value < 0 {
        return Err(RomWeaverError::Validation(format!(
            "GDIFF {label} must be non-negative"
        )));
    }
    Ok(value as u64)
}

fn read_non_negative_i64(reader: &mut dyn Read, label: &str) -> Result<u64> {
    let value = read_i64_be(reader, label)?;
    if value < 0 {
        return Err(RomWeaverError::Validation(format!(
            "GDIFF {label} must be non-negative"
        )));
    }
    Ok(value as u64)
}

fn read_exact_into(reader: &mut dyn Read, buffer: &mut [u8], label: &str) -> Result<()> {
    reader.read_exact(buffer).map_err(|error| {
        if error.kind() == ErrorKind::UnexpectedEof {
            RomWeaverError::Validation(format!(
                "GDIFF patch ended unexpectedly while reading {label}"
            ))
        } else {
            error.into()
        }
    })
}

#[cfg(test)]
#[path = "../tests/unit/gdiff.rs"]
mod tests;
/* jscpd:ignore-end */
