use super::*;
use tracing::debug;

pub(crate) struct SevenZContainerHandler {
    descriptor: &'static FormatDescriptor,
}

#[derive(Clone)]
struct SevenZCodecSettings {
    level: u32,
    method: SevenZMethod,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SevenZMethod {
    Lzma2,
}

impl SevenZContainerHandler {
    const SUPPORTED_CODECS: &[&str] = &["lzma2"];
    const DEFAULT_CODEC_LEVEL: u32 = 6;

    pub(crate) const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }

    #[cfg(test)]
    pub(crate) fn parse_codec(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
        _execution: &rom_weaver_core::ThreadExecution,
    ) -> Result<SevenZMethod> {
        self.resolve_codec_settings(codec, level)
            .map(|settings| settings.method)
    }

    fn resolve_codec_settings(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
    ) -> Result<SevenZCodecSettings> {
        let _ = resolve_create_codec(self.descriptor.name, codec, Self::SUPPORTED_CODECS, "lzma2")?;
        let level = Self::parse_level(level)?;
        let level = level.unwrap_or(Self::DEFAULT_CODEC_LEVEL);
        Ok(SevenZCodecSettings {
            level,
            method: SevenZMethod::Lzma2,
        })
    }

    fn parse_level(level: Option<i32>) -> Result<Option<u32>> {
        let Some(level) = level else {
            return Ok(None);
        };
        let max_level = 9;
        if !(0..=max_level).contains(&level) {
            return Err(RomWeaverError::Validation(format!(
                "7z level `{level}` is out of range for codec `lzma2` (0..={max_level})"
            )));
        }
        Ok(Some(level as u32))
    }

    fn method_name(method: SevenZMethod) -> &'static str {
        match method {
            SevenZMethod::Lzma2 => "lzma2",
        }
    }

    fn create_with_libarchive(
        &self,
        request: &ContainerCreateRequest,
        entries: &[ArchiveInputEntry],
        settings: &SevenZCodecSettings,
        execution: &ThreadExecution,
        context: &OperationContext,
    ) -> Result<u64> {
        let logical_bytes = write_archive_with_libarchive(
            request,
            entries,
            context,
            execution,
            LibarchiveCreateConfig {
                format_name: self.descriptor.name,
                format: LibarchiveCreateFormat::SevenZ,
                filter: LibarchiveCreateFilter::None,
                format_compression: Some("lzma2"),
                compression_level: Some(settings.level as i32),
                format_threads: Some(execution.effective_threads.max(1)),
                filter_threads: None,
                io_buffer_bytes: LIBARCHIVE_CREATE_IO_BUFFER_BYTES,
            },
        )?;
        Ok(logical_bytes)
    }
}

/// Match-finder threads the SDK encoder pairs with every LZMA2 block, from
/// `LzmaEncProps_Normalize`'s `numThreads = 2` default. The thread budget the
/// writer is handed is a *total*, which `Lzma2EncProps_Normalize` then divides
/// into `total / 2` block encoders.
const LZMA2_SDK_THREADS_PER_BLOCK: usize = 2;
/// Inputs at or below this stay single-threaded: one SDK block, and its
/// match-finder threads cannot pay for themselves on data this small.
const LZMA2_SINGLE_THREAD_THRESHOLD_BYTES: u64 = 4 << 20;
/// Block-size floor and ceiling from `Lzma2EncProps_Normalize`'s auto sizing.
const LZMA2_BLOCK_SIZE_MIN_BYTES: u64 = 1 << 20;
const LZMA2_BLOCK_SIZE_MAX_BYTES: u64 = 1 << 28;
/// Browser liblzma's raw encoder vtables become unstable with higher concurrent
/// level-9 jobs under WASI threads; keep real parallelism without entering the
/// trap-prone range.
#[cfg(target_family = "wasm")]
const LZMA2_MT_WASM_MAX_THREADS: usize = 2;

/// Block size the SDK encoder picks for an auto `blockSize`: four dictionaries,
/// clamped to \[1 MiB, 256 MiB\] and rounded up to a whole MiB. Mirrors
/// `Lzma2EncProps_Normalize`.
fn lzma2_block_size_bytes(total_bytes: u64, level: u32) -> u64 {
    let dict = lzma2_effective_dict_bytes(total_bytes, level);
    let block = dict
        .saturating_mul(4)
        .clamp(LZMA2_BLOCK_SIZE_MIN_BYTES, LZMA2_BLOCK_SIZE_MAX_BYTES)
        .max(dict);
    block
        .div_ceil(LZMA2_BLOCK_SIZE_MIN_BYTES)
        .saturating_mul(LZMA2_BLOCK_SIZE_MIN_BYTES)
}

/// Threads the 7z encoder can actually keep busy - the real parallelism ceiling.
/// The SDK splits the input into `ceil(total / blockSize)` blocks and drives
/// each with `LZMA2_SDK_THREADS_PER_BLOCK` threads; anything past that is idle.
/// Keeps the reported `effective_threads` honest.
fn lzma2_achievable_threads(total_bytes: u64, level: u32) -> usize {
    if total_bytes <= LZMA2_SINGLE_THREAD_THRESHOLD_BYTES {
        return 1;
    }
    let blocks = total_bytes
        .div_ceil(lzma2_block_size_bytes(total_bytes, level))
        .max(1);
    usize::try_from(blocks)
        .unwrap_or(usize::MAX)
        .saturating_mul(LZMA2_SDK_THREADS_PER_BLOCK)
}

/// Per-level LZMA2 dictionary size, mirroring the 7-Zip table the C writer
/// applies (probed from 7zz 26.02: 256 KiB at level 1 up to 256 MiB at 8/9).
/// wasm32 caps at 64 MiB - a 256 MiB dictionary needs a ~3 GiB match finder,
/// which cannot fit the 4 GiB linear memory.
fn lzma2_preset_dict_bytes(level: u32) -> u64 {
    let level = level.min(9);
    let dict = if level <= 4 {
        1u64 << (level * 2 + 16)
    } else if level <= 7 {
        1u64 << (level + 20)
    } else {
        1u64 << 28
    };
    #[cfg(target_family = "wasm")]
    let dict = dict.min(1 << 26);
    dict
}

/// Round up to the smallest representable LZMA2 dictionary (`2^n` or `3*2^(n-1)`),
/// capped at `cap` - mirrors `lzma_reduce_dict_size` in the C writer.
fn lzma2_round_up_dict(size: u64, cap: u64) -> u64 {
    for b in 0u32..=40 {
        let candidate = (2u64 | u64::from(b & 1)) << (b / 2 + 11);
        if candidate >= size {
            return candidate.min(cap);
        }
    }
    cap
}

/// Dictionary the encoder will use after reducing the preset to fit the data.
fn lzma2_effective_dict_bytes(total_bytes: u64, level: u32) -> u64 {
    let preset = lzma2_preset_dict_bytes(level);
    if total_bytes == 0 {
        return preset;
    }
    lzma2_round_up_dict(total_bytes.min(preset), preset)
}

#[cfg(target_family = "wasm")]
fn lzma2_budget_max_threads() -> Option<usize> {
    Some(LZMA2_MT_WASM_MAX_THREADS)
}

#[cfg(not(target_family = "wasm"))]
fn lzma2_budget_max_threads() -> Option<usize> {
    None
}

/// Peak bytes one SDK block encoder costs: ~11.5x the dictionary for its bt4
/// match finder, plus `MtCoder`'s block-sized input buffer and the matching
/// output buffer - both 4x the dictionary at the auto block size
/// (`lzma2_block_size_bytes`) - so ~20x. The budget is spent in whole block
/// encoders; each one is then driven by `LZMA2_SDK_THREADS_PER_BLOCK` threads.
///
/// This sizes the *default* SDK backend. The `ROM_WEAVER_7Z_ENCODER=liblzma`
/// fallback peaks lower - ~16x (match finder 11.5x, seed 1x, chunk 2x, output
/// ~2x), because it streams one chunk rather than holding a whole `MtCoder`
/// block in and out - so the same bound covers it with room to spare. Sizing
/// for the cheaper of the two would under-count the encoder that actually runs.
fn lzma2_worker_budget_bytes(total_bytes: u64, level: u32) -> u64 {
    lzma2_effective_dict_bytes(total_bytes, level)
        .saturating_mul(20)
        .max(1)
}

fn lzma2_mt_peak_bytes(total_bytes: u64, level: u32, threads: usize) -> u64 {
    let dict = lzma2_effective_dict_bytes(total_bytes, level);
    let threads = u64::try_from(threads).unwrap_or(u64::MAX).max(1);
    let cap = dict.saturating_mul(2);
    let mut block = total_bytes.div_ceil(threads);
    if block > cap {
        let blocks = total_bytes
            .div_ceil(cap)
            .div_ceil(threads)
            .saturating_mul(threads);
        block = total_bytes.div_ceil(blocks);
    }
    block = block.max(LZMA2_MT_MIN_CHUNK_BYTES);

    let blocks = total_bytes.div_ceil(block);
    let active = blocks.min(threads);
    let seeds = if blocks <= threads {
        (0..active).fold(0u64, |total, index| {
            total.saturating_add(index.saturating_mul(block).min(dict))
        })
    } else {
        active.saturating_mul(dict)
    };
    let inputs = active.saturating_mul(block).saturating_add(seeds);
    let output = block.saturating_add(block / 16).saturating_add(1024);
    let parked = blocks.saturating_sub(active).min(threads);

    active
        .saturating_mul(dict.saturating_mul(12))
        .saturating_add(inputs)
        .saturating_add(active.saturating_add(parked).saturating_mul(output))
        .saturating_add(block)
        .saturating_add(dict)
}

pub(crate) fn lzma2_threads_for_budget_with_limits(
    total_bytes: u64,
    level: u32,
    budget_bytes: u64,
    max_threads: Option<usize>,
) -> usize {
    let per_block = lzma2_worker_budget_bytes(total_bytes, level);
    let blocks = usize::try_from((budget_bytes / per_block).max(1)).unwrap_or(usize::MAX);
    let budget_threads = blocks.saturating_mul(LZMA2_SDK_THREADS_PER_BLOCK);
    let mut threads = max_threads
        .map(|limit| budget_threads.min(limit.max(1)))
        .unwrap_or(budget_threads);
    if total_bytes > LZMA2_MT_SPLIT_THRESHOLD_BYTES {
        threads = threads.min(lzma2_achievable_blocks(total_bytes));
        while threads > 1 && lzma2_mt_peak_bytes(total_bytes, level, threads) > budget_bytes {
            threads -= 1;
        }
    }
    threads
}

/// Cap the thread count so peak memory fits a fraction of system RAM. Each SDK
/// block runs its own full-dictionary encoder (~20x the dictionary including
/// its input and output block buffers), so on a memory-constrained host this
/// collapses toward a single encoder (close to single-thread 7-Zip), while a
/// large host keeps more workers.
pub(crate) fn lzma2_threads_for_budget(total_bytes: u64, level: u32, budget_bytes: u64) -> usize {
    lzma2_threads_for_budget_with_limits(
        total_bytes,
        level,
        budget_bytes,
        lzma2_budget_max_threads(),
    )
}

fn lzma2_memory_thread_cap(total_bytes: u64, level: u32) -> usize {
    // wasm's reported "physical memory" is already the conservative shared
    // instance budget; native hosts reserve half their RAM for the rest of the
    // process and the OS.
    #[cfg(target_family = "wasm")]
    const FALLBACK_BUDGET_BYTES: u64 = 1024 * 1024 * 1024;
    #[cfg(not(target_family = "wasm"))]
    const FALLBACK_BUDGET_BYTES: u64 = 2 * 1024 * 1024 * 1024;
    // `ROM_WEAVER_7Z_MEM_BUDGET_MB` overrides the auto budget for constrained or
    // shared hosts; otherwise use half of physical RAM, or a fixed fallback.
    let budget = std::env::var("ROM_WEAVER_7Z_MEM_BUDGET_MB")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(|mb| mb.saturating_mul(1024 * 1024))
        .or_else(|| {
            physical_memory_bytes().map(|ram| {
                if cfg!(target_family = "wasm") {
                    ram
                } else {
                    ram / 2
                }
            })
        })
        .unwrap_or(FALLBACK_BUDGET_BYTES);
    lzma2_threads_for_budget(total_bytes, level, budget)
}

impl ContainerHandlerOperations for SevenZContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        probe_regular_archive_with_libarchive(
            source,
            self.descriptor.name,
            LibarchiveProbeFormat::SevenZ,
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
                "7z: {} entries ({} files, {} directories), {} bytes compressed, {} bytes uncompressed",
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
        let settings = self.resolve_codec_settings(request.codec.as_deref(), request.level)?;
        let entries = collect_archive_inputs(&request.inputs)?;
        // Cap planned threads at both the blocks the encoder can actually run and
        // what fits the system memory budget, so the reported parallelism is real
        // and peak RAM scales down on smaller machines.
        let total_bytes = sum_input_file_bytes(&entries);
        let achievable = lzma2_achievable_threads(total_bytes, settings.level)
            .min(lzma2_memory_thread_cap(total_bytes, settings.level))
            .max(1);
        let execution = context.plan_threads(ThreadCapability::parallel(Some(achievable)));
        debug!(
            format = self.descriptor.name,
            method = Self::method_name(settings.method),
            level = settings.level,
            entries = entries.len(),
            total_bytes,
            achievable_threads = achievable,
            effective_threads = execution.effective_threads,
            "7z create start"
        );
        let logical_bytes =
            self.create_with_libarchive(request, &entries, &settings, &execution, context)?;

        let report = OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created `{}` from {} input(s) with {} ({} bytes)",
                request.output.display(),
                request.inputs.len(),
                Self::method_name(settings.method),
                logical_bytes
            ),
            Some(100.0),
            Some(execution.clone()),
        );
        Ok(attach_compression_details(
            report,
            Self::method_name(settings.method),
            Some(settings.level as i32),
            logical_bytes,
            &execution,
        ))
    }
}
