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

// Native builds default to 7-Zip's SDK encoder and can opt back into the seeded
// liblzma encoder. WASM always uses liblzma because the SDK's nested threads
// cannot run in the browser's WASI pool.
const LZMA2_MT_SPLIT_THRESHOLD_BYTES: u64 = 4 << 20;
const LZMA2_MT_MIN_CHUNK_BYTES: u64 = 1 << 20;
#[cfg(not(target_family = "wasm"))]
const LZMA2_SDK_BLOCK_SIZE_MAX_BYTES: u64 = 1 << 28;
#[cfg(target_family = "wasm")]
const LZMA2_MT_WASM_MAX_THREADS: usize = 2;

#[cfg(not(target_family = "wasm"))]
fn lzma2_sdk_encoder_enabled() -> bool {
    std::env::var("ROM_WEAVER_7Z_ENCODER").ok().as_deref() != Some("liblzma")
}

/// `LzmaEncProps_Normalize` uses one HC match-finder thread below level 5 and
/// two BT match-finder threads at level 5 and above.
#[cfg(not(target_family = "wasm"))]
fn lzma2_sdk_threads_per_block(level: u32) -> usize {
    if level < 5 { 1 } else { 2 }
}

/// Block size selected by `Lzma2EncProps_Normalize` for an automatic block.
#[cfg(not(target_family = "wasm"))]
fn lzma2_sdk_block_size_bytes(total_bytes: u64, level: u32) -> u64 {
    let block = lzma2_effective_dict_bytes(total_bytes, level)
        .saturating_mul(4)
        .clamp(LZMA2_MT_MIN_CHUNK_BYTES, LZMA2_SDK_BLOCK_SIZE_MAX_BYTES);
    block
        .div_ceil(LZMA2_MT_MIN_CHUNK_BYTES)
        .saturating_mul(LZMA2_MT_MIN_CHUNK_BYTES)
}

#[cfg(not(target_family = "wasm"))]
fn lzma2_sdk_achievable_threads(total_bytes: u64, level: u32) -> usize {
    if total_bytes <= LZMA2_MT_SPLIT_THRESHOLD_BYTES {
        return 1;
    }
    let blocks = total_bytes
        .div_ceil(lzma2_sdk_block_size_bytes(total_bytes, level))
        .max(1);
    usize::try_from(blocks)
        .unwrap_or(usize::MAX)
        .saturating_mul(lzma2_sdk_threads_per_block(level))
}

fn lzma2_liblzma_achievable_threads(total_bytes: u64) -> usize {
    if total_bytes <= LZMA2_MT_SPLIT_THRESHOLD_BYTES {
        return 1;
    }
    usize::try_from(total_bytes.div_ceil(LZMA2_MT_MIN_CHUNK_BYTES).max(1)).unwrap_or(usize::MAX)
}

#[cfg(not(target_family = "wasm"))]
fn lzma2_achievable_threads(total_bytes: u64, level: u32) -> usize {
    if lzma2_sdk_encoder_enabled() {
        lzma2_sdk_achievable_threads(total_bytes, level)
    } else {
        lzma2_liblzma_achievable_threads(total_bytes)
    }
}

#[cfg(target_family = "wasm")]
fn lzma2_achievable_threads(total_bytes: u64, _level: u32) -> usize {
    lzma2_liblzma_achievable_threads(total_bytes)
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

fn lzma2_liblzma_worker_budget_bytes(total_bytes: u64, level: u32) -> u64 {
    lzma2_effective_dict_bytes(total_bytes, level)
        .saturating_mul(16)
        .max(1)
}

fn lzma2_liblzma_peak_bytes(total_bytes: u64, level: u32, threads: usize) -> u64 {
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

pub(crate) fn lzma2_liblzma_threads_for_budget_with_limits(
    total_bytes: u64,
    level: u32,
    budget_bytes: u64,
    max_threads: Option<usize>,
) -> usize {
    let per_worker = lzma2_liblzma_worker_budget_bytes(total_bytes, level);
    let budget_threads = usize::try_from((budget_bytes / per_worker).max(1)).unwrap_or(usize::MAX);
    let mut threads = max_threads
        .map(|limit| budget_threads.min(limit.max(1)))
        .unwrap_or(budget_threads);
    if total_bytes > LZMA2_MT_SPLIT_THRESHOLD_BYTES {
        threads = threads.min(lzma2_liblzma_achievable_threads(total_bytes));
        while threads > 1 && lzma2_liblzma_peak_bytes(total_bytes, level, threads) > budget_bytes {
            threads -= 1;
        }
    }
    threads
}

#[cfg(not(target_family = "wasm"))]
fn lzma2_sdk_block_budget_bytes(total_bytes: u64, level: u32) -> u64 {
    let dict = lzma2_effective_dict_bytes(total_bytes, level);
    let block = lzma2_sdk_block_size_bytes(total_bytes, level);
    dict.saturating_mul(12)
        .saturating_add(block)
        .saturating_add(block)
        .saturating_add(block >> 10)
        .saturating_add(16)
        .max(1)
}

#[cfg(not(target_family = "wasm"))]
fn lzma2_normalize_sdk_threads(level: u32, threads: usize) -> usize {
    let threads = threads.max(1);
    let per_block = lzma2_sdk_threads_per_block(level);
    if threads == 1 {
        1
    } else {
        (threads / per_block).max(1).saturating_mul(per_block)
    }
}

#[cfg(not(target_family = "wasm"))]
pub(crate) fn lzma2_sdk_threads_for_budget_with_limits(
    total_bytes: u64,
    level: u32,
    budget_bytes: u64,
    max_threads: Option<usize>,
) -> usize {
    let per_block = lzma2_sdk_block_budget_bytes(total_bytes, level);
    let blocks = usize::try_from((budget_bytes / per_block).max(1)).unwrap_or(usize::MAX);
    let sdk_threads = blocks.saturating_mul(lzma2_sdk_threads_per_block(level));
    let sdk_threads = max_threads
        .map(|limit| sdk_threads.min(limit.max(1)))
        .unwrap_or(sdk_threads);
    // The C bridge falls back to liblzma if its SDK driver thread cannot start,
    // so the same count must fit both encoders.
    let fallback_threads =
        lzma2_liblzma_threads_for_budget_with_limits(total_bytes, level, budget_bytes, max_threads);
    lzma2_normalize_sdk_threads(level, sdk_threads.min(fallback_threads))
}

pub(crate) fn lzma2_threads_for_budget_with_limits(
    total_bytes: u64,
    level: u32,
    budget_bytes: u64,
    max_threads: Option<usize>,
) -> usize {
    #[cfg(not(target_family = "wasm"))]
    if lzma2_sdk_encoder_enabled() {
        return lzma2_sdk_threads_for_budget_with_limits(
            total_bytes,
            level,
            budget_bytes,
            max_threads,
        );
    }

    lzma2_liblzma_threads_for_budget_with_limits(total_bytes, level, budget_bytes, max_threads)
}

pub(crate) fn lzma2_threads_for_budget(total_bytes: u64, level: u32, budget_bytes: u64) -> usize {
    #[cfg(target_family = "wasm")]
    let max_threads = Some(LZMA2_MT_WASM_MAX_THREADS);
    #[cfg(not(target_family = "wasm"))]
    let max_threads = None;
    lzma2_threads_for_budget_with_limits(total_bytes, level, budget_bytes, max_threads)
}

fn lzma2_normalize_threads(level: u32, threads: usize) -> usize {
    #[cfg(not(target_family = "wasm"))]
    if lzma2_sdk_encoder_enabled() {
        return lzma2_normalize_sdk_threads(level, threads);
    }

    let _ = level;
    threads.max(1)
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
        let mut execution = context.plan_threads(ThreadCapability::parallel(Some(achievable)));
        execution.effective_threads =
            lzma2_normalize_threads(settings.level, execution.effective_threads);
        execution.used_parallelism = execution.effective_threads > 1;
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
