/* jscpd:ignore-start */
use std::{
    fs::{self, File, OpenOptions},
    io::{BufWriter, Cursor, Read, Seek, SeekFrom, Write},
    path::Path,
    sync::Arc,
};

use bzip2::read::MultiBzDecoder;
use qbsdiff::ParallelScheme;
use rom_weaver_codecs::decode_bzip2_exact;
use rom_weaver_core::{
    BlockCacheReader, DEFAULT_BLOCK_CACHE_MAX_BLOCKS, DEFAULT_BLOCK_CACHE_SIZE_BYTES,
    FormatDescriptor, OperationContext, OperationReport, PatchApplyRequest, PatchCapabilities,
    PatchCreateRequest, PatchHandler, PatchValidateRequest, Result, RomWeaverError,
    SharedBlockCacheReader, SharedThreadPool, ThreadCapability,
};

use crate::qbsdiff_support::qbsdiff_thread_capability;
use crate::shared::threading::pool_map;

const BSDIFF40_HEADER_BYTES: usize = 32;
const BSDIFF40_MAGIC: &[u8] = b"BSDIFF40";
const BSDIFF40_CONTROL_BYTES: usize = 24;

pub struct BdfPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl BdfPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }

    fn parse_report(&self, patch_path: &Path) -> Result<OperationReport> {
        crate::patch_parse_report_with(self.descriptor, || {
            let layout = parse_bsdiff_patch_layout_from_path(patch_path)?;
            Ok(build_bdf_parse_label(
                self.descriptor.name,
                layout.target_len_hint,
            ))
        })
    }

    fn apply_report(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let patch_path = crate::require_single_patch_file(&request.patches, self.descriptor.name)?;
        let patch_layout = parse_bsdiff_patch_layout_from_path(patch_path)?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let thread_capability = qbsdiff_apply_thread_capability(patch_layout.target_len_hint);
        let source_len_u64 = fs::metadata(&request.input)?.len();
        let source_len = usize::try_from(source_len_u64).map_err(|_| {
            RomWeaverError::Validation("BSDIFF40 source exceeded addressable memory".into())
        })?;
        let plan = parse_bsdiff_parallel_plan_with_layout(patch_path, &patch_layout, source_len)?;
        let mut output = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&request.output)?;
        output.set_len(plan.output_len)?;
        let planned_execution = context.plan_threads(thread_capability.clone());
        let (execution, writes) = if planned_execution.used_parallelism {
            let (execution, pool) = context.build_pool(thread_capability)?;
            let source_reader = Arc::new(SharedBlockCacheReader::open(
                &request.input,
                DEFAULT_BLOCK_CACHE_SIZE_BYTES,
                DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
            )?);
            let writes = prepare_bsdiff_writes_parallel(
                &plan.writes,
                &source_reader,
                source_len,
                &plan.delta_payload,
                &plan.extra_payload,
                &pool,
                context,
            )?;
            (execution, writes)
        } else {
            let writes = prepare_bsdiff_writes_sequential(
                &plan.writes,
                &request.input,
                source_len,
                &plan.delta_payload,
                &plan.extra_payload,
                context,
            )?;
            (planned_execution, writes)
        };
        apply_prepared_bsdiff_writes(&mut output, &writes)?;
        output.flush()?;
        let written = fs::metadata(&request.output)?.len();

        Ok(crate::patch_success_report(
            self.descriptor,
            "apply",
            format!(
                "applied {} patch and wrote {} byte(s)",
                self.descriptor.name, written
            ),
            Some(execution),
        ))
    }
}

impl PatchHandler for BdfPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        self.parse_report(patch_path)
    }

    fn apply(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        self.apply_report(request, context)
    }

    fn validate(
        &self,
        request: &PatchValidateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let patch_path = crate::require_single_patch_file(&request.patches, self.descriptor.name)?;
        let patch_layout = parse_bsdiff_patch_layout_from_path(patch_path)?;
        let source_len_u64 = fs::metadata(&request.input)?.len();
        let source_len = usize::try_from(source_len_u64).map_err(|_| {
            RomWeaverError::Validation("BSDIFF40 source exceeded addressable memory".into())
        })?;
        let plan = parse_bsdiff_parallel_plan_with_layout(patch_path, &patch_layout, source_len)?;

        Ok(crate::patch_success_report(
            self.descriptor,
            "validate",
            format!(
                "validated {} patch source; output would be {} byte(s)",
                self.descriptor.name, plan.output_len
            ),
            Some(context.plan_threads(ThreadCapability::single_threaded())),
        ))
    }

    fn create(
        &self,
        request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let source_len = fs::metadata(&request.original)?.len();
        if source_len > qbsdiff::bsdiff::MAX_LENGTH as u64 {
            return Err(RomWeaverError::Validation(format!(
                "BSDIFF40 source exceeds maximum supported size of {} byte(s)",
                qbsdiff::bsdiff::MAX_LENGTH
            )));
        }
        let target_len = fs::metadata(&request.modified)?.len();
        let target_len_usize = usize::try_from(target_len).map_err(|_| {
            RomWeaverError::Validation("BSDIFF40 target exceeded addressable memory".into())
        })?;
        let (execution, pool) = context.build_pool(qbsdiff_thread_capability(target_len_usize))?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        pool.install(|| create_qbsdiff_patch(request, context, execution.effective_threads))?;
        let patch_len = fs::metadata(&request.output)?.len();

        Ok(crate::patch_success_report(
            self.descriptor,
            "create",
            format!(
                "created {} patch ({} byte(s))",
                self.descriptor.name, patch_len
            ),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> PatchCapabilities {
        crate::threaded_create_capabilities()
    }
}

#[derive(Clone, Debug)]
struct BsdiffPatchFileLayout {
    control_offset: u64,
    control_len: u64,
    delta_offset: u64,
    delta_len: u64,
    extra_offset: u64,
    extra_len: u64,
    target_len_hint: u64,
}

#[derive(Clone, Debug)]
struct ParsedBsdiffParallelPlan {
    writes: Vec<BsdiffWritePlan>,
    delta_payload: Vec<u8>,
    extra_payload: Vec<u8>,
    output_len: u64,
}

#[derive(Clone, Debug)]
struct BsdiffWritePlan {
    output_offset: u64,
    kind: BsdiffWritePlanKind,
}

#[derive(Clone, Debug)]
enum BsdiffWritePlanKind {
    Add {
        source_offset: i128,
        delta_offset: u64,
        len: u64,
    },
    Copy {
        extra_offset: u64,
        len: u64,
    },
}

#[derive(Clone, Debug)]
struct PreparedBsdiffWrite {
    output_offset: u64,
    data: Vec<u8>,
}

fn qbsdiff_apply_thread_capability(target_len: u64) -> ThreadCapability {
    match usize::try_from(target_len) {
        Ok(target_len) => qbsdiff_thread_capability(target_len),
        Err(_) => ThreadCapability::parallel(None),
    }
}

fn build_bdf_parse_label(format_name: &str, target_size: u64) -> String {
    format!("parsed {format_name} patch targeting {target_size} byte(s)")
}

fn create_qbsdiff_patch(
    request: &PatchCreateRequest,
    context: &OperationContext,
    effective_threads: usize,
) -> Result<()> {
    context.cancel().check()?;
    let source = fs::read(&request.original)?;
    context.cancel().check()?;
    let target = fs::read(&request.modified)?;
    context.cancel().check()?;

    let patch_writer = BufWriter::new(File::create(&request.output)?);
    qbsdiff::Bsdiff::new(source.as_slice(), target.as_slice())
        .parallel_scheme(qbsdiff_parallel_scheme(effective_threads))
        .compression_level(9)
        .compare(patch_writer)?;
    context.cancel().check()?;
    Ok(())
}

fn qbsdiff_parallel_scheme(effective_threads: usize) -> ParallelScheme {
    if effective_threads > 1 {
        ParallelScheme::NumJobs(effective_threads)
    } else {
        ParallelScheme::Never
    }
}

#[cfg(test)]
fn encode_bsdiff_i64(value: i64) -> [u8; 8] {
    let mut bytes = value.unsigned_abs().to_le_bytes();
    if value < 0 {
        bytes[7] |= 0x80;
    }
    bytes
}

fn parse_bsdiff_parallel_plan_with_layout(
    patch_path: &Path,
    layout: &BsdiffPatchFileLayout,
    source_len: usize,
) -> Result<ParsedBsdiffParallelPlan> {
    let mut patch_reader = BlockCacheReader::open(
        patch_path,
        DEFAULT_BLOCK_CACHE_SIZE_BYTES,
        DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
    )?;

    let control_block = read_patch_block(
        &mut patch_reader,
        layout.control_offset,
        layout.control_len,
        "control",
    )?;
    let (writes, delta_len, extra_len, output_len) =
        collect_bsdiff_write_plans(control_block.as_slice(), source_len)?;
    if output_len != layout.target_len_hint {
        return Err(RomWeaverError::Validation(
            "BSDIFF40 control output length did not match header target length".into(),
        ));
    }
    let delta_payload = {
        let delta_block = read_patch_block(
            &mut patch_reader,
            layout.delta_offset,
            layout.delta_len,
            "delta",
        )?;
        decompress_bzip_stream_exact(delta_block.as_slice(), delta_len)?
    };
    let extra_payload = {
        let extra_block = read_patch_block(
            &mut patch_reader,
            layout.extra_offset,
            layout.extra_len,
            "extra",
        )?;
        decompress_bzip_stream_exact(extra_block.as_slice(), extra_len)?
    };
    Ok(ParsedBsdiffParallelPlan {
        writes,
        delta_payload,
        extra_payload,
        output_len,
    })
}

fn read_patch_block(
    reader: &mut BlockCacheReader,
    offset: u64,
    len: u64,
    label: &'static str,
) -> Result<Vec<u8>> {
    let len = usize::try_from(len).map_err(|_| {
        RomWeaverError::Validation(format!("BSDIFF40 {label} block length overflowed usize"))
    })?;
    if len == 0 {
        return Ok(Vec::new());
    }
    let mut block = vec![0u8; len];
    reader.read_exact_at(offset, &mut block)?;
    Ok(block)
}

fn parse_bsdiff_patch_layout_from_path(path: &Path) -> Result<BsdiffPatchFileLayout> {
    let patch_len = fs::metadata(path)?.len();
    if patch_len < BSDIFF40_HEADER_BYTES as u64 {
        return Err(RomWeaverError::Validation("not a valid patch".into()));
    }

    let mut header = [0u8; BSDIFF40_HEADER_BYTES];
    let mut reader = BlockCacheReader::open(
        path,
        DEFAULT_BLOCK_CACHE_SIZE_BYTES,
        DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
    )?;
    reader.read_exact_at(0, &mut header)?;
    if &header[..8] != BSDIFF40_MAGIC {
        return Err(RomWeaverError::Validation("not a valid patch".into()));
    }

    let control_len: u64 = decode_bsdiff_i64(&header[8..16])?
        .try_into()
        .map_err(|_| RomWeaverError::Validation("patch corrupted".into()))?;
    let delta_len: u64 = decode_bsdiff_i64(&header[16..24])?
        .try_into()
        .map_err(|_| RomWeaverError::Validation("patch corrupted".into()))?;
    let target_len_hint: u64 = decode_bsdiff_i64(&header[24..32])?
        .try_into()
        .map_err(|_| RomWeaverError::Validation("patch corrupted".into()))?;

    let control_offset = BSDIFF40_HEADER_BYTES as u64;
    let delta_offset = control_offset
        .checked_add(control_len)
        .ok_or_else(|| RomWeaverError::Validation("patch corrupted".into()))?;
    let extra_offset = delta_offset
        .checked_add(delta_len)
        .ok_or_else(|| RomWeaverError::Validation("patch corrupted".into()))?;
    if extra_offset > patch_len {
        return Err(RomWeaverError::Validation("patch corrupted".into()));
    }

    Ok(BsdiffPatchFileLayout {
        control_offset,
        control_len,
        delta_offset,
        delta_len,
        extra_offset,
        extra_len: patch_len - extra_offset,
        target_len_hint,
    })
}

fn collect_bsdiff_write_plans(
    compressed_control_block: &[u8],
    _source_len: usize,
) -> Result<(Vec<BsdiffWritePlan>, u64, u64, u64)> {
    let mut control_decoder = MultiBzDecoder::new(Cursor::new(compressed_control_block));

    let mut writes = Vec::new();
    let mut source_offset = 0i128;
    let mut output_offset = 0u64;
    let mut delta_offset = 0u64;
    let mut extra_offset = 0u64;

    loop {
        let mut control = [0u8; BSDIFF40_CONTROL_BYTES];
        let mut read = 0usize;
        while read < control.len() {
            let chunk = control_decoder
                .read(&mut control[read..])
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "BSDIFF40 control block decode failed: {error}"
                    ))
                })?;
            if chunk == 0 {
                break;
            }
            read = read.saturating_add(chunk);
        }
        if read == 0 {
            break;
        }
        if read != control.len() {
            return Err(RomWeaverError::Validation(
                "BSDIFF40 control block ended with a partial record".into(),
            ));
        }

        let add_len: u64 = decode_bsdiff_i64(&control[0..8])?.try_into().map_err(|_| {
            RomWeaverError::Validation("BSDIFF40 patch contains a negative add length".into())
        })?;
        let copy_len: u64 = decode_bsdiff_i64(&control[8..16])?
            .try_into()
            .map_err(|_| {
                RomWeaverError::Validation("BSDIFF40 patch contains a negative copy length".into())
            })?;
        let seek = decode_bsdiff_i64(&control[16..24])?;

        if add_len > 0 {
            let source_start = source_offset;
            let source_end = source_start
                .checked_add(i128::from(add_len))
                .ok_or_else(|| {
                    RomWeaverError::Validation("BSDIFF40 source offset overflowed".into())
                })?;
            writes.push(BsdiffWritePlan {
                output_offset,
                kind: BsdiffWritePlanKind::Add {
                    source_offset: source_start,
                    delta_offset,
                    len: add_len,
                },
            });
            source_offset = source_end;
            output_offset = output_offset.checked_add(add_len).ok_or_else(|| {
                RomWeaverError::Validation("BSDIFF40 output offset overflowed".into())
            })?;
            delta_offset = delta_offset.checked_add(add_len).ok_or_else(|| {
                RomWeaverError::Validation("BSDIFF40 delta offset overflowed".into())
            })?;
        }

        if copy_len > 0 {
            writes.push(BsdiffWritePlan {
                output_offset,
                kind: BsdiffWritePlanKind::Copy {
                    extra_offset,
                    len: copy_len,
                },
            });
            output_offset = output_offset.checked_add(copy_len).ok_or_else(|| {
                RomWeaverError::Validation("BSDIFF40 output offset overflowed".into())
            })?;
            extra_offset = extra_offset.checked_add(copy_len).ok_or_else(|| {
                RomWeaverError::Validation("BSDIFF40 extra offset overflowed".into())
            })?;
        }

        source_offset = source_offset
            .checked_add(i128::from(seek))
            .ok_or_else(|| RomWeaverError::Validation("BSDIFF40 source seek overflowed".into()))?;
    }

    Ok((writes, delta_offset, extra_offset, output_offset))
}

fn prepare_bsdiff_writes_parallel(
    plans: &[BsdiffWritePlan],
    source: &Arc<SharedBlockCacheReader>,
    source_len: usize,
    delta_payload: &[u8],
    extra_payload: &[u8],
    pool: &SharedThreadPool,
    context: &OperationContext,
) -> Result<Vec<PreparedBsdiffWrite>> {
    pool_map(pool, plans, |plan| {
        context.cancel().check()?;
        let data = match &plan.kind {
            BsdiffWritePlanKind::Add {
                source_offset,
                delta_offset,
                len,
            } => {
                let delta_start = usize::try_from(*delta_offset).map_err(|_| {
                    RomWeaverError::Validation(
                        "BSDIFF40 delta offset exceeded addressable memory".into(),
                    )
                })?;
                let range_len = usize::try_from(*len).map_err(|_| {
                    RomWeaverError::Validation(
                        "BSDIFF40 segment length exceeded addressable memory".into(),
                    )
                })?;
                let delta_end = delta_start.checked_add(range_len).ok_or_else(|| {
                    RomWeaverError::Validation("BSDIFF40 delta range overflowed".into())
                })?;
                let delta_slice = delta_payload.get(delta_start..delta_end).ok_or_else(|| {
                    RomWeaverError::Validation("BSDIFF40 delta range exceeded patch bounds".into())
                })?;
                let mut data = delta_slice.to_vec();
                add_source_overlap_shared(source, source_len, *source_offset, data.as_mut_slice())?;
                data
            }
            BsdiffWritePlanKind::Copy { extra_offset, len } => {
                let extra_start = usize::try_from(*extra_offset).map_err(|_| {
                    RomWeaverError::Validation(
                        "BSDIFF40 extra offset exceeded addressable memory".into(),
                    )
                })?;
                let range_len = usize::try_from(*len).map_err(|_| {
                    RomWeaverError::Validation(
                        "BSDIFF40 segment length exceeded addressable memory".into(),
                    )
                })?;
                let extra_end = extra_start.checked_add(range_len).ok_or_else(|| {
                    RomWeaverError::Validation("BSDIFF40 extra range overflowed".into())
                })?;
                extra_payload
                    .get(extra_start..extra_end)
                    .ok_or_else(|| {
                        RomWeaverError::Validation(
                            "BSDIFF40 extra range exceeded patch bounds".into(),
                        )
                    })?
                    .to_vec()
            }
        };
        Ok(PreparedBsdiffWrite {
            output_offset: plan.output_offset,
            data,
        })
    })
}

fn prepare_bsdiff_writes_sequential(
    plans: &[BsdiffWritePlan],
    source_path: &Path,
    source_len: usize,
    delta_payload: &[u8],
    extra_payload: &[u8],
    context: &OperationContext,
) -> Result<Vec<PreparedBsdiffWrite>> {
    let mut source = BlockCacheReader::open(
        source_path,
        DEFAULT_BLOCK_CACHE_SIZE_BYTES,
        DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
    )?;
    plans
        .iter()
        .map(|plan| {
            context.cancel().check()?;
            prepare_bsdiff_write(plan, &mut source, source_len, delta_payload, extra_payload)
        })
        .collect()
}

fn prepare_bsdiff_write(
    plan: &BsdiffWritePlan,
    source: &mut BlockCacheReader,
    source_len: usize,
    delta_payload: &[u8],
    extra_payload: &[u8],
) -> Result<PreparedBsdiffWrite> {
    let data = match &plan.kind {
        BsdiffWritePlanKind::Add {
            source_offset,
            delta_offset,
            len,
        } => {
            let delta_start = usize::try_from(*delta_offset).map_err(|_| {
                RomWeaverError::Validation(
                    "BSDIFF40 delta offset exceeded addressable memory".into(),
                )
            })?;
            let range_len = usize::try_from(*len).map_err(|_| {
                RomWeaverError::Validation(
                    "BSDIFF40 segment length exceeded addressable memory".into(),
                )
            })?;
            let delta_end = delta_start.checked_add(range_len).ok_or_else(|| {
                RomWeaverError::Validation("BSDIFF40 delta range overflowed".into())
            })?;
            let delta_slice = delta_payload.get(delta_start..delta_end).ok_or_else(|| {
                RomWeaverError::Validation("BSDIFF40 delta range exceeded patch bounds".into())
            })?;
            let mut data = delta_slice.to_vec();
            add_source_overlap(source, source_len, *source_offset, data.as_mut_slice())?;
            data
        }
        BsdiffWritePlanKind::Copy { extra_offset, len } => {
            let extra_start = usize::try_from(*extra_offset).map_err(|_| {
                RomWeaverError::Validation(
                    "BSDIFF40 extra offset exceeded addressable memory".into(),
                )
            })?;
            let range_len = usize::try_from(*len).map_err(|_| {
                RomWeaverError::Validation(
                    "BSDIFF40 segment length exceeded addressable memory".into(),
                )
            })?;
            let extra_end = extra_start.checked_add(range_len).ok_or_else(|| {
                RomWeaverError::Validation("BSDIFF40 extra range overflowed".into())
            })?;
            extra_payload
                .get(extra_start..extra_end)
                .ok_or_else(|| {
                    RomWeaverError::Validation("BSDIFF40 extra range exceeded patch bounds".into())
                })?
                .to_vec()
        }
    };
    Ok(PreparedBsdiffWrite {
        output_offset: plan.output_offset,
        data,
    })
}

fn add_source_overlap_shared(
    source: &SharedBlockCacheReader,
    source_len: usize,
    source_offset: i128,
    data: &mut [u8],
) -> Result<()> {
    let Some((read_offset, data_offset, len)) =
        source_overlap(source_len, source_offset, data.len())?
    else {
        return Ok(());
    };
    let mut source_slice = vec![0u8; len];
    source.read_exact_at(read_offset, source_slice.as_mut_slice())?;
    add_source_slice(data, data_offset, source_slice.as_slice());
    Ok(())
}

fn add_source_overlap(
    source: &mut BlockCacheReader,
    source_len: usize,
    source_offset: i128,
    data: &mut [u8],
) -> Result<()> {
    let Some((read_offset, data_offset, len)) =
        source_overlap(source_len, source_offset, data.len())?
    else {
        return Ok(());
    };
    let mut source_slice = vec![0u8; len];
    source.read_exact_at(read_offset, source_slice.as_mut_slice())?;
    add_source_slice(data, data_offset, source_slice.as_slice());
    Ok(())
}

fn source_overlap(
    source_len: usize,
    source_offset: i128,
    data_len: usize,
) -> Result<Option<(u64, usize, usize)>> {
    if source_len == 0 || data_len == 0 {
        return Ok(None);
    }

    let source_len = i128::try_from(source_len).map_err(|_| {
        RomWeaverError::Validation("BSDIFF40 source exceeded addressable memory".into())
    })?;
    let data_len = i128::try_from(data_len).map_err(|_| {
        RomWeaverError::Validation("BSDIFF40 segment length exceeded addressable memory".into())
    })?;
    let source_end = source_offset
        .checked_add(data_len)
        .ok_or_else(|| RomWeaverError::Validation("BSDIFF40 source offset overflowed".into()))?;

    let overlap_start = source_offset.max(0);
    let overlap_end = source_end.min(source_len);
    if overlap_start >= overlap_end {
        return Ok(None);
    }

    let read_offset = u64::try_from(overlap_start).map_err(|_| {
        RomWeaverError::Validation("BSDIFF40 source offset exceeded addressable memory".into())
    })?;
    let data_offset = usize::try_from(overlap_start - source_offset).map_err(|_| {
        RomWeaverError::Validation("BSDIFF40 source overlap exceeded addressable memory".into())
    })?;
    let len = usize::try_from(overlap_end - overlap_start).map_err(|_| {
        RomWeaverError::Validation("BSDIFF40 source overlap exceeded addressable memory".into())
    })?;
    Ok(Some((read_offset, data_offset, len)))
}

fn add_source_slice(data: &mut [u8], data_offset: usize, source_slice: &[u8]) {
    for (data_byte, source_byte) in data[data_offset..].iter_mut().zip(source_slice.iter()) {
        *data_byte = data_byte.wrapping_add(*source_byte);
    }
}

fn apply_prepared_bsdiff_writes(output: &mut File, writes: &[PreparedBsdiffWrite]) -> Result<()> {
    for write in writes {
        if write.data.is_empty() {
            continue;
        }
        output.seek(SeekFrom::Start(write.output_offset))?;
        output.write_all(&write.data)?;
    }
    Ok(())
}

fn decompress_bzip_stream_exact(payload: &[u8], expected_len: u64) -> Result<Vec<u8>> {
    decode_bzip2_exact(payload, expected_len).map_err(|error| {
        RomWeaverError::Validation(format!("BSDIFF40 bzip2 payload decode failed: {error}"))
    })
}

fn decode_bsdiff_i64(bytes: &[u8]) -> Result<i64> {
    let value_bytes: [u8; 8] = bytes
        .try_into()
        .map_err(|_| RomWeaverError::Validation("BSDIFF40 i64 decode expected 8 bytes".into()))?;
    let value = u64::from_le_bytes(value_bytes);
    if value >> 63 == 0 || value == (1 << 63) {
        Ok(value as i64)
    } else {
        Ok(((value & ((1 << 63) - 1)) as i64).wrapping_neg())
    }
}

#[cfg(test)]
#[path = "../tests/unit/bdf.rs"]
mod tests;
/* jscpd:ignore-end */
