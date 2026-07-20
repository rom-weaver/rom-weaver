use super::*;

#[derive(Clone, Copy)]
pub(super) struct CompressedCreateParams<'a> {
    pub(super) output: &'a Path,
    pub(super) logical_bytes: u64,
    pub(super) create_kind: &'a ChdCreateKind,
    pub(super) codecs: [ChdCodec; CHD_MAX_COMPRESSORS],
    pub(super) compression_level: i32,
    pub(super) thread_count: usize,
    pub(super) parent_source: Option<&'a Path>,
    pub(super) on_progress: Option<&'a Arc<dyn Fn(u64) + Send + Sync>>,
}

struct PipelineHunkRecord<'a> {
    output: &'a Path,
    entries: &'a mut Vec<RustCompressedHunkEntry>,
    current_offset: &'a mut u64,
    self_hunks_by_hash: &'a mut HashMap<HunkHashKey, u64>,
    parent_hunks_by_hash: Option<&'a HashMap<HunkHashKey, u64>>,
    hunk_index: usize,
    hash_key: HunkHashKey,
    compression_type: u8,
    payload: Vec<u8>,
}

impl ChdContainerHandler {
    /// Hashes and compresses a single hunk, trying every encodable codec (including CD FLAC) and
    /// keeping the smallest, matching chdman. Shared by the sequential and pipelined create
    /// paths.
    pub(super) fn compress_pipeline_hunk(
        &self,
        create_kind: &ChdCreateKind,
        primary_codec: ChdCodec,
        codecs: &[(u8, ChdCodec)],
        compression_level: i32,
        hunk: Vec<u8>,
        scratch: &mut ChdCompressionScratch,
    ) -> Result<(HunkHashKey, u8, Vec<u8>)> {
        let hash_key = Self::hunk_hash_key(&hunk);
        let (compression_type, payload) = self.compress_best_rust_hunk(
            create_kind,
            primary_codec,
            codecs,
            compression_level,
            hunk,
            scratch,
        )?;
        Ok((hash_key, compression_type, payload))
    }

    /// Appends a compressed hunk in hunk order: emits a self/parent reference when the hunk
    /// duplicates earlier data, otherwise writes the payload and records its map entry. Shared
    /// by the sequential and pipelined create paths.
    fn record_pipeline_hunk(
        &self,
        output_file: &mut dyn Write,
        record: PipelineHunkRecord<'_>,
    ) -> Result<()> {
        let PipelineHunkRecord {
            output,
            entries,
            current_offset,
            self_hunks_by_hash,
            parent_hunks_by_hash,
            hunk_index,
            hash_key,
            compression_type,
            payload,
        } = record;
        if let Some(&other_hunk) = self_hunks_by_hash.get(&hash_key) {
            entries.push(RustCompressedHunkEntry {
                compression_type: Self::CHD_V5_MAP_TYPE_SELF,
                offset: other_hunk,
                length: 0,
                crc16: 0,
            });
            return Ok(());
        }
        if let Some(parent_unit) = parent_hunks_by_hash.and_then(|map| map.get(&hash_key).copied())
        {
            entries.push(RustCompressedHunkEntry {
                compression_type: Self::CHD_V5_MAP_TYPE_PARENT,
                offset: parent_unit,
                length: 0,
                crc16: 0,
            });
            return Ok(());
        }
        self_hunks_by_hash.insert(hash_key, hunk_index as u64);
        let length = u32::try_from(payload.len()).map_err(|_| {
            RomWeaverError::Validation("compressed CHD chunk exceeded u32 size".into())
        })?;
        if length > 0x00FF_FFFF {
            return Err(RomWeaverError::Validation(format!(
                "compressed CHD chunk length {length} exceeds v5 map limit"
            )));
        }
        output_file.write_all(&payload).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to write CHD data to `{}`: {error}",
                output.display()
            ))
        })?;
        entries.push(RustCompressedHunkEntry {
            compression_type,
            offset: *current_offset,
            length,
            crc16: hash_key.crc16,
        });
        *current_offset = current_offset.saturating_add(u64::from(length));
        Ok(())
    }

    pub(super) fn create_uncompressed_rust_raw(
        &self,
        input: &Path,
        output: &Path,
        logical_bytes: u64,
        create_kind: &ChdCreateKind,
        on_progress: Option<&Arc<dyn Fn(u64) + Send + Sync>>,
    ) -> Result<ChdHeader> {
        let mut source = BufReader::new(File::open(input).map_err(|error| {
            RomWeaverError::Validation(format!("failed to open `{}`: {error}", input.display()))
        })?);
        let source_label = input.display().to_string();
        self.create_uncompressed_rust_stream(
            &mut source,
            &source_label,
            output,
            logical_bytes,
            create_kind,
            on_progress,
        )
    }

    pub(super) fn create_uncompressed_rust_stream(
        &self,
        source: &mut dyn Read,
        source_label: &str,
        output: &Path,
        logical_bytes: u64,
        create_kind: &ChdCreateKind,
        on_progress: Option<&Arc<dyn Fn(u64) + Send + Sync>>,
    ) -> Result<ChdHeader> {
        if matches!(create_kind, ChdCreateKind::Av(_)) {
            return Err(RomWeaverError::Unsupported(UnsupportedOp::ChdStoreModeOnly));
        }

        let hunk_bytes = self.hunk_bytes(create_kind, logical_bytes, ChdCodec::NONE);
        let unit_bytes = self.unit_bytes(create_kind);
        if hunk_bytes == 0 || unit_bytes == 0 || !hunk_bytes.is_multiple_of(unit_bytes) {
            return Err(RomWeaverError::Validation(
                "invalid CHD geometry for rust create".into(),
            ));
        }

        let hunk_count_u64 = logical_bytes.div_ceil(u64::from(hunk_bytes));
        let hunk_count = u32::try_from(hunk_count_u64).map_err(|_| {
            RomWeaverError::Validation(
                "input is too large for CHD v5 hunk table limits".to_string(),
            )
        })?;
        let map_offset = Self::CHD_V5_HEADER_BYTES;
        let map_bytes = hunk_count_u64
            .checked_mul(4)
            .ok_or_else(|| RomWeaverError::Validation("chd map size overflow".to_string()))?;
        let after_map = map_offset
            .checked_add(map_bytes)
            .ok_or_else(|| RomWeaverError::Validation("chd file layout overflow".to_string()))?;
        let data_offset = if hunk_count == 0 {
            after_map
        } else {
            after_map.div_ceil(u64::from(hunk_bytes)) * u64::from(hunk_bytes)
        };
        let first_hunk_entry = u32::try_from(data_offset / u64::from(hunk_bytes))
            .map_err(|_| RomWeaverError::Validation("chd map entry overflow".to_string()))?;

        let mut output_file = File::options()
            .create(true)
            .write(true)
            .read(true)
            .truncate(true)
            .open(output)
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to create `{}`: {error}",
                    output.display()
                ))
            })?;

        let header = self.build_chd_v5_header(
            logical_bytes,
            map_offset,
            hunk_bytes,
            unit_bytes,
            [ChdCodec::NONE; CHD_MAX_COMPRESSORS],
            None,
        );
        output_file.write_all(&header).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to write CHD header to `{}`: {error}",
                output.display()
            ))
        })?;

        for hunk_index in 0..hunk_count {
            let entry = first_hunk_entry
                .checked_add(hunk_index)
                .ok_or_else(|| RomWeaverError::Validation("chd map entry overflow".into()))?;
            output_file
                .write_all(&entry.to_be_bytes())
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to write CHD map to `{}`: {error}",
                        output.display()
                    ))
                })?;
        }

        let mut pad_bytes = data_offset.saturating_sub(after_map);
        if pad_bytes > 0 {
            let padding = [0_u8; 8192];
            while pad_bytes > 0 {
                let write_len =
                    usize::try_from(pad_bytes.min(padding.len() as u64)).map_err(|_| {
                        RomWeaverError::Validation("chd alignment padding overflow".to_string())
                    })?;
                output_file
                    .write_all(&padding[..write_len])
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to write CHD alignment padding to `{}`: {error}",
                            output.display()
                        ))
                    })?;
                pad_bytes -= write_len as u64;
            }
        }

        let mut buffer = vec![0_u8; usize::try_from(hunk_bytes).unwrap_or(4096)];
        let mut remaining = logical_bytes;
        let mut raw_sha1 = Sha1::new();
        // The buffer starts fully zeroed. Full hunks overwrite every byte via `read_exact`
        // below, so the tail never goes stale; only the final short hunk leaves a tail that
        // must be re-zeroed before it is written out as padding.
        for _ in 0..hunk_count {
            let read_len = usize::try_from(remaining.min(u64::from(hunk_bytes))).map_err(|_| {
                RomWeaverError::Validation(
                    "decoded CHD chunk exceeded addressable memory".to_string(),
                )
            })?;
            if read_len < buffer.len() {
                buffer[read_len..].fill(0);
            }
            source
                .read_exact(&mut buffer[..read_len])
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to read source `{source_label}`: {error}",
                    ))
                })?;
            raw_sha1.update(&buffer[..read_len]);
            output_file.write_all(&buffer).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to write CHD data to `{}`: {error}",
                    output.display()
                ))
            })?;
            remaining = remaining.saturating_sub(read_len as u64);
            if let Some(on_progress) = on_progress {
                on_progress(read_len as u64);
            }
        }
        let metadata_entries = self.rust_metadata_entries(create_kind)?;
        if let Some(meta_offset) =
            self.append_rust_metadata(&mut output_file, output, &metadata_entries)?
        {
            self.patch_chd_header_u64(
                &mut output_file,
                output,
                Self::CHD_V5_HEADER_META_OFFSET,
                meta_offset,
                "metadata",
            )?;
        }
        let raw_sha1 = raw_sha1.finalize();
        let mut raw_sha1_bytes = [0_u8; Self::CHD_SHA1_BYTES];
        raw_sha1_bytes.copy_from_slice(&raw_sha1);
        self.patch_chd_header_sha1s(&mut output_file, output, &raw_sha1_bytes, &metadata_entries)?;
        output_file.flush().map_err(|error| {
            RomWeaverError::Validation(format!("failed to flush `{}`: {error}", output.display()))
        })?;

        Ok(ChdHeader {
            version: 5,
            logical_bytes,
            hunk_bytes,
            hunk_count,
            unit_bytes,
            unit_count: logical_bytes.div_ceil(u64::from(unit_bytes)),
            compressed: false,
            compression: [ChdCodec::NONE; CHD_MAX_COMPRESSORS],
            sha1: None,
            raw_sha1: None,
        })
    }

    pub(super) fn hunk_hash_key(bytes: &[u8]) -> HunkHashKey {
        let mut sha1 = [0_u8; 20];
        let digest = Sha1::digest(bytes);
        sha1.copy_from_slice(digest.as_slice());
        HunkHashKey {
            crc16: Self::crc16_ibm3740(bytes),
            sha1,
        }
    }

    pub(super) fn load_parent_reuse_index(
        &self,
        parent_source: &Path,
        expected_unit_bytes: u32,
        expected_hunk_bytes: u32,
    ) -> Result<ParentReuseIndex> {
        let mut parent = ChdReadSession::open_rust_chd(parent_source, None).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open parent chd `{}` for differential create: {error}",
                parent_source.display()
            ))
        })?;
        let parent_header = parent.header();
        let parent_sha1 = parent_header.sha1().ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "parent chd `{}` does not expose a sha1 in its header",
                parent_source.display()
            ))
        })?;
        if parent_header.unit_bytes() != expected_unit_bytes {
            return Err(RomWeaverError::Validation(format!(
                "parent chd `{}` unit size {} does not match child unit size {}",
                parent_source.display(),
                parent_header.unit_bytes(),
                expected_unit_bytes
            )));
        }
        if parent_header.hunk_size() != expected_hunk_bytes {
            return Err(RomWeaverError::Validation(format!(
                "parent chd `{}` hunk size {} does not match child hunk size {}",
                parent_source.display(),
                parent_header.hunk_size(),
                expected_hunk_bytes
            )));
        }
        if expected_unit_bytes == 0 || !expected_hunk_bytes.is_multiple_of(expected_unit_bytes) {
            return Err(RomWeaverError::Validation(
                "invalid parent/child geometry for differential create".to_string(),
            ));
        }
        let units_per_hunk = expected_hunk_bytes / expected_unit_bytes;
        let mut by_hash = HashMap::with_capacity(parent_header.hunk_count() as usize);
        let mut hunk_buffer = parent.get_hunksized_buffer();
        let mut compressed_buffer = Vec::new();
        for hunk_index in 0..parent_header.hunk_count() {
            let mut hunk = parent.hunk(hunk_index).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to read parent hunk {hunk_index} from `{}`: {error}",
                    parent_source.display()
                ))
            })?;
            hunk.read_hunk_in(&mut compressed_buffer, &mut hunk_buffer)
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to decode parent hunk {hunk_index} from `{}`: {error}",
                        parent_source.display()
                    ))
                })?;
            let key = Self::hunk_hash_key(&hunk_buffer);
            let parent_unit = u64::from(hunk_index).saturating_mul(u64::from(units_per_hunk));
            by_hash.entry(key).or_insert(parent_unit);
        }
        Ok(ParentReuseIndex {
            by_hash,
            sha1: parent_sha1,
        })
    }

    pub(super) fn force_compressed_payload_for_primary_codec(primary_codec: ChdCodec) -> bool {
        matches!(primary_codec, ChdCodec::HUFFMAN | ChdCodec::AVHUFF)
    }

    pub(super) fn prefer_compressed_payload(
        &self,
        primary_codec: ChdCodec,
        compressed_len: usize,
        raw_len: usize,
    ) -> bool {
        compressed_len < raw_len || Self::force_compressed_payload_for_primary_codec(primary_codec)
    }

    pub(super) fn create_compressed_rust_raw(
        &self,
        input: &Path,
        params: CompressedCreateParams<'_>,
    ) -> Result<ChdHeader> {
        let mut source = BufReader::new(File::open(input).map_err(|error| {
            RomWeaverError::Validation(format!("failed to open `{}`: {error}", input.display()))
        })?);
        let source_label = input.display().to_string();
        self.create_compressed_rust_stream(&mut source, &source_label, params)
    }

    pub(super) fn create_compressed_rust_stream(
        &self,
        source: &mut (dyn Read + Send),
        source_label: &str,
        params: CompressedCreateParams<'_>,
    ) -> Result<ChdHeader> {
        let CompressedCreateParams {
            output,
            logical_bytes,
            create_kind,
            codecs,
            compression_level,
            thread_count,
            parent_source,
            on_progress,
        } = params;
        let mut active_codecs = Vec::new();
        for (index, codec) in codecs.into_iter().enumerate() {
            if codec == ChdCodec::NONE {
                break;
            }
            if !self.supports_create_codec(create_kind, codec) {
                return Err(RomWeaverError::Unsupported(
                    UnsupportedOp::ChdCodecInvalidForMedia {
                        codec: self.codec_label(codec).to_string(),
                        media: self
                            .media_label(self.media_kind_from_create_kind(create_kind))
                            .to_string(),
                    },
                ));
            }
            active_codecs.push((index as u8, codec));
        }
        if active_codecs.is_empty() {
            return Err(RomWeaverError::Validation(
                "compressed rust CHD create requires at least one codec".to_string(),
            ));
        }
        let encodable_codecs = active_codecs
            .iter()
            .copied()
            .filter(|(_, codec)| self.supports_rust_encode_codec(create_kind, *codec))
            .collect::<Vec<_>>();
        let primary_codec = active_codecs[0].1;

        let hunk_bytes = self.hunk_bytes(create_kind, logical_bytes, primary_codec);
        let unit_bytes = self.unit_bytes(create_kind);
        if hunk_bytes == 0 || unit_bytes == 0 || !hunk_bytes.is_multiple_of(unit_bytes) {
            return Err(RomWeaverError::Validation(
                "invalid CHD geometry for rust compressed create".into(),
            ));
        }

        let hunk_count_u64 = logical_bytes.div_ceil(u64::from(hunk_bytes));
        let hunk_count = u32::try_from(hunk_count_u64).map_err(|_| {
            RomWeaverError::Validation(
                "input is too large for CHD v5 hunk table limits".to_string(),
            )
        })?;
        let hunk_count_usize = usize::try_from(hunk_count_u64).map_err(|_| {
            RomWeaverError::Validation("CHD hunk count exceeded addressable memory".to_string())
        })?;
        let hunk_bytes_usize = usize::try_from(hunk_bytes).map_err(|_| {
            RomWeaverError::Validation("CHD hunk size exceeded addressable memory".to_string())
        })?;
        let parent_reuse = match parent_source {
            Some(parent_source) => {
                Some(self.load_parent_reuse_index(parent_source, unit_bytes, hunk_bytes)?)
            }
            None => None,
        };
        let parent_sha1 = parent_reuse.as_ref().map(|value| value.sha1);

        let mut output_file = File::options()
            .create(true)
            .write(true)
            .read(true)
            .truncate(true)
            .open(output)
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to create `{}`: {error}",
                    output.display()
                ))
            })?;
        let placeholder_header = self.build_chd_v5_header(
            logical_bytes,
            0,
            hunk_bytes,
            unit_bytes,
            codecs,
            parent_sha1,
        );
        output_file
            .write_all(&placeholder_header)
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to write CHD header to `{}`: {error}",
                    output.display()
                ))
            })?;

        let effective_threads = thread_count.max(1).min(hunk_count_usize.max(1));
        debug!(
            primary_codec = ?primary_codec,
            encodable_codecs = encodable_codecs.len(),
            hunk_count,
            hunk_bytes,
            unit_bytes,
            level = compression_level,
            requested_threads = thread_count,
            effective_threads,
            has_parent = parent_reuse.is_some(),
            "chd compressed create start"
        );

        let mut entries = Vec::with_capacity(hunk_count_usize);
        let mut current_offset = Self::CHD_V5_HEADER_BYTES;
        let mut self_hunks_by_hash = HashMap::<HunkHashKey, u64>::with_capacity(hunk_count_usize);
        let parent_hunks_by_hash = parent_reuse.as_ref().map(|value| &value.by_hash);

        // Buffer the sequential per-hunk payload appends: with small hunks (e.g. the 4 KiB
        // DVD hunk) a large image can be hundreds of thousands of hunks, and one write
        // syscall per hunk dominates the single writer thread. The map/metadata/header-patch
        // phase below uses seeks, so we flush and reclaim the raw File before that starts.
        let mut buffered = BufWriter::with_capacity(8 * 1024 * 1024, output_file);

        let raw_sha1_bytes: [u8; Self::CHD_SHA1_BYTES] = if effective_threads <= 1 {
            // Sequential path: no worker threads are spawned, so this also serves targets
            // without thread support. Hunks are read,
            // hashed, compressed, and appended in order on the calling thread.
            trace!(hunk_count, "chd compressed create sequential path");
            let mut raw_sha1 = Sha1::new();
            let mut remaining = logical_bytes;
            let mut scratch = ChdCompressionScratch::default();
            for hunk_index in 0..hunk_count_usize {
                let read_len =
                    usize::try_from(remaining.min(u64::from(hunk_bytes))).map_err(|_| {
                        RomWeaverError::Validation(
                            "decoded CHD chunk exceeded addressable memory".to_string(),
                        )
                    })?;
                let mut hunk = vec![0_u8; hunk_bytes_usize];
                source.read_exact(&mut hunk[..read_len]).map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to read source `{source_label}`: {error}",
                    ))
                })?;
                raw_sha1.update(&hunk[..read_len]);
                remaining = remaining.saturating_sub(read_len as u64);
                if let Some(on_progress) = on_progress {
                    on_progress(read_len as u64);
                }
                let (hash_key, compression_type, payload) = self.compress_pipeline_hunk(
                    create_kind,
                    primary_codec,
                    &encodable_codecs,
                    compression_level,
                    hunk,
                    &mut scratch,
                )?;
                self.record_pipeline_hunk(
                    &mut buffered,
                    PipelineHunkRecord {
                        output,
                        entries: &mut entries,
                        current_offset: &mut current_offset,
                        self_hunks_by_hash: &mut self_hunks_by_hash,
                        parent_hunks_by_hash,
                        hunk_index,
                        hash_key,
                        compression_type,
                        payload,
                    },
                )?;
            }
            let mut digest = [0_u8; Self::CHD_SHA1_BYTES];
            digest.copy_from_slice(&raw_sha1.finalize());
            digest
        } else {
            // Bounded streaming compression pipeline: source reads and ordered output appends
            // stay on the coordinator thread, so browser workers never open OPFS paths. Worker
            // threads only hash + compress in-memory hunks, while the shared helper bounds
            // inflight work and drains producers on error before the scoped threads join.
            trace!(
                hunk_count,
                effective_threads, "chd compressed create streaming pipeline path"
            );
            let mut raw_sha1 = Sha1::new();
            let mut remaining = logical_bytes;
            ordered_streaming_compress(
                0..hunk_count_usize,
                effective_threads,
                OrderedStreamingMessages {
                    worker_closed: "chd compression workers ended before all hunks were consumed",
                    result_closed: "chd compression pipeline ended before all hunks were produced",
                },
                |hunk_index, _| {
                    let read_len =
                        usize::try_from(remaining.min(u64::from(hunk_bytes))).map_err(|_| {
                            RomWeaverError::Validation(
                                "decoded CHD chunk exceeded addressable memory".to_string(),
                            )
                        })?;
                    let mut hunk = vec![0_u8; hunk_bytes_usize];
                    source.read_exact(&mut hunk[..read_len]).map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to read source `{source_label}`: {error}",
                        ))
                    })?;
                    raw_sha1.update(&hunk[..read_len]);
                    remaining = remaining.saturating_sub(read_len as u64);
                    if let Some(on_progress) = on_progress {
                        on_progress(read_len as u64);
                    }
                    Ok((hunk_index, hunk))
                },
                ChdCompressionScratch::default,
                |scratch, _, (hunk_index, hunk)| {
                    self.compress_pipeline_hunk(
                        create_kind,
                        primary_codec,
                        &encodable_codecs,
                        compression_level,
                        hunk,
                        scratch,
                    )
                    .map(|(hash_key, compression_type, payload)| {
                        (hunk_index, hash_key, compression_type, payload)
                    })
                },
                |hunk_index, (reported_index, hash_key, compression_type, payload)| {
                    if reported_index != hunk_index {
                        return Err(RomWeaverError::Validation(format!(
                            "chd compression pipeline produced hunk {reported_index} while collecting hunk {hunk_index}"
                        )));
                    }
                    self.record_pipeline_hunk(
                        &mut buffered,
                        PipelineHunkRecord {
                            output,
                            entries: &mut entries,
                            current_offset: &mut current_offset,
                            self_hunks_by_hash: &mut self_hunks_by_hash,
                            parent_hunks_by_hash,
                            hunk_index,
                            hash_key,
                            compression_type,
                            payload,
                        },
                    )
                },
            )?;
            let mut digest = [0_u8; Self::CHD_SHA1_BYTES];
            digest.copy_from_slice(&raw_sha1.finalize());
            digest
        };

        // Flush buffered hunk payloads and reclaim the raw File for the seek-based map,
        // metadata, and header-patch writes below.
        let mut output_file = buffered.into_inner().map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to flush CHD data to `{}`: {error}",
                output.display()
            ))
        })?;

        let map_offset = current_offset;
        let (map_payload, map_crc, length_bits, self_bits, parent_bits, first_offset) =
            Self::encode_v5_compressed_map(&entries, hunk_bytes, unit_bytes)?;
        let map_bytes = u32::try_from(map_payload.len()).map_err(|_| {
            RomWeaverError::Validation("compressed CHD map exceeded u32 size".to_string())
        })?;
        let mut map_header = [0_u8; 16];
        map_header[..4].copy_from_slice(&map_bytes.to_be_bytes());
        Self::write_u48_be(&mut map_header[4..10], first_offset)?;
        map_header[10..12].copy_from_slice(&map_crc.to_be_bytes());
        map_header[12] = length_bits;
        map_header[13] = self_bits;
        map_header[14] = parent_bits;
        map_header[15] = 0;
        output_file.write_all(&map_header).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to write CHD map header to `{}`: {error}",
                output.display()
            ))
        })?;
        output_file.write_all(&map_payload).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to write CHD map payload to `{}`: {error}",
                output.display()
            ))
        })?;

        self.patch_chd_header_u64(
            &mut output_file,
            output,
            Self::CHD_V5_HEADER_MAP_OFFSET,
            map_offset,
            "map",
        )?;
        let metadata_entries = self.rust_metadata_entries(create_kind)?;
        if let Some(meta_offset) =
            self.append_rust_metadata(&mut output_file, output, &metadata_entries)?
        {
            self.patch_chd_header_u64(
                &mut output_file,
                output,
                Self::CHD_V5_HEADER_META_OFFSET,
                meta_offset,
                "metadata",
            )?;
        }
        self.patch_chd_header_sha1s(&mut output_file, output, &raw_sha1_bytes, &metadata_entries)?;
        output_file.flush().map_err(|error| {
            RomWeaverError::Validation(format!("failed to flush `{}`: {error}", output.display()))
        })?;
        debug!(
            hunk_count,
            unique_hunks = self_hunks_by_hash.len(),
            map_offset,
            map_bytes,
            "chd compressed create done"
        );

        Ok(ChdHeader {
            version: 5,
            logical_bytes,
            hunk_bytes,
            hunk_count,
            unit_bytes,
            unit_count: logical_bytes.div_ceil(u64::from(unit_bytes)),
            compressed: true,
            compression: codecs,
            sha1: None,
            raw_sha1: None,
        })
    }
}
