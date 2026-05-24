use std::{
    fs::{self, File, OpenOptions},
    io::{BufWriter, Cursor, Read, Seek, SeekFrom, Write},
    path::Path,
    sync::Arc,
};

use bzip2::{Compression, read::MultiBzDecoder, write::BzEncoder};
use rayon::prelude::*;
use rom_weaver_codecs::decode_bzip2_exact;
use rom_weaver_core::{
    BlockCacheReader, ChunkPlanner, DEFAULT_BLOCK_CACHE_MAX_BLOCKS, DEFAULT_BLOCK_CACHE_SIZE_BYTES,
    DEFAULT_CHUNK_SIZE_BYTES, FormatDescriptor, OperationContext, OperationReport,
    PatchApplyRequest, PatchCapabilities, PatchCreateRequest, PatchHandler, Result, RomWeaverError,
    SharedBlockCacheReader, SharedThreadPool, ThreadCapability,
};

use crate::qbsdiff_support::qbsdiff_thread_capability;

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

    /* jscpd:ignore-start */
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
    /* jscpd:ignore-end */
}

impl PatchHandler for BdfPatchHandler {
    /* jscpd:ignore-start */
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
    /* jscpd:ignore-end */

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

        pool.install(|| create_streaming_bsdiff_patch(request, context))?;
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
        source_offset: u64,
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

fn create_streaming_bsdiff_patch(
    request: &PatchCreateRequest,
    context: &OperationContext,
) -> Result<()> {
    let source_len = fs::metadata(&request.original)?.len();
    let target_len = fs::metadata(&request.modified)?.len();
    let common_len = source_len.min(target_len);

    let control_path = context
        .temp_paths()
        .next_path("bdf-create-control", Some("bz2"));
    let delta_path = context
        .temp_paths()
        .next_path("bdf-create-delta", Some("bz2"));
    let extra_path = context
        .temp_paths()
        .next_path("bdf-create-extra", Some("bz2"));
    for path in [&control_path, &delta_path, &extra_path] {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
    }

    let encode_result = (|| -> Result<()> {
        let mut control_encoder = BzEncoder::new(
            BufWriter::new(File::create(&control_path)?),
            Compression::new(6),
        );
        let mut delta_encoder = BzEncoder::new(
            BufWriter::new(File::create(&delta_path)?),
            Compression::new(6),
        );
        let mut extra_encoder = BzEncoder::new(
            BufWriter::new(File::create(&extra_path)?),
            Compression::new(6),
        );

        let planner = ChunkPlanner::new(DEFAULT_CHUNK_SIZE_BYTES)?;
        let mut source_reader = BlockCacheReader::open(
            &request.original,
            DEFAULT_BLOCK_CACHE_SIZE_BYTES,
            DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
        )?;
        let mut target_reader = BlockCacheReader::open(
            &request.modified,
            DEFAULT_BLOCK_CACHE_SIZE_BYTES,
            DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
        )?;

        for chunk in planner.plan(common_len) {
            context.cancel().check()?;
            let chunk_len_usize = usize::try_from(chunk.len).map_err(|_| {
                RomWeaverError::Validation(
                    "BSDIFF40 chunk length exceeded addressable memory".into(),
                )
            })?;
            write_bsdiff_i64(
                &mut control_encoder,
                u64_to_bsdiff_i64(chunk.len, "chunk add length")?,
            )?;
            write_bsdiff_i64(&mut control_encoder, 0)?;
            write_bsdiff_i64(&mut control_encoder, 0)?;

            let mut source_bytes = vec![0u8; chunk_len_usize];
            source_reader.read_exact_at(chunk.offset, source_bytes.as_mut_slice())?;
            let mut target_bytes = vec![0u8; chunk_len_usize];
            target_reader.read_exact_at(chunk.offset, target_bytes.as_mut_slice())?;
            for (target_byte, source_byte) in target_bytes.iter_mut().zip(source_bytes.iter()) {
                *target_byte = target_byte.wrapping_sub(*source_byte);
            }
            delta_encoder.write_all(target_bytes.as_slice())?;
        }

        if target_len > common_len {
            let tail_len = target_len - common_len;
            write_bsdiff_i64(&mut control_encoder, 0)?;
            write_bsdiff_i64(
                &mut control_encoder,
                u64_to_bsdiff_i64(tail_len, "tail copy length")?,
            )?;
            write_bsdiff_i64(&mut control_encoder, 0)?;

            for chunk in planner.plan(tail_len) {
                context.cancel().check()?;
                let chunk_len_usize = usize::try_from(chunk.len).map_err(|_| {
                    RomWeaverError::Validation(
                        "BSDIFF40 tail chunk length exceeded addressable memory".into(),
                    )
                })?;
                let mut target_tail = vec![0u8; chunk_len_usize];
                target_reader.read_exact_at(
                    common_len.checked_add(chunk.offset).ok_or_else(|| {
                        RomWeaverError::Validation("BSDIFF40 tail chunk offset overflowed".into())
                    })?,
                    target_tail.as_mut_slice(),
                )?;
                extra_encoder.write_all(target_tail.as_slice())?;
            }
        }

        let mut control_writer = control_encoder.finish()?;
        control_writer.flush()?;
        let mut delta_writer = delta_encoder.finish()?;
        delta_writer.flush()?;
        let mut extra_writer = extra_encoder.finish()?;
        extra_writer.flush()?;
        Ok(())
    })();

    let patch_result = (|| -> Result<()> {
        encode_result?;
        let control_len = fs::metadata(&control_path)?.len();
        let delta_len = fs::metadata(&delta_path)?.len();
        let mut patch_writer = BufWriter::new(File::create(&request.output)?);
        patch_writer.write_all(BSDIFF40_MAGIC)?;
        write_bsdiff_i64(
            &mut patch_writer,
            u64_to_bsdiff_i64(control_len, "control payload length")?,
        )?;
        write_bsdiff_i64(
            &mut patch_writer,
            u64_to_bsdiff_i64(delta_len, "delta payload length")?,
        )?;
        write_bsdiff_i64(
            &mut patch_writer,
            u64_to_bsdiff_i64(target_len, "target length")?,
        )?;

        for segment_path in [&control_path, &delta_path, &extra_path] {
            let mut segment = File::open(segment_path)?;
            std::io::copy(&mut segment, &mut patch_writer)?;
        }
        patch_writer.flush()?;
        Ok(())
    })();

    let _ = fs::remove_file(&control_path);
    let _ = fs::remove_file(&delta_path);
    let _ = fs::remove_file(&extra_path);
    patch_result
}

fn write_bsdiff_i64(output: &mut impl Write, value: i64) -> Result<()> {
    output.write_all(&encode_bsdiff_i64(value))?;
    Ok(())
}

fn encode_bsdiff_i64(value: i64) -> [u8; 8] {
    let mut bytes = value.unsigned_abs().to_le_bytes();
    if value < 0 {
        bytes[7] |= 0x80;
    }
    bytes
}

fn u64_to_bsdiff_i64(value: u64, label: &str) -> Result<i64> {
    i64::try_from(value)
        .map_err(|_| RomWeaverError::Validation(format!("BSDIFF40 {label} overflowed i64")))
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
    source_len: usize,
) -> Result<(Vec<BsdiffWritePlan>, u64, u64, u64)> {
    let mut control_decoder = MultiBzDecoder::new(Cursor::new(compressed_control_block));
    let source_len = i128::try_from(source_len).map_err(|_| {
        RomWeaverError::Validation("BSDIFF40 source exceeded addressable memory".into())
    })?;

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
            if source_start < 0 || source_end > source_len {
                return Err(RomWeaverError::Validation(
                    "BSDIFF40 patch add range exceeded source bounds".into(),
                ));
            }
            writes.push(BsdiffWritePlan {
                output_offset,
                kind: BsdiffWritePlanKind::Add {
                    source_offset: u64::try_from(source_start).map_err(|_| {
                        RomWeaverError::Validation(
                            "BSDIFF40 source offset exceeded addressable memory".into(),
                        )
                    })?,
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
        if source_offset < 0 {
            return Err(RomWeaverError::Validation(
                "BSDIFF40 source seek moved before the start of input".into(),
            ));
        }
    }

    Ok((writes, delta_offset, extra_offset, output_offset))
}

fn prepare_bsdiff_writes_parallel(
    plans: &[BsdiffWritePlan],
    source: &Arc<SharedBlockCacheReader>,
    delta_payload: &[u8],
    extra_payload: &[u8],
    pool: &SharedThreadPool,
    context: &OperationContext,
) -> Result<Vec<PreparedBsdiffWrite>> {
    pool.install(|| {
        plans
            .par_iter()
            .map(|plan| {
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
                        let mut source_slice = vec![0u8; range_len];
                        source.read_exact_at(*source_offset, &mut source_slice)?;
                        let delta_slice =
                            delta_payload.get(delta_start..delta_end).ok_or_else(|| {
                                RomWeaverError::Validation(
                                    "BSDIFF40 delta range exceeded patch bounds".into(),
                                )
                            })?;
                        source_slice
                            .iter()
                            .zip(delta_slice.iter())
                            .map(|(source_byte, delta_byte)| source_byte.wrapping_add(*delta_byte))
                            .collect()
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
            .collect::<Result<Vec<_>>>()
    })
}

fn prepare_bsdiff_writes_sequential(
    plans: &[BsdiffWritePlan],
    source_path: &Path,
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
            prepare_bsdiff_write(plan, &mut source, delta_payload, extra_payload)
        })
        .collect()
}

fn prepare_bsdiff_write(
    plan: &BsdiffWritePlan,
    source: &mut BlockCacheReader,
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
            let mut source_slice = vec![0u8; range_len];
            source.read_exact_at(*source_offset, &mut source_slice)?;
            let delta_slice = delta_payload.get(delta_start..delta_end).ok_or_else(|| {
                RomWeaverError::Validation("BSDIFF40 delta range exceeded patch bounds".into())
            })?;
            source_slice
                .iter()
                .zip(delta_slice.iter())
                .map(|(source_byte, delta_byte)| source_byte.wrapping_add(*delta_byte))
                .collect()
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
