//! N64-specific byte-order detection and rewriting used by header repair and
//! the patch-apply compatibility transforms.
//!
//! N64 dumps appear in three interleavings (big-endian `.z64`, little-endian
//! `.n64`, and byte-swapped `.v64`); checksum repair has to normalize to
//! big-endian, compute over the normalized words, then write back in the
//! original order. These remain `CliApp` associated functions because the
//! patch-apply/validate flows call them as `Self::…`.

use super::*;

impl CliApp {
    pub(super) fn detect_n64_byte_order_file(
        file: &mut File,
        file_len: usize,
    ) -> Result<Option<N64ByteOrder>> {
        if file_len < 4 {
            return Ok(None);
        }
        let magic = read_vec_at(file, 0, 4)?;
        Ok(N64ByteOrder::detect(&magic))
    }

    pub(super) fn read_n64_word_normalized(
        file: &mut File,
        offset: u64,
        order: N64ByteOrder,
    ) -> Result<u32> {
        let mut bytes = [0u8; 4];
        read_exact_at(file, offset, &mut bytes)?;
        Ok(order.word_normalized(bytes))
    }

    pub(super) fn write_n64_word_original_order(
        file: &mut File,
        offset: u64,
        value: u32,
        order: N64ByteOrder,
    ) -> Result<()> {
        write_all_at(file, offset, &order.word_original_order(value))
    }

    pub(super) fn detect_n64_byte_order_path(path: &Path) -> Result<Option<N64ByteOrder>> {
        let mut file = File::open(path)?;
        let file_len = usize::try_from(file.metadata()?.len()).unwrap_or(usize::MAX);
        Self::detect_n64_byte_order_file(&mut file, file_len)
    }

    pub(super) fn rewrite_n64_byte_order(
        input: &Path,
        output: &Path,
        from: N64ByteOrder,
        to: N64ByteOrder,
    ) -> Result<()> {
        let input_len = fs::metadata(input)?.len();
        if input_len % 4 != 0 {
            return Err(RomWeaverError::Validation(format!(
                "cannot normalize N64 byte order for `{}`: length {input_len} is not a multiple of 4",
                input.display()
            )));
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut reader = BufReader::new(File::open(input)?);
        let mut writer = BufWriter::new(File::create(output)?);
        let mut word = [0_u8; 4];
        loop {
            match reader.read_exact(&mut word) {
                Ok(()) => {
                    from.transform_word(&mut word);
                    to.transform_word(&mut word);
                    writer.write_all(&word)?;
                }
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
                Err(error) => return Err(error.into()),
            }
        }
        writer.flush()?;
        Ok(())
    }

    pub(super) fn normalize_n64_to_big_endian_to_temp(
        input: &Path,
        output: &Path,
    ) -> Result<Option<N64ByteOrder>> {
        let Some(order) = Self::detect_n64_byte_order_path(input)? else {
            return Ok(None);
        };
        if order == N64ByteOrder::BigEndian {
            return Ok(None);
        }
        Self::rewrite_n64_byte_order(input, output, order, N64ByteOrder::BigEndian)?;
        Ok(Some(order))
    }

    /// Match required source checks against the three N64 byte-order variants.
    /// The shared checksum engine hashes them in one read of the input.
    pub(super) fn resolve_n64_byte_order_for_checks(
        input: &Path,
        required: &[patch_plan::PlanState],
        context: &OperationContext,
    ) -> Result<Option<N64ByteOrder>> {
        if Self::detect_n64_byte_order_path(input)?.is_none() {
            return Ok(None);
        }
        let file_len = fs::metadata(input)?.len();
        let algorithms = super::patch_basis_decision::hashable_algorithms(required);
        if algorithms.is_empty() {
            return Ok(None);
        }
        let matches = Self::hash_n64_byte_order_rows(input, &algorithms, file_len, context)?
            .into_iter()
            .filter(|(_, row)| {
                required.iter().any(|state| {
                    patch_plan::compare_states(
                        state,
                        &patch_plan::PlanState {
                            checksums: row.checksums.clone(),
                            size: Some(file_len),
                        },
                    ) == patch_plan::EvidenceMatch::Match
                })
            })
            .map(|(order, _)| order)
            .collect::<Vec<_>>();
        Ok((matches.len() == 1).then(|| matches[0]))
    }

    /// Hash `input` once through the shared variant engine and return its
    /// N64 byte-order variant rows keyed by the order each row represents.
    pub(super) fn hash_n64_byte_order_rows(
        input: &Path,
        algorithms: &[String],
        file_len: u64,
        context: &OperationContext,
    ) -> Result<Vec<(N64ByteOrder, VariantRow)>> {
        let name_hint = input.file_name().and_then(|name| name.to_str());
        let mut engine = StreamingVariantChecksums::new(
            algorithms,
            file_len,
            name_hint,
            context.variant_hash_execution().effective_threads,
        )?;
        let mut file = File::open(input)?;
        let mut buffer = vec![0_u8; 1024 * 1024];
        loop {
            context.cancel().check()?;
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            engine.update(&buffer[..read])?;
        }
        Ok(engine
            .finalize()?
            .rows
            .into_iter()
            .filter_map(|row| Some((n64_byte_order_from_row_id(&row.id)?, row)))
            .collect())
    }
}
