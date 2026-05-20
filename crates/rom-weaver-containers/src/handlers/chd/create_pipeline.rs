    impl ChdContainerHandler {
        fn create_uncompressed_rust_raw(
            &self,
            input: &Path,
            output: &Path,
            logical_bytes: u64,
            create_kind: &ChdCreateKind,
        ) -> Result<ChdHeader> {
            if matches!(create_kind, ChdCreateKind::Av(_)) {
                return Err(RomWeaverError::Unsupported(
                    "rust chd create currently supports only raw/dvd/hd/disc `store` mode".into(),
                ));
            }

            let hunk_bytes = self.hunk_bytes(create_kind, logical_bytes, ChdCodec::NONE);
            let unit_bytes = self.unit_bytes(create_kind);
            if hunk_bytes == 0 || unit_bytes == 0 || hunk_bytes % unit_bytes != 0 {
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
            let after_map = map_offset.checked_add(map_bytes).ok_or_else(|| {
                RomWeaverError::Validation("chd file layout overflow".to_string())
            })?;
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

            let mut reader = BufReader::new(File::open(input).map_err(|error| {
                RomWeaverError::Validation(format!("failed to open `{}`: {error}", input.display()))
            })?);
            let mut buffer = vec![0_u8; usize::try_from(hunk_bytes).unwrap_or(4096)];
            let mut remaining = logical_bytes;
            for _ in 0..hunk_count {
                buffer.fill(0);
                let read_len =
                    usize::try_from(remaining.min(u64::from(hunk_bytes))).map_err(|_| {
                        RomWeaverError::Validation(
                            "decoded CHD chunk exceeded addressable memory".to_string(),
                        )
                    })?;
                reader
                    .read_exact(&mut buffer[..read_len])
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to read source `{}`: {error}",
                            input.display()
                        ))
                    })?;
                output_file.write_all(&buffer).map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to write CHD data to `{}`: {error}",
                        output.display()
                    ))
                })?;
                remaining = remaining.saturating_sub(read_len as u64);
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
            self.patch_chd_header_sha1s(
                &mut output_file,
                output,
                input,
                logical_bytes,
                &metadata_entries,
            )?;
            output_file.flush().map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to flush `{}`: {error}",
                    output.display()
                ))
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
            })
        }

        fn hunk_hash_key(bytes: &[u8]) -> HunkHashKey {
            let mut sha1 = [0_u8; 20];
            let digest = Sha1::digest(bytes);
            sha1.copy_from_slice(digest.as_slice());
            HunkHashKey {
                crc16: Self::crc16_ibm3740(bytes),
                sha1,
            }
        }

        fn load_parent_reuse_index(
            &self,
            parent_source: &Path,
            expected_unit_bytes: u32,
            expected_hunk_bytes: u32,
        ) -> Result<ParentReuseIndex> {
            let mut parent =
                ChdReadSession::open_rust_chd(parent_source, None).map_err(|error| {
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
            if expected_unit_bytes == 0 || expected_hunk_bytes % expected_unit_bytes != 0 {
                return Err(RomWeaverError::Validation(
                    "invalid parent/child geometry for differential create".to_string(),
                ));
            }
            let units_per_hunk = expected_hunk_bytes / expected_unit_bytes;
            let mut by_hash = BTreeMap::new();
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

        fn force_compressed_payload_for_primary_codec(primary_codec: ChdCodec) -> bool {
            matches!(primary_codec, ChdCodec::HUFFMAN | ChdCodec::AVHUFF)
        }

        fn prefer_compressed_payload(
            &self,
            primary_codec: ChdCodec,
            compressed_len: usize,
            raw_len: usize,
        ) -> bool {
            compressed_len < raw_len
                || Self::force_compressed_payload_for_primary_codec(primary_codec)
        }

        fn create_compressed_rust_raw(
            &self,
            input: &Path,
            output: &Path,
            logical_bytes: u64,
            create_kind: &ChdCreateKind,
            codecs: [ChdCodec; CHD_MAX_COMPRESSORS],
            compression_level: i32,
            thread_count: usize,
            parent_source: Option<&Path>,
        ) -> Result<ChdHeader> {
            let mut active_codecs = Vec::new();
            for (index, codec) in codecs.into_iter().enumerate() {
                if codec == ChdCodec::NONE {
                    break;
                }
                if !self.supports_create_codec(create_kind, codec) {
                    return Err(RomWeaverError::Unsupported(format!(
                        "chd codec `{}` is not valid for {} media",
                        self.codec_label(codec),
                        self.media_label(self.media_kind_from_create_kind(create_kind))
                    )));
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
            if hunk_bytes == 0 || unit_bytes == 0 || hunk_bytes % unit_bytes != 0 {
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

            let mut source = BufReader::new(File::open(input).map_err(|error| {
                RomWeaverError::Validation(format!("failed to open `{}`: {error}", input.display()))
            })?);
            let effective_threads = thread_count.max(1).min(hunk_count_usize.max(1));
            let pool = if effective_threads > 1 {
                Some(
                    rayon::ThreadPoolBuilder::new()
                        .num_threads(effective_threads)
                        .build()
                        .map_err(|error| {
                            RomWeaverError::Validation(format!(
                                "failed to build CHD rust create pool (threads={}): {error}",
                                effective_threads
                            ))
                        })?,
                )
            } else {
                None
            };
            let batch_size = effective_threads.saturating_mul(4).max(1);
            let mut entries = Vec::with_capacity(hunk_count_usize);
            let mut remaining = logical_bytes;
            let mut current_offset = Self::CHD_V5_HEADER_BYTES;
            let mut self_hunks_by_hash = BTreeMap::<HunkHashKey, u64>::new();
            let parent_hunks_by_hash = parent_reuse.as_ref().map(|value| &value.by_hash);
            let mut next_hunk = 0usize;
            while next_hunk < hunk_count_usize {
                let this_batch = (hunk_count_usize - next_hunk).min(batch_size);
                enum BatchHunkEntry {
                    SelfCopy(u64),
                    ParentCopy(u64),
                    Data(Vec<u8>),
                }
                let mut batch_hunks = Vec::with_capacity(this_batch);
                for batch_index in 0..this_batch {
                    let mut hunk = vec![0_u8; hunk_bytes_usize];
                    let read_len =
                        usize::try_from(remaining.min(u64::from(hunk_bytes))).map_err(|_| {
                            RomWeaverError::Validation(
                                "decoded CHD chunk exceeded addressable memory".to_string(),
                            )
                        })?;
                    source.read_exact(&mut hunk[..read_len]).map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to read source `{}`: {error}",
                            input.display()
                        ))
                    })?;
                    remaining = remaining.saturating_sub(read_len as u64);
                    let key = Self::hunk_hash_key(&hunk);
                    if let Some(&other_hunk) = self_hunks_by_hash.get(&key) {
                        batch_hunks.push(BatchHunkEntry::SelfCopy(other_hunk));
                        continue;
                    }
                    if let Some(parent_hunks_by_hash) = parent_hunks_by_hash
                        && let Some(&parent_unit) = parent_hunks_by_hash.get(&key)
                    {
                        batch_hunks.push(BatchHunkEntry::ParentCopy(parent_unit));
                        continue;
                    }
                    let hunk_index = next_hunk.saturating_add(batch_index);
                    self_hunks_by_hash.insert(key, hunk_index as u64);
                    batch_hunks.push(BatchHunkEntry::Data(hunk));
                }

                let mut data_hunks = Vec::<(usize, Vec<u8>)>::new();
                for (index, entry) in batch_hunks.iter_mut().enumerate() {
                    if let BatchHunkEntry::Data(hunk) = entry {
                        data_hunks.push((index, std::mem::take(hunk)));
                    }
                }
                let compressed_hunks: Vec<Result<(usize, u8, Vec<u8>, u16)>> = if let Some(pool) =
                    &pool
                {
                    if data_hunks.len() > 1 {
                        pool.install(|| {
                            data_hunks
                                .into_par_iter()
                                .map(|(index, hunk)| {
                                    let crc = Self::crc16_ibm3740(&hunk);
                                    let mut best: Option<(u8, Vec<u8>)> = None;
                                    for (codec_slot, codec) in &encodable_codecs {
                                        let compressed = self.compress_rust_hunk(
                                            create_kind,
                                            *codec,
                                            compression_level,
                                            &hunk,
                                        )?;
                                        if best
                                            .as_ref()
                                            .map(|(_, candidate)| {
                                                compressed.len() < candidate.len()
                                            })
                                            .unwrap_or(true)
                                        {
                                            best = Some((*codec_slot, compressed));
                                        }
                                    }
                                    let (compression_type, payload) = best
                                        .filter(|(_, compressed)| {
                                            self.prefer_compressed_payload(
                                                primary_codec,
                                                compressed.len(),
                                                hunk.len(),
                                            )
                                        })
                                        .unwrap_or((Self::CHD_V5_MAP_TYPE_UNCOMPRESSED, hunk));
                                    Ok((index, compression_type, payload, crc))
                                })
                                .collect()
                        })
                    } else {
                        data_hunks
                            .into_iter()
                            .map(|(index, hunk)| {
                                let crc = Self::crc16_ibm3740(&hunk);
                                let mut best: Option<(u8, Vec<u8>)> = None;
                                for (codec_slot, codec) in &encodable_codecs {
                                    let compressed = self.compress_rust_hunk(
                                        create_kind,
                                        *codec,
                                        compression_level,
                                        &hunk,
                                    )?;
                                    if best
                                        .as_ref()
                                        .map(|(_, candidate)| compressed.len() < candidate.len())
                                        .unwrap_or(true)
                                    {
                                        best = Some((*codec_slot, compressed));
                                    }
                                }
                                let (compression_type, payload) = best
                                    .filter(|(_, compressed)| {
                                        self.prefer_compressed_payload(
                                            primary_codec,
                                            compressed.len(),
                                            hunk.len(),
                                        )
                                    })
                                    .unwrap_or((Self::CHD_V5_MAP_TYPE_UNCOMPRESSED, hunk));
                                Ok((index, compression_type, payload, crc))
                            })
                            .collect()
                    }
                } else {
                    data_hunks
                        .into_iter()
                        .map(|(index, hunk)| {
                            let crc = Self::crc16_ibm3740(&hunk);
                            let mut best: Option<(u8, Vec<u8>)> = None;
                            for (codec_slot, codec) in &encodable_codecs {
                                let compressed = self.compress_rust_hunk(
                                    create_kind,
                                    *codec,
                                    compression_level,
                                    &hunk,
                                )?;
                                if best
                                    .as_ref()
                                    .map(|(_, candidate)| compressed.len() < candidate.len())
                                    .unwrap_or(true)
                                {
                                    best = Some((*codec_slot, compressed));
                                }
                            }
                            let (compression_type, payload) = best
                                .filter(|(_, compressed)| {
                                    self.prefer_compressed_payload(
                                        primary_codec,
                                        compressed.len(),
                                        hunk.len(),
                                    )
                                })
                                .unwrap_or((Self::CHD_V5_MAP_TYPE_UNCOMPRESSED, hunk));
                            Ok((index, compression_type, payload, crc))
                        })
                        .collect()
                };
                let mut data_results = vec![None; batch_hunks.len()];
                for result in compressed_hunks {
                    let (index, compression_type, payload, crc16) = result?;
                    data_results[index] = Some((compression_type, payload, crc16));
                }

                for (index, entry) in batch_hunks.into_iter().enumerate() {
                    match entry {
                        BatchHunkEntry::SelfCopy(other_hunk) => {
                            entries.push(RustCompressedHunkEntry {
                                compression_type: Self::CHD_V5_MAP_TYPE_SELF,
                                offset: other_hunk,
                                length: 0,
                                crc16: 0,
                            })
                        }
                        BatchHunkEntry::ParentCopy(parent_unit) => {
                            entries.push(RustCompressedHunkEntry {
                                compression_type: Self::CHD_V5_MAP_TYPE_PARENT,
                                offset: parent_unit,
                                length: 0,
                                crc16: 0,
                            })
                        }
                        BatchHunkEntry::Data(_) => {
                            let Some((compression_type, payload, crc16)) =
                                data_results[index].take()
                            else {
                                return Err(RomWeaverError::Validation(
                                    "internal CHD compression result mismatch".to_string(),
                                ));
                            };
                            let length = u32::try_from(payload.len()).map_err(|_| {
                                RomWeaverError::Validation(
                                    "compressed CHD chunk exceeded u32 size".into(),
                                )
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
                                offset: current_offset,
                                length,
                                crc16,
                            });
                            current_offset = current_offset.saturating_add(u64::from(length));
                        }
                    }
                }
                next_hunk += this_batch;
            }

            let map_offset = current_offset;
            let (map_payload, map_crc, length_bits, self_bits, parent_bits, first_offset) =
                Self::encode_v5_compressed_map(&entries)?;
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
            self.patch_chd_header_sha1s(
                &mut output_file,
                output,
                input,
                logical_bytes,
                &metadata_entries,
            )?;
            output_file.flush().map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to flush `{}`: {error}",
                    output.display()
                ))
            })?;

            Ok(ChdHeader {
                version: 5,
                logical_bytes,
                hunk_bytes,
                hunk_count,
                unit_bytes,
                unit_count: logical_bytes.div_ceil(u64::from(unit_bytes)),
                compressed: true,
                compression: codecs,
            })
        }

    }
