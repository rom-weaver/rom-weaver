/* jscpd:ignore-start */
use super::*;

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

/// Files at or below this stay single-threaded (threading overhead not worth
/// it); larger files parallelise. Mirrors `LZMA2_MT_SPLIT_THRESHOLD` in the C
/// writer. Seeded blocks keep cross-block matches, so real ROM data stays at
/// size parity even when parallelised.
const LZMA2_MT_SPLIT_THRESHOLD_BYTES: u64 = 4 << 20;
/// Smallest parallel block; mirrors `LZMA2_MT_MIN_CHUNK_SIZE` in the C writer.
const LZMA2_MT_MIN_CHUNK_BYTES: u64 = 1 << 20;

/// Estimate how many LZMA2 worker blocks the 7z encoder will actually run — the
/// real parallelism ceiling. Files at or below the split threshold run as a
/// single block; larger files split into `ceil(total / min_chunk)` blocks,
/// capped further by the core and memory budgets. Keeps the reported
/// `effective_threads` honest. Mirrors the block split in the C writer.
fn lzma2_achievable_blocks(total_bytes: u64) -> usize {
    if total_bytes <= LZMA2_MT_SPLIT_THRESHOLD_BYTES {
        return 1;
    }
    usize::try_from(total_bytes.div_ceil(LZMA2_MT_MIN_CHUNK_BYTES).max(1)).unwrap_or(usize::MAX)
}

/// liblzma preset dictionary size for a 0..=9 level (matches `lzma_lzma_preset`).
fn lzma2_preset_dict_bytes(level: u32) -> u64 {
    match level {
        0 => 256 << 10,
        1 => 1 << 20,
        2 => 2 << 20,
        3 | 4 => 4 << 20,
        5 | 6 => 8 << 20,
        7 => 16 << 20,
        8 => 32 << 20,
        _ => 64 << 20,
    }
}

/// Round up to the smallest representable LZMA2 dictionary (`2^n` or `3*2^(n-1)`),
/// capped at `cap` — mirrors `lzma_reduce_dict_size` in the C writer.
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

/// Cap the worker count so peak memory fits a fraction of system RAM. Each seeded
/// block runs its own full-dictionary encoder (~12x the dictionary including the
/// seed copy and buffers), so on a memory-constrained host this collapses toward
/// a single encoder (close to single-thread 7-Zip), while a large host keeps more
/// workers. Falls back to a 2 GiB budget when RAM can't be queried.
pub(crate) fn lzma2_threads_for_budget(total_bytes: u64, level: u32, budget_bytes: u64) -> usize {
    let per_worker = lzma2_effective_dict_bytes(total_bytes, level)
        .saturating_mul(12)
        .max(1);
    usize::try_from((budget_bytes / per_worker).max(1)).unwrap_or(usize::MAX)
}

fn lzma2_memory_thread_cap(total_bytes: u64, level: u32) -> usize {
    // On wasm the budget is a slice of the linear-memory ceiling (~2 GiB, never
    // shrinks). Workers plus the base heap, thread stacks, and input must stay
    // under that ceiling, so cap workers at 1 GiB; native falls back here only
    // when RAM can't be queried.
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
        .or_else(|| physical_memory_bytes().map(|ram| ram / 2))
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
        let achievable = lzma2_achievable_blocks(total_bytes)
            .min(lzma2_memory_thread_cap(total_bytes, settings.level))
            .max(1);
        let execution = context.plan_threads(ThreadCapability::parallel(Some(achievable)));
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
/* jscpd:ignore-end */
