use super::*;

const CHECKSUM_VARIANT_CHUNK_SIZE: usize = 1024 * 1024;

impl CliApp {
    /// Compute every applicable checksum variant (raw, remove-header, fix-header,
    /// n64 byte order) in a single streaming pass via the shared engine in
    /// `rom-weaver-checksum`, emitting per-byte progress.
    pub(super) fn run_checksum_variants_with_progress<F>(
        &self,
        request: &ChecksumRequest,
        context: &OperationContext,
        stage: &'static str,
        on_progress: &mut F,
    ) -> Result<OperationReport>
    where
        F: FnMut(ChecksumProgress),
    {
        let algorithms = request
            .algorithms
            .iter()
            .map(|algorithm| algorithm.to_ascii_lowercase())
            .collect::<Vec<_>>();
        let file_len = fs::metadata(&request.source)?.len();
        let name_hint = request.source.file_name().and_then(|name| name.to_str());
        // Hash with the same parallelism as the inline extract path (shared budget policy) instead of
        // forcing single-threaded - previously this path was pinned to one thread, which made
        // `checksum` slower than extract's inline checksum. `engine_budget` is the full op budget so
        // the engine can split it across the active variants (each capping internally at its
        // algorithm count); capping the engine budget itself at the algorithm count would zero out
        // parallelism on multi-variant ROMs. The *reported* thread count is the algorithm-count cap,
        // which matches the command's failure-path reporting and the worker count actually spawned
        // for a single-variant file (the common case).
        let engine_budget = context.variant_hash_execution().effective_threads;
        let execution =
            context.plan_threads(ThreadCapability::parallel(Some(algorithms.len().max(1))));
        trace!(
            source = %request.source.display(),
            file_len,
            algorithm_count = algorithms.len(),
            engine_budget,
            reported_threads = execution.effective_threads,
            used_parallelism = execution.used_parallelism,
            "planned checksum variant hashing budget"
        );
        let mut engine =
            StreamingVariantChecksums::new(&algorithms, file_len, name_hint, engine_budget)?;

        // Identity detection is a separate stream consumer fed the same bytes as the
        // variant engine - neither embeds the other. No extra read.
        let mut identity = IdentityPrefix::new();
        let mut file = File::open(&request.source)?;
        let mut buffer = vec![0_u8; CHECKSUM_VARIANT_CHUNK_SIZE];
        let mut processed = 0_u64;
        let mut next_percent = 1_u64;
        loop {
            context.cancel().check()?;
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            engine.update(&buffer[..read])?;
            identity.push(&buffer[..read]);
            processed = processed.saturating_add(read as u64);
            Self::emit_checksum_variant_progress(
                processed,
                file_len,
                &mut next_percent,
                on_progress,
            );
        }
        on_progress(ChecksumProgress {
            processed_bytes: file_len,
            total_bytes: file_len,
        });

        let VariantOutput {
            mut rows,
            deferred_fix_header,
            ..
        } = engine.finalize()?;
        // The repair dependency may have exceeded the in-memory prefix cap; the file is on disk, so
        // finish any deferred fix-header in one extra read (shared with the extract write path).
        finish_deferred_fix_header(&mut rows, deferred_fix_header, &algorithms, &request.source)?;
        let extension = request
            .source
            .extension()
            .map(|ext| format!(".{}", ext.to_string_lossy()));
        let rom_identity = identity.detect(extension.as_deref());

        let primary_checksums = rows
            .iter()
            .find(|row| row.id == "raw")
            .map(|row| row.checksums.clone())
            .unwrap_or_default();
        let rows_json = rows.iter().map(VariantRow::to_json).collect::<Vec<_>>();

        let mut report = OperationReport::succeeded(
            OperationFamily::Checksum,
            Some(self.checksum.name().to_string()),
            stage,
            Self::render_checksum_details_label(&algorithms, &primary_checksums),
            Some(100.0),
            Some(execution),
        );
        let mut details = json!({
            "checksums": primary_checksums,
            "checksum_variants": rows_json,
        });
        if let Some(map) = details.as_object_mut() {
            rom_identity.write_into(map);
        }
        report.details = Some(details);
        Ok(report)
    }

    pub(super) fn attach_checksum_details(
        mut report: OperationReport,
        checksums: BTreeMap<String, String>,
    ) -> OperationReport {
        let mut details = operation_report_details(&mut report);
        details.insert("checksums".to_string(), json!(checksums.clone()));
        details.insert(
            "checksum_variants".to_string(),
            json!([{
                "id": "raw",
                "label": "Raw",
                "checksums": checksums,
                "applyCompatibility": {},
                "transforms": {},
            }]),
        );
        report.details = Some(Value::Object(details));
        report
    }

    fn emit_checksum_variant_progress<F>(
        processed_bytes: u64,
        total_bytes: u64,
        next_percent: &mut u64,
        on_progress: &mut F,
    ) where
        F: FnMut(ChecksumProgress),
    {
        if total_bytes == 0 {
            return;
        }
        let percent = processed_bytes
            .saturating_mul(100)
            .checked_div(total_bytes)
            .unwrap_or(100)
            .min(100);
        while *next_percent <= percent {
            on_progress(ChecksumProgress {
                processed_bytes,
                total_bytes,
            });
            *next_percent = (*next_percent).saturating_add(1);
        }
    }

    fn render_checksum_details_label(
        algorithms: &[String],
        checksums: &BTreeMap<String, String>,
    ) -> String {
        algorithms
            .iter()
            .filter_map(|algorithm| {
                checksums
                    .get(algorithm.as_str())
                    .map(|value| format!("{algorithm}={value}"))
            })
            .collect::<Vec<_>>()
            .join(" ")
    }
}
