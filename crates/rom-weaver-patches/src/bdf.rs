use std::{
    fs::{self, File, OpenOptions},
    io::{BufWriter, Cursor, Read, Seek, SeekFrom, Write},
    path::Path,
};

use bzip2::read::BzDecoder;
use qbsdiff::{Bsdiff, Bspatch};
use rayon::prelude::*;
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationReport, PatchApplyRequest, PatchCapabilities,
    PatchCreateRequest, PatchHandler, Result, RomWeaverError, SharedThreadPool, ThreadCapability,
};

use crate::qbsdiff_support::{qbsdiff_parallel_scheme, qbsdiff_thread_capability};

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
            let patch_bytes = crate::map_file_read_only(patch_path)?;
            let patcher = Bspatch::new(patch_bytes.as_ref())?;
            Ok(build_bdf_parse_label(
                self.descriptor.name,
                patcher.hint_target_size(),
            ))
        })
    }

    fn apply_report(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let patch_path = crate::require_single_patch_file(&request.patches, self.descriptor.name)?;
        let patch_bytes = crate::map_file_read_only(patch_path)?;
        let patcher = Bspatch::new(patch_bytes.as_ref())?;

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let thread_capability = qbsdiff_apply_thread_capability(patcher.hint_target_size());
        let planned_execution = context.plan_threads(thread_capability.clone());
        let execution = if planned_execution.used_parallelism {
            let (execution, pool) = context.build_pool(thread_capability)?;
            if execution.used_parallelism {
                let input = crate::map_file_read_only(&request.input)?;
                let plan = parse_bsdiff_parallel_plan(patch_bytes.as_ref(), input.len())?;
                let mut output = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .open(&request.output)?;
                output.set_len(plan.output_len)?;
                let writes = prepare_bsdiff_writes_parallel(
                    &plan.writes,
                    input.as_ref(),
                    &plan.delta_payload,
                    &plan.extra_payload,
                    &pool,
                    context,
                )?;
                apply_prepared_bsdiff_writes(&mut output, &writes)?;
                output.flush()?;
                execution
            } else {
                apply_bspatch_serial(patch_bytes.as_ref(), &request.input, &request.output)?;
                execution
            }
        } else {
            apply_bspatch_serial(patch_bytes.as_ref(), &request.input, &request.output)?;
            planned_execution
        };
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
        let source = crate::map_file_read_only(&request.original)?;
        if source.len() > qbsdiff::bsdiff::MAX_LENGTH {
            return Err(RomWeaverError::Validation(format!(
                "BSDIFF40 source exceeds maximum supported size of {} byte(s)",
                qbsdiff::bsdiff::MAX_LENGTH
            )));
        }
        let target = crate::map_file_read_only(&request.modified)?;
        let (execution, pool) = context.build_pool(qbsdiff_thread_capability(target.len()))?;
        let parallel_scheme = qbsdiff_parallel_scheme(target.len());

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let patch_file = File::create(&request.output)?;
        let mut patch = BufWriter::new(patch_file);
        pool.install(|| {
            Bsdiff::new(source.as_ref(), target.as_ref())
                .parallel_scheme(parallel_scheme)
                .compare(&mut patch)
        })?;
        patch.flush()?;
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
struct BsdiffPatchLayout<'a> {
    control_block: &'a [u8],
    delta_block: &'a [u8],
    extra_block: &'a [u8],
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

fn apply_bspatch_serial(patch_bytes: &[u8], input_path: &Path, output_path: &Path) -> Result<()> {
    let patcher = Bspatch::new(patch_bytes)?;
    let input = crate::map_file_read_only(input_path)?;
    let output_file = File::create(output_path)?;
    let mut output = BufWriter::new(output_file);
    patcher.apply(input.as_ref(), &mut output)?;
    output.flush()?;
    Ok(())
}

fn parse_bsdiff_parallel_plan(
    patch_bytes: &[u8],
    source_len: usize,
) -> Result<ParsedBsdiffParallelPlan> {
    let layout = parse_bsdiff_patch_layout(patch_bytes)?;
    let (writes, delta_len, extra_len, output_len) =
        collect_bsdiff_write_plans(layout.control_block, source_len)?;
    let delta_payload = decompress_bzip_stream_exact(layout.delta_block, delta_len)?;
    let extra_payload = decompress_bzip_stream_exact(layout.extra_block, extra_len)?;
    Ok(ParsedBsdiffParallelPlan {
        writes,
        delta_payload,
        extra_payload,
        output_len,
    })
}

fn parse_bsdiff_patch_layout(patch_bytes: &[u8]) -> Result<BsdiffPatchLayout<'_>> {
    if patch_bytes.len() < BSDIFF40_HEADER_BYTES || &patch_bytes[..8] != BSDIFF40_MAGIC {
        return Err(RomWeaverError::Validation("not a valid patch".into()));
    }

    let control_compressed_len = decode_bsdiff_i64(&patch_bytes[8..16])?
        .try_into()
        .map_err(|_| RomWeaverError::Validation("patch corrupted".into()))?;
    let delta_compressed_len = decode_bsdiff_i64(&patch_bytes[16..24])?
        .try_into()
        .map_err(|_| RomWeaverError::Validation("patch corrupted".into()))?;
    let control_end = BSDIFF40_HEADER_BYTES
        .checked_add(control_compressed_len)
        .ok_or_else(|| RomWeaverError::Validation("patch corrupted".into()))?;
    let delta_end = control_end
        .checked_add(delta_compressed_len)
        .ok_or_else(|| RomWeaverError::Validation("patch corrupted".into()))?;
    if delta_end > patch_bytes.len() {
        return Err(RomWeaverError::Validation("patch corrupted".into()));
    }

    Ok(BsdiffPatchLayout {
        control_block: &patch_bytes[BSDIFF40_HEADER_BYTES..control_end],
        delta_block: &patch_bytes[control_end..delta_end],
        extra_block: &patch_bytes[delta_end..],
    })
}

fn collect_bsdiff_write_plans(
    compressed_control_block: &[u8],
    source_len: usize,
) -> Result<(Vec<BsdiffWritePlan>, u64, u64, u64)> {
    let mut decoder = BzDecoder::new(Cursor::new(compressed_control_block));
    let source_len = i128::try_from(source_len).map_err(|_| {
        RomWeaverError::Validation("BSDIFF40 source exceeded addressable memory".into())
    })?;

    let mut control = [0u8; BSDIFF40_CONTROL_BYTES];
    let mut writes = Vec::new();
    let mut source_offset = 0i128;
    let mut output_offset = 0u64;
    let mut delta_offset = 0u64;
    let mut extra_offset = 0u64;

    loop {
        let read = read_exact_or_eof(&mut decoder, &mut control)?;
        if read == 0 {
            break;
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
    source: &[u8],
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
                        let source_start = usize::try_from(*source_offset).map_err(|_| {
                            RomWeaverError::Validation(
                                "BSDIFF40 source offset exceeded addressable memory".into(),
                            )
                        })?;
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
                        let source_end = source_start.checked_add(range_len).ok_or_else(|| {
                            RomWeaverError::Validation("BSDIFF40 source range overflowed".into())
                        })?;
                        let delta_end = delta_start.checked_add(range_len).ok_or_else(|| {
                            RomWeaverError::Validation("BSDIFF40 delta range overflowed".into())
                        })?;
                        let source_slice =
                            source.get(source_start..source_end).ok_or_else(|| {
                                RomWeaverError::Validation(
                                    "BSDIFF40 source range exceeded input bounds".into(),
                                )
                            })?;
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
    let expected_len = usize::try_from(expected_len).map_err(|_| {
        RomWeaverError::Validation("BSDIFF40 payload exceeded addressable memory".into())
    })?;
    let mut decoder = BzDecoder::new(Cursor::new(payload));
    let mut output = vec![0u8; expected_len];
    decoder.read_exact(&mut output)?;
    Ok(output)
}

fn read_exact_or_eof<R: Read>(reader: &mut R, buffer: &mut [u8]) -> Result<usize> {
    let mut read = 0usize;
    while read < buffer.len() {
        match reader.read(&mut buffer[read..]) {
            Ok(0) => break,
            Ok(count) => read += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error.into()),
        }
    }

    if read != 0 && read != buffer.len() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "failed to fill whole buffer",
        )
        .into());
    }
    Ok(read)
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
mod tests {
    use std::{fs, path::PathBuf};

    use rom_weaver_core::{PatchApplyRequest, PatchCreateRequest, PatchHandler};

    use super::BdfPatchHandler;
    use crate::{
        BDF_BSDIFF40,
        test_support::{TestDir, test_context_with_threads},
    };

    fn bdf_fixture_paths(temp: &TestDir) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        (
            temp.child("source.bin"),
            temp.child("target.bin"),
            temp.child("update.bdf"),
            temp.child("output.bin"),
        )
    }

    #[test]
    fn parse_rejects_invalid_patch_header() {
        let temp = TestDir::new();
        let patch_path = temp.child("broken.bdf");
        fs::write(&patch_path, b"not-a-valid-patch").expect("fixture");

        let handler = BdfPatchHandler::new(&BDF_BSDIFF40);
        let error = handler
            .parse(&patch_path, &test_context_with_threads(&temp, 1))
            .expect_err("parse should fail");
        assert!(error.to_string().contains("not a valid patch"));
    }

    #[test]
    fn create_and_apply_round_trip() {
        let temp = TestDir::new();
        let (source_path, target_path, patch_path, output_path) = bdf_fixture_paths(&temp);

        let source = b"The quick brown fox jumps over the lazy dog.";
        let target = b"The quick brown cat jumps over two lazy dogs!";
        fs::write(&source_path, source).expect("fixture");
        fs::write(&target_path, target).expect("fixture");

        let handler = BdfPatchHandler::new(&BDF_BSDIFF40);
        let create_report = handler
            .create(
                &PatchCreateRequest {
                    original: source_path.clone(),
                    modified: target_path.clone(),
                    output: patch_path.clone(),
                    format: "BDF/BSDIFF40".into(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("create");

        let execution = create_report.thread_execution.expect("thread execution");
        assert_eq!(execution.requested_threads, 8);
        assert_eq!(execution.effective_threads, 1);
        assert!(!execution.used_parallelism);

        let patch_bytes = fs::read(&patch_path).expect("patch");
        assert_eq!(&patch_bytes[..8], b"BSDIFF40");

        handler
            .apply(
                &PatchApplyRequest {
                    input: source_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("apply");

        assert_eq!(fs::read(output_path).expect("output"), target);
    }

    #[test]
    fn apply_rejects_multiple_patch_files() {
        let temp = TestDir::new();
        let (source_path, target_path, patch_path, output_path) = bdf_fixture_paths(&temp);

        fs::write(&source_path, b"abc").expect("fixture");
        fs::write(&target_path, b"abZ").expect("fixture");

        let handler = BdfPatchHandler::new(&BDF_BSDIFF40);
        handler
            .create(
                &PatchCreateRequest {
                    original: source_path.clone(),
                    modified: target_path,
                    output: patch_path.clone(),
                    format: "BDF/BSDIFF40".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("create");

        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: source_path,
                    patches: vec![patch_path.clone(), patch_path],
                    output: output_path,
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect_err("apply should fail");

        assert!(error.to_string().contains("expects exactly one patch file"));
    }

    #[test]
    fn create_is_deterministic_across_thread_budgets() {
        let temp = TestDir::new();
        let source_path = temp.child("source-large.bin");
        let target_path = temp.child("target-large.bin");
        let patch_single = temp.child("single-thread.bdf");
        let patch_parallel = temp.child("parallel-thread.bdf");

        let source = build_large_fixture_bytes();
        let mut target = source.clone();
        for index in (0..target.len()).step_by(4096) {
            target[index] = target[index].wrapping_add(17);
        }
        fs::write(&source_path, &source).expect("fixture");
        fs::write(&target_path, &target).expect("fixture");

        let handler = BdfPatchHandler::new(&BDF_BSDIFF40);
        let single_report = handler
            .create(
                &PatchCreateRequest {
                    original: source_path.clone(),
                    modified: target_path.clone(),
                    output: patch_single.clone(),
                    format: "bdf".into(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("single-thread create");
        let parallel_report = handler
            .create(
                &PatchCreateRequest {
                    original: source_path,
                    modified: target_path,
                    output: patch_parallel.clone(),
                    format: "bdf".into(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("parallel create");

        let single_execution = single_report
            .thread_execution
            .expect("single-thread execution");
        assert_eq!(single_execution.effective_threads, 1);
        assert!(!single_execution.used_parallelism);
        let parallel_execution = parallel_report
            .thread_execution
            .expect("parallel-thread execution");
        assert_eq!(parallel_execution.requested_threads, 8);
        assert_eq!(parallel_execution.effective_threads, 8);
        assert!(parallel_execution.used_parallelism);

        let single_patch = fs::read(&patch_single).expect("single-thread patch");
        let parallel_patch = fs::read(&patch_parallel).expect("parallel-thread patch");
        assert_eq!(single_patch, parallel_patch);
    }

    #[test]
    fn apply_is_deterministic_across_thread_budgets() {
        let temp = TestDir::new();
        let source_path = temp.child("source-apply.bin");
        let target_path = temp.child("target-apply.bin");
        let patch_path = temp.child("update-apply.bdf");
        let single_output = temp.child("single-output.bin");
        let parallel_output = temp.child("parallel-output.bin");

        let source = build_large_fixture_bytes();
        let mut target = source.clone();
        for index in (0..target.len()).step_by(3071) {
            target[index] = target[index].wrapping_add(33);
        }
        fs::write(&source_path, &source).expect("source fixture");
        fs::write(&target_path, &target).expect("target fixture");

        let handler = BdfPatchHandler::new(&BDF_BSDIFF40);
        handler
            .create(
                &PatchCreateRequest {
                    original: source_path.clone(),
                    modified: target_path,
                    output: patch_path.clone(),
                    format: "bdf".into(),
                },
                &test_context_with_threads(&temp, 8),
            )
            .expect("create");

        let single_report = handler
            .apply(
                &PatchApplyRequest {
                    input: source_path.clone(),
                    patches: vec![patch_path.clone()],
                    output: single_output.clone(),
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect("single apply");
        let parallel_report = handler
            .apply(
                &PatchApplyRequest {
                    input: source_path,
                    patches: vec![patch_path],
                    output: parallel_output.clone(),
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
        let parallel_execution = parallel_report
            .thread_execution
            .expect("parallel execution");
        assert_eq!(parallel_execution.requested_threads, 8);
        assert!(parallel_execution.used_parallelism);
        assert_eq!(fs::read(single_output).expect("single output"), target);
        assert_eq!(fs::read(parallel_output).expect("parallel output"), target);
    }

    fn build_large_fixture_bytes() -> Vec<u8> {
        let mut bytes = vec![0u8; 512 * 1024];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = (index % 251) as u8;
        }
        bytes
    }
}
