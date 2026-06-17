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
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        // The standalone checksum-variants command keeps its single-threaded streaming pass; pass its
        // resolved thread count (1) so the raw variant stays synchronous here. Parallelizing this path
        // is a separate follow-up; the inline extract path is what spends spare threads on hashing.
        let mut engine = StreamingVariantChecksums::new(
            &algorithms,
            file_len,
            name_hint,
            execution.effective_threads,
        )?;

        // Identity detection is a separate stream consumer fed the same bytes as the
        // variant engine — neither embeds the other. No extra read.
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
        let extension = request
            .source
            .extension()
            .map(|ext| format!(".{}", ext.to_string_lossy()));
        let rom_identity = identity.detect(extension.as_deref());
        if let Some(deferred) = deferred_fix_header {
            // The repair dependency exceeded the in-memory prefix cap; the file
            // is on disk, so apply the overlay in one extra read to finish it.
            let mut overlay_file = File::open(&request.source)?;
            let checksums = overlay_checksums(&mut overlay_file, &algorithms, &deferred.patches)?;
            rows.push(VariantRow {
                id: deferred.id,
                label: deferred.label,
                checksums,
                apply_compatibility: deferred.apply_compatibility,
                transforms: deferred.transforms,
            });
        }

        let mut primary_checksums = BTreeMap::new();
        let mut rows_json = Vec::with_capacity(rows.len());
        for row in &rows {
            if row.id == "raw" {
                primary_checksums = row.checksums.clone();
            }
            rows_json.push(json!({
                "id": row.id,
                "label": row.label,
                "checksums": row.checksums,
                "applyCompatibility": row.apply_compatibility,
                "transforms": row.transforms,
            }));
        }

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
        let mut details = match report.details.take() {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
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
