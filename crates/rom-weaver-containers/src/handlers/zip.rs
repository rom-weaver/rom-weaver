/* jscpd:ignore-start */
use super::*;
use tracing::debug;

#[derive(Clone, Copy, Debug)]
pub(crate) enum ZipContainerFlavor {
    Zip,
    Zipx,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ZipCompressionMethod {
    Stored,
    Deflated,
    Zstd,
}

pub(crate) struct ZipContainerHandler {
    descriptor: &'static FormatDescriptor,
    flavor: ZipContainerFlavor,
}

impl ZipContainerHandler {
    const SUPPORTED_CODECS: &[&str] = &["store", "deflate", "zstd"];
    const ZSTD_LEVEL_MIN: i32 = -7;
    const ZSTD_LEVEL_MAX: i32 = 22;

    pub(crate) const fn new(
        descriptor: &'static FormatDescriptor,
        flavor: ZipContainerFlavor,
    ) -> Self {
        Self { descriptor, flavor }
    }

    fn parse_codec(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
    ) -> Result<(ZipCompressionMethod, Option<i32>)> {
        let default_codec = match self.flavor {
            ZipContainerFlavor::Zip => "deflate",
            ZipContainerFlavor::Zipx => "zstd",
        };
        let method = match resolve_create_codec(
            self.descriptor.name,
            codec,
            Self::SUPPORTED_CODECS,
            default_codec,
        )? {
            "store" => ZipCompressionMethod::Stored,
            "deflate" => ZipCompressionMethod::Deflated,
            "zstd" => ZipCompressionMethod::Zstd,
            _ => unreachable!("validated zip create codec"),
        };

        if let Some(level) = level {
            let in_range = match method {
                ZipCompressionMethod::Stored => false,
                ZipCompressionMethod::Deflated => (0..=9).contains(&level),
                ZipCompressionMethod::Zstd => (-7..=22).contains(&level),
            };
            if !in_range {
                return Err(RomWeaverError::Validation(format!(
                    "level `{level}` is invalid for {} codec `{}`",
                    self.descriptor.name,
                    self.method_name(method)
                )));
            }
        }

        if method == ZipCompressionMethod::Stored && level.is_some() {
            return Err(RomWeaverError::Validation(format!(
                "{} codec `store` does not accept --level",
                self.descriptor.name
            )));
        }

        Ok((method, level))
    }

    fn method_name(&self, method: ZipCompressionMethod) -> &'static str {
        match method {
            ZipCompressionMethod::Stored => "store",
            ZipCompressionMethod::Deflated => "deflate",
            ZipCompressionMethod::Zstd => "zstd",
        }
    }

    fn libarchive_method_name(&self, method: ZipCompressionMethod) -> Option<&'static str> {
        match method {
            ZipCompressionMethod::Stored => Some("store"),
            ZipCompressionMethod::Deflated => Some("deflate"),
            ZipCompressionMethod::Zstd => Some("zstd"),
        }
    }

    fn libarchive_level(&self, method: ZipCompressionMethod, level: Option<i32>) -> Option<i32> {
        match method {
            ZipCompressionMethod::Deflated => level,
            ZipCompressionMethod::Zstd => level.map(Self::map_zstd_level_to_zip_level),
            _ => None,
        }
    }

    fn libarchive_threads(
        &self,
        method: ZipCompressionMethod,
        execution: &ThreadExecution,
    ) -> Option<usize> {
        match method {
            ZipCompressionMethod::Stored
            | ZipCompressionMethod::Deflated
            | ZipCompressionMethod::Zstd => Some(execution.effective_threads.max(1)),
        }
    }

    fn create_thread_capability(
        &self,
        method: ZipCompressionMethod,
        total_bytes: u64,
        level: Option<i32>,
    ) -> ThreadCapability {
        match method {
            ZipCompressionMethod::Zstd => {
                let level = zstd_planning_level(level);
                let achievable = zstd_achievable_jobs(total_bytes, level)
                    .min(zstd_memory_thread_cap(total_bytes, level))
                    .max(1);
                ThreadCapability::parallel(Some(achievable))
            }
            _ => ThreadCapability::parallel(None),
        }
    }

    fn libarchive_io_buffer_bytes(method: ZipCompressionMethod) -> usize {
        match method {
            ZipCompressionMethod::Zstd => LIBARCHIVE_CREATE_ZSTD_IO_BUFFER_BYTES,
            _ => LIBARCHIVE_CREATE_IO_BUFFER_BYTES,
        }
    }

    pub(crate) fn map_zstd_level_to_zip_level(level: i32) -> i32 {
        level.clamp(Self::ZSTD_LEVEL_MIN, Self::ZSTD_LEVEL_MAX)
    }

    fn create_with_libarchive(
        &self,
        request: &ContainerCreateRequest,
        entries: &[ArchiveInputEntry],
        method: ZipCompressionMethod,
        level: Option<i32>,
        context: &OperationContext,
    ) -> Result<(u64, ThreadExecution)> {
        let total_bytes = sum_input_file_bytes(entries);
        let execution =
            context.plan_threads(self.create_thread_capability(method, total_bytes, level));
        debug!(
            format = self.descriptor.name,
            method = self.method_name(method),
            level,
            entries = entries.len(),
            total_bytes,
            effective_threads = execution.effective_threads,
            "zip create start"
        );

        let method_name = self.libarchive_method_name(method).ok_or_else(|| {
            RomWeaverError::Unsupported(UnsupportedOp::LibarchiveCodec {
                format: self.descriptor.name.to_string(),
                codec: self.method_name(method).to_string(),
            })
        })?;
        let logical_bytes = write_archive_with_libarchive(
            request,
            entries,
            context,
            &execution,
            LibarchiveCreateConfig {
                format_name: self.descriptor.name,
                format: LibarchiveCreateFormat::Zip,
                filter: LibarchiveCreateFilter::None,
                format_compression: Some(method_name),
                compression_level: self.libarchive_level(method, level),
                format_threads: self.libarchive_threads(method, &execution),
                filter_threads: None,
                io_buffer_bytes: Self::libarchive_io_buffer_bytes(method),
            },
        )?;
        Ok((logical_bytes, execution))
    }
}

#[derive(Clone, Copy)]
struct ZstdCompressionParams {
    window_log: u32,
    chain_log: u32,
    hash_log: u32,
    strategy: ZstdStrategy,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum ZstdStrategy {
    Fast,
    Dfast,
    Greedy,
    Lazy,
    Lazy2,
    BtLazy2,
    BtOpt,
    BtUltra,
    BtUltra2,
}

const ZSTD_MT_SPLIT_THRESHOLD_BYTES: u64 = 4 << 20;
const ZSTD_MT_JOB_SIZE_MIN_BYTES: u64 = 1 << 20;
const ZSTD_MT_JOB_LOG_MAX: u32 = 30;
const ZSTD_MT_OVERLAP_LOG: i32 = 6;
const ZSTD_WORKSPACE_WORD_BYTES: u64 = std::mem::size_of::<u32>() as u64;

fn zstd_planning_level(level: Option<i32>) -> i32 {
    level.unwrap_or(zstd::zstd_safe::CLEVEL_DEFAULT).clamp(
        ZipContainerHandler::ZSTD_LEVEL_MIN,
        ZipContainerHandler::ZSTD_LEVEL_MAX,
    )
}

fn zstd_achievable_jobs(total_bytes: u64, level: i32) -> usize {
    if total_bytes <= ZSTD_MT_SPLIT_THRESHOLD_BYTES {
        return 1;
    }
    let params = zstd_adjusted_params(total_bytes, level);
    let job_size = zstd_mt_job_size_bytes(&params);
    usize::try_from(total_bytes.div_ceil(job_size).max(1)).unwrap_or(usize::MAX)
}

fn zstd_memory_thread_cap(total_bytes: u64, level: i32) -> usize {
    // Match 7z's model: browser/wasm budgets are a slice of the fixed shared
    // linear-memory ceiling, not available system RAM.
    #[cfg(target_family = "wasm")]
    const FALLBACK_BUDGET_BYTES: u64 = 1024 * 1024 * 1024;
    #[cfg(not(target_family = "wasm"))]
    const FALLBACK_BUDGET_BYTES: u64 = 2 * 1024 * 1024 * 1024;
    let budget = std::env::var("ROM_WEAVER_ZIP_ZSTD_MEM_BUDGET_MB")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(|mb| mb.saturating_mul(1024 * 1024))
        .or_else(|| physical_memory_bytes().map(|ram| ram / 2))
        .unwrap_or(FALLBACK_BUDGET_BYTES);
    zstd_threads_for_budget(total_bytes, level, budget)
}

pub(crate) fn zstd_threads_for_budget(total_bytes: u64, level: i32, budget_bytes: u64) -> usize {
    let achievable = zstd_achievable_jobs(total_bytes, level);
    if achievable <= 1 {
        return 1;
    }

    let params = zstd_adjusted_params(total_bytes, level);
    let single_worker = zstd_single_worker_bytes(total_bytes, &params);
    if budget_bytes <= single_worker {
        return 1;
    }

    let job_size = zstd_mt_job_size_bytes(&params);
    let slack_jobs = if zstd_mt_overlap_bytes(&params) > 0 {
        3
    } else {
        2
    };
    let fixed_mt_bytes = job_size
        .saturating_mul(slack_jobs)
        .saturating_add(8 * 1024 * 1024);
    if budget_bytes <= fixed_mt_bytes {
        return 1;
    }

    let per_worker = single_worker.saturating_add(job_size).max(1);
    let workers = (budget_bytes - fixed_mt_bytes) / per_worker;
    usize::try_from(workers.max(1))
        .unwrap_or(usize::MAX)
        .min(achievable)
}

fn zstd_adjusted_params(total_bytes: u64, level: i32) -> ZstdCompressionParams {
    let mut params = zstd_large_source_params(level);
    if total_bytes > 0 {
        let src_log = ceil_log2_u64(total_bytes).max(10);
        params.window_log = params.window_log.min(src_log);
        let dict_and_window_log = params.window_log;
        params.hash_log = params.hash_log.min(dict_and_window_log + 1);
        let cycle_log = zstd_cycle_log(params.chain_log, params.strategy);
        if cycle_log > dict_and_window_log {
            params.chain_log -= cycle_log - dict_and_window_log;
        }
    }
    params.window_log = params.window_log.max(10);
    params
}

fn zstd_large_source_params(level: i32) -> ZstdCompressionParams {
    use ZstdStrategy::{BtLazy2, BtOpt, BtUltra, BtUltra2, Dfast, Fast, Greedy, Lazy, Lazy2};
    let level = if level == 0 {
        zstd::zstd_safe::CLEVEL_DEFAULT
    } else {
        level
    };
    let row = if level < 0 {
        0
    } else {
        usize::try_from(level.clamp(0, ZipContainerHandler::ZSTD_LEVEL_MAX)).unwrap_or(0)
    };
    const LARGE_SOURCE_PARAMS: [ZstdCompressionParams; 23] = [
        ZstdCompressionParams {
            window_log: 19,
            chain_log: 12,
            hash_log: 13,
            strategy: Fast,
        },
        ZstdCompressionParams {
            window_log: 19,
            chain_log: 13,
            hash_log: 14,
            strategy: Fast,
        },
        ZstdCompressionParams {
            window_log: 20,
            chain_log: 15,
            hash_log: 16,
            strategy: Fast,
        },
        ZstdCompressionParams {
            window_log: 21,
            chain_log: 16,
            hash_log: 17,
            strategy: Dfast,
        },
        ZstdCompressionParams {
            window_log: 21,
            chain_log: 18,
            hash_log: 18,
            strategy: Dfast,
        },
        ZstdCompressionParams {
            window_log: 21,
            chain_log: 18,
            hash_log: 19,
            strategy: Greedy,
        },
        ZstdCompressionParams {
            window_log: 21,
            chain_log: 18,
            hash_log: 19,
            strategy: Lazy,
        },
        ZstdCompressionParams {
            window_log: 21,
            chain_log: 19,
            hash_log: 20,
            strategy: Lazy,
        },
        ZstdCompressionParams {
            window_log: 21,
            chain_log: 19,
            hash_log: 20,
            strategy: Lazy2,
        },
        ZstdCompressionParams {
            window_log: 22,
            chain_log: 20,
            hash_log: 21,
            strategy: Lazy2,
        },
        ZstdCompressionParams {
            window_log: 22,
            chain_log: 21,
            hash_log: 22,
            strategy: Lazy2,
        },
        ZstdCompressionParams {
            window_log: 22,
            chain_log: 21,
            hash_log: 22,
            strategy: Lazy2,
        },
        ZstdCompressionParams {
            window_log: 22,
            chain_log: 22,
            hash_log: 23,
            strategy: Lazy2,
        },
        ZstdCompressionParams {
            window_log: 22,
            chain_log: 22,
            hash_log: 22,
            strategy: BtLazy2,
        },
        ZstdCompressionParams {
            window_log: 22,
            chain_log: 22,
            hash_log: 23,
            strategy: BtLazy2,
        },
        ZstdCompressionParams {
            window_log: 22,
            chain_log: 23,
            hash_log: 23,
            strategy: BtLazy2,
        },
        ZstdCompressionParams {
            window_log: 22,
            chain_log: 22,
            hash_log: 22,
            strategy: BtOpt,
        },
        ZstdCompressionParams {
            window_log: 23,
            chain_log: 23,
            hash_log: 22,
            strategy: BtOpt,
        },
        ZstdCompressionParams {
            window_log: 23,
            chain_log: 23,
            hash_log: 22,
            strategy: BtUltra,
        },
        ZstdCompressionParams {
            window_log: 23,
            chain_log: 24,
            hash_log: 22,
            strategy: BtUltra2,
        },
        ZstdCompressionParams {
            window_log: 25,
            chain_log: 25,
            hash_log: 23,
            strategy: BtUltra2,
        },
        ZstdCompressionParams {
            window_log: 26,
            chain_log: 26,
            hash_log: 24,
            strategy: BtUltra2,
        },
        ZstdCompressionParams {
            window_log: 27,
            chain_log: 27,
            hash_log: 25,
            strategy: BtUltra2,
        },
    ];
    LARGE_SOURCE_PARAMS[row]
}

fn zstd_single_worker_bytes(total_bytes: u64, params: &ZstdCompressionParams) -> u64 {
    let window = bytes_for_log(params.window_log);
    let active_window = if total_bytes == 0 {
        window
    } else {
        window.min(total_bytes).max(1 << 10)
    };
    let hash = bytes_for_log(params.hash_log).saturating_mul(ZSTD_WORKSPACE_WORD_BYTES);
    let chain = if params.strategy == ZstdStrategy::Fast {
        0
    } else {
        bytes_for_log(params.chain_log).saturating_mul(ZSTD_WORKSPACE_WORD_BYTES)
    };
    let block = active_window.min(128 * 1024);
    hash.saturating_add(chain)
        .saturating_add(active_window)
        .saturating_add(block.saturating_mul(3))
        .saturating_add(4 * 1024 * 1024)
}

fn zstd_mt_job_size_bytes(params: &ZstdCompressionParams) -> u64 {
    let job_log = (params.window_log + 2).clamp(20, ZSTD_MT_JOB_LOG_MAX);
    bytes_for_log(job_log).max(ZSTD_MT_JOB_SIZE_MIN_BYTES)
}

fn zstd_mt_overlap_bytes(params: &ZstdCompressionParams) -> u64 {
    let overlap_r_log = 9 - ZSTD_MT_OVERLAP_LOG;
    if overlap_r_log >= 8 {
        return 0;
    }
    let overlap_log = params.window_log.saturating_sub(overlap_r_log as u32);
    if overlap_log == 0 {
        0
    } else {
        bytes_for_log(overlap_log)
    }
}

fn zstd_cycle_log(chain_log: u32, strategy: ZstdStrategy) -> u32 {
    chain_log.saturating_sub(u32::from(strategy >= ZstdStrategy::BtLazy2))
}

fn ceil_log2_u64(value: u64) -> u32 {
    if value <= 1 {
        0
    } else {
        u64::BITS - (value - 1).leading_zeros()
    }
}

fn bytes_for_log(log: u32) -> u64 {
    1u64.checked_shl(log).unwrap_or(u64::MAX)
}

impl ContainerHandlerOperations for ZipContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        probe_regular_archive_with_libarchive(
            source,
            self.descriptor.name,
            LibarchiveProbeFormat::Zip,
        )
    }

    fn probe_details(
        &self,
        request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        let summary =
            probe_regular_archive_details_with_libarchive(&request.source, self.descriptor.name)?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "probe",
            format!(
                "{}: {} entries ({} files, {} directories), {} bytes compressed, {} bytes uncompressed",
                self.descriptor.name,
                summary.entries_total,
                summary.files,
                summary.directories,
                summary.archive_bytes,
                summary.logical_bytes
            ),
            Some(100.0),
            None,
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        list_regular_archive_entries_with_libarchive(&request.source, self.descriptor.name)
    }

    fn list_entry_records(
        &self,
        request: &ContainerProbeRequest,
        _context: &OperationContext,
    ) -> Result<Vec<ContainerListEntry>> {
        list_regular_archive_entry_records_with_libarchive(&request.source, self.descriptor.name)
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        extract_regular_archive_with_libarchive(request, context, self.descriptor.name)
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let (method, level) = self.parse_codec(request.codec.as_deref(), request.level)?;
        let entries = collect_archive_inputs(&request.inputs)?;
        let (logical_bytes, execution) =
            self.create_with_libarchive(request, &entries, method, level, context)?;

        let report = OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created `{}` from {} input(s) with {} ({} bytes)",
                request.output.display(),
                request.inputs.len(),
                self.method_name(method),
                logical_bytes
            ),
            Some(100.0),
            Some(execution.clone()),
        );
        Ok(attach_compression_details(
            report,
            self.method_name(method),
            level,
            logical_bytes,
            &execution,
        ))
    }
}
/* jscpd:ignore-end */
