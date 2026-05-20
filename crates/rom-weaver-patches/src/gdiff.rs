use std::{
    cmp::min,
    fs::{self, File},
    io::{BufReader, BufWriter, ErrorKind, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use rayon::prelude::*;
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchCreateRequest, PatchHandler, ProbeConfidence, Result, RomWeaverError,
    SharedThreadPool, ThreadCapability,
};

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
        let thread_capability = gdiff_apply_thread_capability(commands.len());
        let planned_execution = context.plan_threads(thread_capability.clone());

        let execution = if planned_execution.used_parallelism {
            let tasks = build_gdiff_apply_tasks(&commands, context);
            let (execution, pool) = context.build_pool(thread_capability)?;
            let prepare_result = pool.install(|| {
                tasks
                    .par_iter()
                    .map(|task| {
                        prepare_gdiff_apply_task(
                            task,
                            patch_path,
                            &request.input,
                            source_len,
                            context,
                        )
                    })
                    .collect::<Result<Vec<_>>>()
            });
            if let Err(error) = prepare_result {
                cleanup_gdiff_apply_tasks(&tasks);
                return Err(error);
            }
            let apply_result = apply_gdiff_prepared_tasks(&tasks, &request.output, context);
            cleanup_gdiff_apply_tasks(&tasks);
            apply_result?;
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

    fn create(
        &self,
        request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let _ = fs::metadata(&request.original)?;
        let modified_len = fs::metadata(&request.modified)?.len();
        let (execution, pool) = context.build_pool(gdiff_create_thread_capability(modified_len))?;
        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut output = BufWriter::new(File::create(&request.output)?);
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

fn gdiff_create_thread_capability(modified_len: u64) -> ThreadCapability {
    let command_count = gdiff_create_command_count(modified_len).max(1);
    ThreadCapability::parallel(Some(command_count))
}

fn gdiff_create_command_count(modified_len: u64) -> usize {
    if modified_len == 0 {
        return 1;
    }
    let chunk_bytes = CREATE_COMMAND_CHUNK_BYTES as u64;
    let command_count = modified_len.saturating_add(chunk_bytes - 1) / chunk_bytes;
    usize::try_from(command_count).unwrap_or(usize::MAX)
}

fn gdiff_apply_thread_capability(command_count: usize) -> ThreadCapability {
    ThreadCapability::parallel(Some(command_count.max(1)))
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
    index: usize,
    output_offset: u64,
    kind: GdiffApplyCommandKind,
}

impl GdiffApplyCommand {
    fn len(&self) -> u64 {
        match self.kind {
            GdiffApplyCommandKind::Data { len, .. } => len,
            GdiffApplyCommandKind::Copy { len, .. } => len,
        }
    }
}

#[derive(Clone)]
struct GdiffApplyTask {
    command: GdiffApplyCommand,
    temp_path: PathBuf,
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
        let index = commands.len();
        match command {
            GdiffCommand::Data { len } => {
                summary.data_commands =
                    checked_add_usize(summary.data_commands, 1, "data command count")?;
                summary.output_bytes = checked_add_u64(summary.output_bytes, len, "output length")?;
                let patch_data_offset = reader.stream_position()?;
                consume_data(&mut reader, len, &mut scratch)?;
                commands.push(GdiffApplyCommand {
                    index,
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
                    index,
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

fn build_gdiff_apply_tasks(
    commands: &[GdiffApplyCommand],
    context: &OperationContext,
) -> Vec<GdiffApplyTask> {
    commands
        .iter()
        .copied()
        .map(|command| GdiffApplyTask {
            command,
            temp_path: context.temp_paths().next_path(
                &format!("gdiff-apply-command-{}", command.index),
                Some("bin"),
            ),
        })
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
    context: &OperationContext,
) -> Result<()> {
    context.cancel().check()?;
    if let Some(parent) = task.temp_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut output = BufWriter::new(File::create(&task.temp_path)?);
    let mut scratch = vec![0u8; GDIFF_IO_BUFFER_SIZE];
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
    Ok(())
}

fn apply_gdiff_prepared_tasks(
    tasks: &[GdiffApplyTask],
    output_path: &Path,
    context: &OperationContext,
) -> Result<()> {
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut output = BufWriter::new(File::create(output_path)?);
    let mut scratch = vec![0u8; GDIFF_IO_BUFFER_SIZE];
    for task in tasks {
        context.cancel().check()?;
        output.seek(SeekFrom::Start(task.command.output_offset))?;
        let mut reader = BufReader::new(File::open(&task.temp_path)?);
        copy_patch_data(&mut reader, &mut output, task.command.len(), &mut scratch)?;
    }
    output.flush()?;
    Ok(())
}

fn cleanup_gdiff_apply_tasks(tasks: &[GdiffApplyTask]) {
    for task in tasks {
        let _ = fs::remove_file(&task.temp_path);
    }
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
    let modified = crate::map_file_read_only(modified_path)?;
    write_gdiff_header(output)?;

    let chunk_ranges = (0..modified.len())
        .step_by(CREATE_COMMAND_CHUNK_BYTES)
        .map(|start| {
            let end = start
                .saturating_add(CREATE_COMMAND_CHUNK_BYTES)
                .min(modified.len());
            start..end
        })
        .collect::<Vec<_>>();

    let command_count = chunk_ranges.len();
    let command_bytes = pool.install(|| {
        chunk_ranges
            .into_par_iter()
            .map(|range| encode_data_command_bytes(&modified[range.start..range.end]))
            .collect::<Result<Vec<_>>>()
    })?;

    for command in command_bytes {
        output.write_all(&command)?;
    }
    output.write_all(&[0])?;
    Ok((command_count, modified.len() as u64))
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
mod tests {
    use std::fs;

    use rom_weaver_core::{PatchApplyRequest, PatchCreateRequest, PatchHandler};

    use super::{GdiffPatchHandler, write_gdiff_header};
    use crate::{
        GDIFF,
        test_support::{TestDir, test_context_with_threads},
    };

    enum TestGdiffCommand {
        Data(Vec<u8>),
        Copy { offset: u64, len: u64 },
    }

    fn build_test_gdiff_patch(commands: Vec<TestGdiffCommand>) -> Vec<u8> {
        let mut bytes = Vec::new();
        write_gdiff_header(&mut bytes).expect("header");
        for command in commands {
            match command {
                TestGdiffCommand::Data(data) => {
                    if data.len() <= 246 {
                        bytes.push(u8::try_from(data.len()).expect("len"));
                    } else {
                        bytes.push(247);
                        bytes.extend_from_slice(
                            &u16::try_from(data.len())
                                .expect("len fits u16")
                                .to_be_bytes(),
                        );
                    }
                    bytes.extend_from_slice(&data);
                }
                TestGdiffCommand::Copy { offset, len } => {
                    if offset <= u64::from(u16::MAX) && len <= u64::from(u8::MAX) {
                        bytes.push(249);
                        bytes.extend_from_slice(&(offset as u16).to_be_bytes());
                        bytes.push(len as u8);
                    } else if offset <= u64::from(i32::MAX as u32)
                        && len <= u64::from(i32::MAX as u32)
                    {
                        bytes.push(254);
                        bytes.extend_from_slice(&(offset as u32).to_be_bytes());
                        bytes.extend_from_slice(&(len as u32).to_be_bytes());
                    } else {
                        bytes.push(255);
                        bytes.extend_from_slice(&(offset as i64).to_be_bytes());
                        bytes.extend_from_slice(&(len as i32).to_be_bytes());
                    }
                }
            }
        }
        bytes.push(0);
        bytes
    }

    #[test]
    fn parse_rejects_invalid_magic() {
        let temp = TestDir::new();
        let patch_path = temp.child("bad.gdiff");
        fs::write(&patch_path, b"BAD!\x04\x00").expect("fixture");

        let handler = GdiffPatchHandler::new(&GDIFF);
        let error = handler
            .parse(&patch_path, &test_context_with_threads(&temp, 1))
            .expect_err("invalid magic");
        assert!(error.to_string().contains("header magic is invalid"));
    }

    #[test]
    fn apply_supports_copy_and_data_commands() {
        let temp = TestDir::new();
        let source_path = temp.child("source.bin");
        let patch_path = temp.child("update.gdiff");
        let output_path = temp.child("output.bin");

        fs::write(&source_path, b"abcdefgh").expect("fixture");
        let patch = build_test_gdiff_patch(vec![
            TestGdiffCommand::Copy { offset: 0, len: 2 },
            TestGdiffCommand::Data(b"XY".to_vec()),
            TestGdiffCommand::Copy { offset: 4, len: 4 },
        ]);
        fs::write(&patch_path, patch).expect("fixture");

        let handler = GdiffPatchHandler::new(&GDIFF);
        handler
            .apply(
                &PatchApplyRequest {
                    input: source_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 2),
            )
            .expect("apply");

        assert_eq!(fs::read(output_path).expect("output"), b"abXYefgh");
    }

    #[test]
    fn apply_rejects_negative_copy_position() {
        let temp = TestDir::new();
        let source_path = temp.child("source.bin");
        let patch_path = temp.child("negative.gdiff");
        let output_path = temp.child("output.bin");

        fs::write(&source_path, b"abcdefgh").expect("fixture");
        let mut patch = Vec::new();
        write_gdiff_header(&mut patch).expect("header");
        patch.push(255);
        patch.extend_from_slice(&(-1_i64).to_be_bytes());
        patch.extend_from_slice(&(1_i32).to_be_bytes());
        patch.push(0);
        fs::write(&patch_path, patch).expect("fixture");

        let handler = GdiffPatchHandler::new(&GDIFF);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: source_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect_err("negative position");
        assert!(
            error
                .to_string()
                .contains("copy position must be non-negative")
        );
    }

    #[test]
    fn create_and_apply_round_trip() {
        let temp = TestDir::new();
        let source_path = temp.child("source.bin");
        let target_path = temp.child("target.bin");
        let patch_path = temp.child("update.gdiff");
        let output_path = temp.child("output.bin");

        fs::write(&source_path, b"this is the old bytes").expect("fixture");
        let mut target = b"this is a different target with more bytes".to_vec();
        target.extend_from_slice(&[0x01, 0x02, 0x03, 0x04]);
        fs::write(&target_path, &target).expect("fixture");

        let handler = GdiffPatchHandler::new(&GDIFF);
        handler
            .create(
                &PatchCreateRequest {
                    original: source_path.clone(),
                    modified: target_path.clone(),
                    output: patch_path.clone(),
                    format: "gdiff".into(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("create");

        handler
            .apply(
                &PatchApplyRequest {
                    input: source_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("apply");

        assert_eq!(
            fs::read(output_path).expect("output"),
            fs::read(target_path).expect("target")
        );
    }

    #[test]
    fn apply_is_deterministic_across_thread_budgets() {
        let temp = TestDir::new();
        let source_path = temp.child("source.bin");
        let patch_path = temp.child("update.gdiff");
        let output_single = temp.child("output-single.bin");
        let output_parallel = temp.child("output-parallel.bin");

        let source = b"0123456789abcdefghijklmnopqrstuvwxyz".to_vec();
        fs::write(&source_path, &source).expect("fixture");
        let patch = build_test_gdiff_patch(vec![
            TestGdiffCommand::Copy { offset: 0, len: 10 },
            TestGdiffCommand::Data(b"++".to_vec()),
            TestGdiffCommand::Copy { offset: 10, len: 8 },
            TestGdiffCommand::Data(b"--".to_vec()),
            TestGdiffCommand::Copy { offset: 2, len: 14 },
            TestGdiffCommand::Data(vec![0xFA, 0xCE, 0xB0, 0x0C]),
        ]);
        fs::write(&patch_path, patch).expect("patch");

        let handler = GdiffPatchHandler::new(&GDIFF);
        let single_report = handler
            .apply(
                &PatchApplyRequest {
                    input: source_path.clone(),
                    patches: vec![patch_path.clone()],
                    output: output_single.clone(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("single apply");
        let parallel_report = handler
            .apply(
                &PatchApplyRequest {
                    input: source_path,
                    patches: vec![patch_path],
                    output: output_parallel.clone(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("parallel apply");

        assert!(
            !single_report
                .thread_execution
                .expect("single execution")
                .used_parallelism
        );
        assert!(
            parallel_report
                .thread_execution
                .expect("parallel execution")
                .used_parallelism
        );
        assert_eq!(
            fs::read(output_single).expect("single output"),
            fs::read(output_parallel).expect("parallel output")
        );
    }

    #[test]
    fn apply_runtime_threads_match_capabilities_for_multi_command_patch() {
        let temp = TestDir::new();
        let source_path = temp.child("source.bin");
        let patch_path = temp.child("update.gdiff");
        let output_path = temp.child("output.bin");

        let len = super::CREATE_COMMAND_CHUNK_BYTES * 4 + 257;
        let mut source = vec![0u8; len];
        for (index, byte) in source.iter_mut().enumerate() {
            *byte = ((index * 17 + (index >> 2)) & 0xff) as u8;
        }
        fs::write(&source_path, &source).expect("source");

        let patch = build_test_gdiff_patch(vec![
            TestGdiffCommand::Copy {
                offset: 0,
                len: super::CREATE_COMMAND_CHUNK_BYTES as u64,
            },
            TestGdiffCommand::Data(vec![0xAA; 64]),
            TestGdiffCommand::Copy {
                offset: super::CREATE_COMMAND_CHUNK_BYTES as u64,
                len: super::CREATE_COMMAND_CHUNK_BYTES as u64,
            },
            TestGdiffCommand::Data(vec![0x55; 64]),
            TestGdiffCommand::Copy {
                offset: (super::CREATE_COMMAND_CHUNK_BYTES * 2) as u64,
                len: super::CREATE_COMMAND_CHUNK_BYTES as u64,
            },
        ]);
        fs::write(&patch_path, patch).expect("patch");

        let handler = GdiffPatchHandler::new(&GDIFF);
        let capabilities = handler.capabilities();
        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: source_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("apply");
        let execution = report.thread_execution.expect("thread execution");

        assert!(capabilities.threaded_output);
        assert_eq!(execution.requested_threads, 8);
        assert!(execution.used_parallelism);
    }

    #[test]
    fn create_is_deterministic_across_thread_budgets() {
        let temp = TestDir::new();
        let source_path = temp.child("source-large.bin");
        let target_path = temp.child("target-large.bin");
        let single_patch = temp.child("single.gdiff");
        let parallel_patch = temp.child("parallel.gdiff");

        let len = super::CREATE_COMMAND_CHUNK_BYTES * 8 + 123;
        fs::write(&source_path, vec![0u8; len]).expect("source");

        let mut target = vec![0u8; len];
        for (index, byte) in target.iter_mut().enumerate() {
            *byte = ((index * 11 + (index >> 3)) & 0xff) as u8;
        }
        fs::write(&target_path, &target).expect("target");

        let handler = GdiffPatchHandler::new(&GDIFF);
        let single_report = handler
            .create(
                &PatchCreateRequest {
                    original: source_path.clone(),
                    modified: target_path.clone(),
                    output: single_patch.clone(),
                    format: "gdiff".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("single create");
        let parallel_report = handler
            .create(
                &PatchCreateRequest {
                    original: source_path,
                    modified: target_path,
                    output: parallel_patch.clone(),
                    format: "gdiff".into(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("parallel create");

        assert!(
            !single_report
                .thread_execution
                .expect("single execution")
                .used_parallelism
        );
        assert!(
            parallel_report
                .thread_execution
                .expect("parallel execution")
                .used_parallelism
        );
        assert_eq!(
            fs::read(single_patch).expect("single patch"),
            fs::read(parallel_patch).expect("parallel patch")
        );
    }
}
