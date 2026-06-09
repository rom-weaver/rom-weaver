use super::*;

impl ChdContainerHandler {
    pub(super) const DEFAULT_HUNK_BYTES: u32 = 4096;
    pub(super) const DVD_SECTOR_BYTES: u32 = 2048;
    pub(super) const HD_SECTOR_BYTES: u32 = 512;
    pub(super) const CD_FRAME_BYTES: u32 = CD_FRAME_SIZE;
    pub(super) const CD_HUNK_BYTES: u32 = CD_FRAME_SIZE * 8;
    pub(super) const FLAC_CHANNELS: usize = 2;
    pub(super) const FLAC_BITS_PER_SAMPLE: usize = 16;
    pub(super) const FLAC_SAMPLE_RATE_HZ: usize = 44_100;
    pub(super) const CD_SECTOR_DATA_BYTES: usize = 2352;
    pub(super) const CD_SUBCODE_BYTES: usize = 96;
    pub(super) const ZLIB_LEVEL_MIN: i32 = 1;
    pub(super) const ZLIB_LEVEL_MAX: i32 = 9;
    pub(super) const ZSTD_LEVEL_MIN: i32 = -7;
    pub(super) const LZMA_LEVEL_MIN: i32 = 0;
    pub(super) const LZMA_LEVEL_MAX: i32 = 9;
    pub(super) const FLAC_LEVEL_MIN: i32 = 0;
    pub(super) const FLAC_LEVEL_MAX: i32 = 9;
    pub(super) const CHD_V5_HEADER_BYTES: u64 = 124;
    pub(super) const CHD_V5_MAP_TYPE_COMPRESSED_MAX: u8 = 3;
    pub(super) const CHD_V5_MAP_TYPE_UNCOMPRESSED: u8 = 4;
    pub(super) const CHD_V5_MAP_TYPE_SELF: u8 = 5;
    pub(super) const CHD_V5_MAP_TYPE_PARENT: u8 = 6;
    pub(super) const CHD_V5_MAP_TYPE_RLE_SMALL: u8 = 7;
    pub(super) const CHD_V5_MAP_TYPE_RLE_LARGE: u8 = 8;
    pub(super) const CHD_V5_MAP_TYPE_SELF0: u8 = 9;
    pub(super) const CHD_V5_MAP_TYPE_SELF1: u8 = 10;
    pub(super) const CHD_V5_MAP_TYPE_PARENT_SELF: u8 = 11;
    pub(super) const CHD_V5_MAP_TYPE_PARENT0: u8 = 12;
    pub(super) const CHD_V5_MAP_TYPE_PARENT1: u8 = 13;
    pub(super) const CHD_V5_MAP_SYMBOL_COUNT: usize = 16;
    pub(super) const CHD_V5_HEADER_MAP_OFFSET: u64 = 40;
    pub(super) const CHD_V5_HEADER_META_OFFSET: u64 = 48;
    pub(super) const CHD_V5_HEADER_RAW_SHA1_OFFSET: u64 = 64;
    pub(super) const CHD_V5_HEADER_SHA1_OFFSET: u64 = 84;
    pub(super) const CHD_V5_HEADER_PARENT_SHA1_OFFSET: u64 = 104;
    pub(super) const CHD_SHA1_BYTES: usize = 20;
    pub(super) const SUPPORTED_CODEC_CLAUSE: &str = "supported codecs are store, zlib, zstd, lzma, huff (alias: huffman), flac, cdlz, cdzl, cdzs, cdfl, and avhuff (alias: avhu)";
    pub(super) const HUFFMAN_SMALL_TREE_BITS: [u8; 5] = [1, 7, 0, 1, 7];
    pub(super) const AVHUFF_DELTA_TREE_SYMBOLS: usize = 256 + 16;
    pub(super) const AVHUFF_DELTA_TREE_BITS: u8 = 5;
    pub(super) const AVHUFF_DELTA_TREE_8BIT_COUNT: usize = 240;

    pub(super) fn progress_bytes_callback(
        &self,
        context: &OperationContext,
        execution: &ThreadExecution,
        command: &'static str,
        stage: &'static str,
        total_bytes: u64,
        label: String,
    ) -> Arc<dyn Fn(u64) + Send + Sync> {
        let context = context.clone();
        let execution = execution.clone();
        let label = Arc::new(label);
        let completed_bytes = Arc::new(AtomicU64::new(0));
        let emitted_progress_bucket = Arc::new(AtomicU8::new(0));
        Arc::new(move |delta_bytes: u64| {
            if total_bytes == 0 || delta_bytes == 0 {
                return;
            }
            let completed = completed_bytes
                .fetch_add(delta_bytes, Ordering::Relaxed)
                .saturating_add(delta_bytes)
                .min(total_bytes);
            maybe_emit_container_byte_progress(
                &context,
                completed,
                total_bytes,
                ContainerByteProgress {
                    command,
                    format: CHD.name,
                    stage,
                    label: label.as_str(),
                    thread_execution: Some(&execution),
                    emitted_progress_bucket: emitted_progress_bucket.as_ref(),
                },
            );
        })
    }

    pub(super) fn supports_rust_create(
        &self,
        create_kind: &ChdCreateKind,
        codecs: [ChdCodec; CHD_MAX_COMPRESSORS],
        primary_codec: ChdCodec,
    ) -> bool {
        let mut active_codecs = Vec::new();
        let mut saw_none = false;
        for codec in codecs {
            if codec == ChdCodec::NONE {
                saw_none = true;
                continue;
            }
            if saw_none {
                // Codec slots must be contiguous.
                return false;
            }
            active_codecs.push(codec);
        }
        if primary_codec == ChdCodec::NONE {
            return active_codecs.is_empty() && !matches!(create_kind, ChdCreateKind::Av(_));
        }
        if active_codecs.is_empty() || active_codecs[0] != primary_codec {
            return false;
        }
        active_codecs
            .into_iter()
            .all(|codec| self.supports_create_codec(create_kind, codec))
    }

    pub(super) fn supports_create_codec(
        &self,
        create_kind: &ChdCreateKind,
        codec: ChdCodec,
    ) -> bool {
        match create_kind {
            ChdCreateKind::Raw | ChdCreateKind::Dvd | ChdCreateKind::HardDisk(_) => {
                matches!(
                    codec,
                    ChdCodec::NONE
                        | ChdCodec::ZSTD
                        | ChdCodec::ZLIB
                        | ChdCodec::LZMA
                        | ChdCodec::HUFFMAN
                        | ChdCodec::FLAC
                )
            }
            ChdCreateKind::Disc(_) => {
                matches!(
                    codec,
                    ChdCodec::NONE
                        | ChdCodec::CD_ZSTD
                        | ChdCodec::CD_ZLIB
                        | ChdCodec::CD_LZMA
                        | ChdCodec::CD_FLAC
                )
            }
            ChdCreateKind::Av(_) => matches!(codec, ChdCodec::NONE | ChdCodec::AVHUFF),
        }
    }

    pub(super) fn supports_rust_encode_codec(
        &self,
        create_kind: &ChdCreateKind,
        codec: ChdCodec,
    ) -> bool {
        match create_kind {
            ChdCreateKind::Raw | ChdCreateKind::Dvd | ChdCreateKind::HardDisk(_) => {
                matches!(
                    codec,
                    ChdCodec::ZSTD
                        | ChdCodec::ZLIB
                        | ChdCodec::LZMA
                        | ChdCodec::HUFFMAN
                        | ChdCodec::FLAC
                )
            }
            ChdCreateKind::Disc(_) => {
                matches!(
                    codec,
                    ChdCodec::CD_ZSTD | ChdCodec::CD_ZLIB | ChdCodec::CD_LZMA | ChdCodec::CD_FLAC
                )
            }
            ChdCreateKind::Av(_) => matches!(codec, ChdCodec::AVHUFF),
        }
    }

    pub(super) fn should_attempt_rust_create(
        &self,
        create_kind: &ChdCreateKind,
        codecs: [ChdCodec; CHD_MAX_COMPRESSORS],
        primary_codec: ChdCodec,
    ) -> bool {
        self.supports_rust_create(create_kind, codecs, primary_codec)
    }

    pub(super) fn media_kind_from_create_kind(&self, create_kind: &ChdCreateKind) -> ChdMediaKind {
        match create_kind {
            ChdCreateKind::Raw => ChdMediaKind::Raw,
            ChdCreateKind::HardDisk(_) => ChdMediaKind::HardDisk,
            ChdCreateKind::Dvd => ChdMediaKind::Dvd,
            ChdCreateKind::Disc(layout) => match layout.kind {
                DiscKind::CdRom => ChdMediaKind::CdRom,
                DiscKind::GdRom => ChdMediaKind::GdRom,
            },
            ChdCreateKind::Av(_) => ChdMediaKind::Av,
        }
    }

    pub(super) fn media_label(&self, media_kind: ChdMediaKind) -> &'static str {
        match media_kind {
            ChdMediaKind::Raw => "raw",
            ChdMediaKind::HardDisk => "hd",
            ChdMediaKind::CdRom => "cd",
            ChdMediaKind::GdRom => "gd",
            ChdMediaKind::Dvd => "dvd",
            ChdMediaKind::Av => "av",
        }
    }

    pub(super) fn resolve_compression_plan(
        &self,
        codec: Option<&str>,
        create_kind: &ChdCreateKind,
    ) -> Result<ChdCompressionPlan> {
        if let Some(codecs) = self.parse_explicit_codecs(codec)? {
            return self.explicit_codec_plan(codecs);
        }
        Ok(self.default_compression_plan(create_kind))
    }

    pub(super) fn normalize_compression_plan_for_create_kind(
        &self,
        create_kind: &ChdCreateKind,
        mut plan: ChdCompressionPlan,
    ) -> ChdCompressionPlan {
        if matches!(create_kind, ChdCreateKind::Disc(_)) {
            let map_disc_codec = |codec: ChdCodec| match codec {
                ChdCodec::ZSTD => ChdCodec::CD_ZSTD,
                ChdCodec::ZLIB => ChdCodec::CD_ZLIB,
                ChdCodec::LZMA => ChdCodec::CD_LZMA,
                ChdCodec::FLAC => ChdCodec::CD_FLAC,
                other => other,
            };
            plan.codecs = plan.codecs.map(map_disc_codec);
            plan.primary_codec = map_disc_codec(plan.primary_codec);
        }

        plan
    }

    #[cfg(any(test, feature = "test-utils"))]
    pub fn default_cd_compression_plan_for_tests(
        &self,
    ) -> Result<([ChdCodec; CHD_MAX_COMPRESSORS], ChdCodec)> {
        let create_kind = ChdCreateKind::Disc(DiscLayout {
            kind: DiscKind::CdRom,
            tracks: Vec::new(),
        });
        let plan = self.resolve_compression_plan(None, &create_kind)?;
        Ok((plan.codecs, plan.primary_codec))
    }

    #[cfg(any(test, feature = "test-utils"))]
    pub fn default_dvd_compression_plan_for_tests(
        &self,
    ) -> Result<([ChdCodec; CHD_MAX_COMPRESSORS], ChdCodec)> {
        let plan = self.resolve_compression_plan(None, &ChdCreateKind::Dvd)?;
        Ok((plan.codecs, plan.primary_codec))
    }

    #[cfg(any(test, feature = "test-utils"))]
    pub fn default_raw_compression_plan_for_tests(
        &self,
    ) -> Result<([ChdCodec; CHD_MAX_COMPRESSORS], ChdCodec)> {
        let plan = self.resolve_compression_plan(None, &ChdCreateKind::Raw)?;
        Ok((plan.codecs, plan.primary_codec))
    }

    #[cfg(any(test, feature = "test-utils"))]
    pub fn explicit_compression_plan_for_tests(
        &self,
        codecs: &str,
    ) -> Result<([ChdCodec; CHD_MAX_COMPRESSORS], ChdCodec)> {
        let plan = self.resolve_compression_plan(Some(codecs), &ChdCreateKind::Raw)?;
        Ok((plan.codecs, plan.primary_codec))
    }

    #[cfg(any(test, feature = "test-utils"))]
    pub fn rust_backend_can_create_with_codec_list_for_tests(&self, codecs: &str) -> Result<bool> {
        let plan = self.resolve_compression_plan(Some(codecs), &ChdCreateKind::Raw)?;
        Ok(self.should_attempt_rust_create(&ChdCreateKind::Raw, plan.codecs, plan.primary_codec))
    }

    #[cfg(any(test, feature = "test-utils"))]
    pub fn create_raw_store_with_rust_backend_for_tests(
        &self,
        source: &Path,
        output: &Path,
    ) -> Result<ChdHeader> {
        let logical_bytes = fs::metadata(source)?.len();
        self.create_uncompressed_rust_raw(source, output, logical_bytes, &ChdCreateKind::Raw, None)
    }

    #[cfg(any(test, feature = "test-utils"))]
    pub fn create_raw_with_rust_backend_codec_for_tests(
        &self,
        source: &Path,
        output: &Path,
        codec: ChdCodec,
        level: i32,
        thread_count: usize,
    ) -> Result<ChdHeader> {
        let logical_bytes = fs::metadata(source)?.len();
        if codec == ChdCodec::NONE {
            self.create_uncompressed_rust_raw(
                source,
                output,
                logical_bytes,
                &ChdCreateKind::Raw,
                None,
            )
        } else {
            self.create_compressed_rust_raw(
                source,
                CompressedCreateParams {
                    output,
                    logical_bytes,
                    create_kind: &ChdCreateKind::Raw,
                    codecs: [codec, ChdCodec::NONE, ChdCodec::NONE, ChdCodec::NONE],
                    compression_level: level,
                    thread_count,
                    parent_source: None,
                    on_progress: None,
                },
            )
        }
    }

    #[cfg(any(test, feature = "test-utils"))]
    pub fn extract_raw_with_rust_backend_for_tests(
        &self,
        source: &Path,
        output: &Path,
        thread_count: usize,
    ) -> Result<()> {
        let session =
            ChdReadSession::open_rust(source, None).map_err(RomWeaverError::Validation)?;
        let media_kind = session.media_kind();
        if matches!(media_kind, ChdMediaKind::CdRom | ChdMediaKind::GdRom) {
            return Err(RomWeaverError::Validation(
                "rust backend raw extract helper only supports non-disc media".to_string(),
            ));
        }
        session
            .extract_to_file_with_progress(output, thread_count, None)
            .map(|_| ())
    }

    #[cfg(any(test, feature = "test-utils"))]
    pub fn encode_raw_flac_payload_for_tests(&self, hunk: &[u8]) -> Result<Vec<u8>> {
        self.compress_rust_hunk(&ChdCreateKind::Raw, ChdCodec::FLAC, 0, hunk)
    }

    #[cfg(any(test, feature = "test-utils"))]
    pub fn encode_cd_flac_payload_for_tests(&self, hunk: &[u8]) -> Result<Vec<u8>> {
        self.compress_rust_cd_hunk(ChdCodec::CD_FLAC, 0, hunk)
    }

    pub(super) fn explicit_codec_plan(&self, codecs: Vec<ChdCodec>) -> Result<ChdCompressionPlan> {
        if codecs.is_empty() {
            return Err(RomWeaverError::Validation(
                "chd codec list cannot be empty".to_string(),
            ));
        }
        if codecs.len() > CHD_MAX_COMPRESSORS {
            return Err(RomWeaverError::Validation(format!(
                "chd supports at most {CHD_MAX_COMPRESSORS} codecs; received {}",
                codecs.len()
            )));
        }
        if codecs[0] == ChdCodec::NONE && codecs.len() > 1 {
            return Err(RomWeaverError::Validation(
                "chd codec `store` cannot be combined with additional codecs".to_string(),
            ));
        }
        if codecs
            .iter()
            .enumerate()
            .skip(1)
            .any(|(_, codec)| *codec == ChdCodec::AVHUFF)
        {
            return Err(RomWeaverError::Validation(
                "chd codec `avhuff` must be the first codec when multiple codecs are provided"
                    .to_string(),
            ));
        }
        let primary_codec = codecs[0];
        let mut resolved_codecs = [ChdCodec::NONE; CHD_MAX_COMPRESSORS];
        for (index, codec) in codecs.into_iter().enumerate() {
            resolved_codecs[index] = codec;
        }
        Ok(ChdCompressionPlan {
            codecs: resolved_codecs,
            primary_codec,
        })
    }

    pub(super) fn default_compression_plan(
        &self,
        create_kind: &ChdCreateKind,
    ) -> ChdCompressionPlan {
        match create_kind {
            ChdCreateKind::Disc(layout) => match layout.kind {
                DiscKind::CdRom | DiscKind::GdRom => ChdCompressionPlan {
                    codecs: [
                        ChdCodec::CD_LZMA,
                        ChdCodec::CD_ZLIB,
                        ChdCodec::CD_FLAC,
                        ChdCodec::NONE,
                    ],
                    primary_codec: ChdCodec::CD_LZMA,
                },
            },
            ChdCreateKind::Dvd => ChdCompressionPlan {
                codecs: [
                    ChdCodec::LZMA,
                    ChdCodec::ZLIB,
                    ChdCodec::HUFFMAN,
                    ChdCodec::FLAC,
                ],
                primary_codec: ChdCodec::LZMA,
            },
            _ => ChdCompressionPlan {
                codecs: [
                    ChdCodec::LZMA,
                    ChdCodec::ZLIB,
                    ChdCodec::HUFFMAN,
                    ChdCodec::FLAC,
                ],
                primary_codec: ChdCodec::LZMA,
            },
        }
    }

    pub(super) fn parse_explicit_codecs(
        &self,
        codec: Option<&str>,
    ) -> Result<Option<Vec<ChdCodec>>> {
        let Some(codec) = codec else {
            return Ok(None);
        };
        let codec = codec.trim();
        if codec.is_empty() {
            return Ok(None);
        }

        let mut codecs = Vec::new();
        for entry in codec.split([',', '+']) {
            let entry = entry.trim();
            if entry.is_empty() {
                return Err(RomWeaverError::Validation(
                    "chd codec list contains an empty entry".to_string(),
                ));
            }
            codecs.push(self.map_codec(entry)?);
        }
        Ok(Some(codecs))
    }

    pub(super) fn map_codec(&self, codec: &str) -> Result<ChdCodec> {
        let normalized = codec.trim().to_ascii_lowercase();
        match normalized.as_str() {
            "huff" | "huffman" => return Ok(ChdCodec::HUFFMAN),
            "flac" => return Ok(ChdCodec::FLAC),
            "cdzl" => return Ok(ChdCodec::CD_ZLIB),
            "cdzs" => return Ok(ChdCodec::CD_ZSTD),
            "cdlz" => return Ok(ChdCodec::CD_LZMA),
            "cdfl" => return Ok(ChdCodec::CD_FLAC),
            "avhu" | "avhuff" => return Ok(ChdCodec::AVHUFF),
            _ => {}
        }

        match parse_requested_codec(Some(codec)) {
            RequestedCodec::Unspecified => Ok(ChdCodec::ZSTD),
            RequestedCodec::Known(CanonicalCodec::Store) => Ok(ChdCodec::NONE),
            RequestedCodec::Known(CanonicalCodec::Deflate) => Ok(ChdCodec::ZLIB),
            RequestedCodec::Known(CanonicalCodec::Zstd) => Ok(ChdCodec::ZSTD),
            RequestedCodec::Known(CanonicalCodec::Lzma)
            | RequestedCodec::Known(CanonicalCodec::Lzma2) => Ok(ChdCodec::LZMA),
            RequestedCodec::Known(CanonicalCodec::Huffman) => Ok(ChdCodec::HUFFMAN),
            RequestedCodec::Known(codec) => Err(Self::unsupported_codec_error(codec.name())),
            RequestedCodec::Unknown(name) => Err(Self::unsupported_codec_error(&name)),
        }
    }

    pub(super) fn unsupported_codec_error(codec_name: &str) -> RomWeaverError {
        RomWeaverError::Validation(format!(
            "unsupported chd codec `{codec_name}`; {}",
            Self::SUPPORTED_CODEC_CLAUSE
        ))
    }

    pub(super) fn resolve_compression_level(
        &self,
        codec: ChdCodec,
        level: Option<i32>,
    ) -> Result<i32> {
        let Some(level) = level else {
            return Ok(0);
        };

        let codec_label = self.codec_label(codec);
        let zstd_max_level = zstd::zstd_safe::max_c_level() as i32;
        let range = match codec {
            ChdCodec::ZLIB | ChdCodec::CD_ZLIB => {
                Some((Self::ZLIB_LEVEL_MIN, Self::ZLIB_LEVEL_MAX))
            }
            ChdCodec::ZSTD | ChdCodec::CD_ZSTD => Some((Self::ZSTD_LEVEL_MIN, zstd_max_level)),
            ChdCodec::LZMA | ChdCodec::CD_LZMA => {
                Some((Self::LZMA_LEVEL_MIN, Self::LZMA_LEVEL_MAX))
            }
            ChdCodec::FLAC | ChdCodec::CD_FLAC => {
                Some((Self::FLAC_LEVEL_MIN, Self::FLAC_LEVEL_MAX))
            }
            ChdCodec::NONE | ChdCodec::HUFFMAN | ChdCodec::AVHUFF => None,
            _ => None,
        };

        let Some((min, max)) = range else {
            return Err(RomWeaverError::Validation(format!(
                "chd codec `{codec_label}` does not accept --level"
            )));
        };
        if (min..=max).contains(&level) {
            Ok(level)
        } else {
            Err(RomWeaverError::Validation(format!(
                "chd codec `{codec_label}` level `{level}` is out of range; expected {min}..={max}"
            )))
        }
    }

    pub(super) fn codec_label(&self, codec: ChdCodec) -> &'static str {
        match codec {
            ChdCodec::NONE => "store",
            ChdCodec::ZLIB => "zlib",
            ChdCodec::ZSTD => "zstd",
            ChdCodec::LZMA => "lzma",
            ChdCodec::HUFFMAN => "huff",
            ChdCodec::AVHUFF => "avhuff",
            ChdCodec::FLAC => "flac",
            ChdCodec::CD_ZLIB => "cdzl",
            ChdCodec::CD_ZSTD => "cdzs",
            ChdCodec::CD_LZMA => "cdlz",
            ChdCodec::CD_FLAC => "cdfl",
            _ => "unknown",
        }
    }

    pub(super) fn header_codec_label(&self, header: ChdHeader) -> String {
        let codecs = header
            .compression
            .into_iter()
            .filter(|codec| *codec != ChdCodec::NONE)
            .map(|codec| self.codec_label(codec).to_string())
            .collect::<Vec<_>>();
        if codecs.is_empty() {
            "store".to_string()
        } else {
            codecs.join("+")
        }
    }

    pub(super) fn header_sha1_hex(&self, header: ChdHeader) -> Option<String> {
        self.sha1_hex_from_optional(header.sha1)
    }

    pub(super) fn header_raw_sha1_hex(&self, header: ChdHeader) -> Option<String> {
        self.sha1_hex_from_optional(header.raw_sha1)
    }

    pub(super) fn sha1_hex_from_optional(&self, sha1: Option<[u8; 20]>) -> Option<String> {
        let sha1 = sha1?;
        if sha1.iter().all(|byte| *byte == 0) {
            return None;
        }
        Some(self.sha1_hex(sha1))
    }

    pub(super) fn sha1_hex(&self, sha1: [u8; 20]) -> String {
        sha1.iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    }

    pub(super) fn extract_extension(&self, media_kind: ChdMediaKind) -> Result<&'static str> {
        match media_kind {
            ChdMediaKind::Raw => Ok(".bin"),
            ChdMediaKind::HardDisk => Ok(".img"),
            ChdMediaKind::Dvd => Ok(".iso"),
            ChdMediaKind::CdRom => Ok(".cue"),
            ChdMediaKind::GdRom => Ok(".gdi"),
            ChdMediaKind::Av => Ok(".avi"),
        }
    }

    pub(super) fn extract_name(&self, source: &Path, media_kind: ChdMediaKind) -> Result<String> {
        let stem = source
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("output");
        Ok(format!("{stem}{}", self.extract_extension(media_kind)?))
    }

    pub(super) fn parse_disc_mode(&self, value: &str) -> Result<DiscTrackMode> {
        match value.trim().to_ascii_uppercase().as_str() {
            "MODE1" | "MODE1/2048" => Ok(DiscTrackMode::Mode1),
            "MODE1/2352" | "MODE1_RAW" => Ok(DiscTrackMode::Mode1Raw),
            "MODE2" | "MODE2/2336" => Ok(DiscTrackMode::Mode2),
            "MODE2_FORM1" | "MODE2/2048" => Ok(DiscTrackMode::Mode2Form1),
            "MODE2_FORM2" | "MODE2/2324" => Ok(DiscTrackMode::Mode2Form2),
            "MODE2_FORM_MIX" => Ok(DiscTrackMode::Mode2FormMix),
            "MODE2/2352" | "MODE2_RAW" | "CDI/2352" => Ok(DiscTrackMode::Mode2Raw),
            "AUDIO" => Ok(DiscTrackMode::Audio),
            other => Err(RomWeaverError::Validation(format!(
                "unsupported disc track type `{other}`; supported types are MODE1/2048, MODE1/2352, MODE2/2336, MODE2/2048, MODE2/2324, MODE2_FORM_MIX, MODE2/2352, and AUDIO"
            ))),
        }
    }

    pub(super) fn parse_msf(&self, value: &str) -> Result<u32> {
        let mut parts = value.split(':');
        let minutes = parts
            .next()
            .ok_or_else(|| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?
            .parse::<u32>()
            .map_err(|_| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?;
        let seconds = parts
            .next()
            .ok_or_else(|| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?
            .parse::<u32>()
            .map_err(|_| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?;
        let frames = parts
            .next()
            .ok_or_else(|| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?
            .parse::<u32>()
            .map_err(|_| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?;
        if parts.next().is_some() || seconds >= 60 || frames >= 75 {
            return Err(RomWeaverError::Validation(format!(
                "invalid cue time `{value}`"
            )));
        }
        Ok(minutes * 60 * 75 + seconds * 75 + frames)
    }

    pub(super) fn format_msf(&self, frames: u32) -> String {
        let minutes = frames / (60 * 75);
        let seconds = (frames / 75) % 60;
        let frame = frames % 75;
        format!("{minutes:02}:{seconds:02}:{frame:02}")
    }

    pub(super) fn parse_wave_file(&self, path: &Path) -> Result<(u64, u64)> {
        let mut reader = BufReader::new(File::open(path)?);
        let mut header = [0_u8; 12];
        reader.read_exact(&mut header)?;
        if &header[..4] != b"RIFF" || &header[8..] != b"WAVE" {
            return Err(RomWeaverError::Validation(format!(
                "wave track `{}` is not a RIFF/WAVE file",
                path.display()
            )));
        }

        let mut audio_format = None;
        let mut channels = None;
        let mut sample_rate = None;
        let mut block_align = None;
        let mut bits_per_sample = None;
        let mut data = None;

        loop {
            let mut chunk_header = [0_u8; 8];
            match reader.read_exact(&mut chunk_header) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(error) => return Err(error.into()),
            }

            let chunk_size = u64::from(u32::from_le_bytes([
                chunk_header[4],
                chunk_header[5],
                chunk_header[6],
                chunk_header[7],
            ]));
            let chunk_data_offset = reader.stream_position()?;
            let padded_size = chunk_size + (chunk_size % 2);

            match &chunk_header[..4] {
                b"fmt " => {
                    let chunk_len = usize::try_from(chunk_size).map_err(|_| {
                        RomWeaverError::Validation(format!(
                            "wave track `{}` has an oversized fmt chunk",
                            path.display()
                        ))
                    })?;
                    let mut chunk = vec![0_u8; chunk_len];
                    reader.read_exact(&mut chunk)?;
                    if chunk.len() < 16 {
                        return Err(RomWeaverError::Validation(format!(
                            "wave track `{}` has a truncated fmt chunk",
                            path.display()
                        )));
                    }
                    audio_format = Some(u16::from_le_bytes([chunk[0], chunk[1]]));
                    channels = Some(u16::from_le_bytes([chunk[2], chunk[3]]));
                    sample_rate =
                        Some(u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]));
                    block_align = Some(u16::from_le_bytes([chunk[12], chunk[13]]));
                    bits_per_sample = Some(u16::from_le_bytes([chunk[14], chunk[15]]));
                    if padded_size != chunk_size {
                        reader.seek(SeekFrom::Current(1))?;
                    }
                }
                b"data" => {
                    data = Some((chunk_data_offset, chunk_size));
                    let skip = i64::try_from(padded_size).map_err(|_| {
                        RomWeaverError::Validation(format!(
                            "wave track `{}` is too large for current parsing support",
                            path.display()
                        ))
                    })?;
                    reader.seek(SeekFrom::Current(skip))?;
                }
                _ => {
                    let skip = i64::try_from(padded_size).map_err(|_| {
                        RomWeaverError::Validation(format!(
                            "wave track `{}` is too large for current parsing support",
                            path.display()
                        ))
                    })?;
                    reader.seek(SeekFrom::Current(skip))?;
                }
            }
        }

        let audio_format = audio_format.ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "wave track `{}` is missing a fmt chunk",
                path.display()
            ))
        })?;
        if audio_format != 1 {
            return Err(RomWeaverError::Validation(format!(
                "wave track `{}` uses unsupported format code {}; only PCM WAVE tracks are supported",
                path.display(),
                audio_format
            )));
        }
        if channels != Some(2)
            || sample_rate != Some(44_100)
            || block_align != Some(4)
            || bits_per_sample != Some(16)
        {
            return Err(RomWeaverError::Validation(format!(
                "wave track `{}` must be 44.1 kHz 16-bit stereo PCM for chd audio tracks",
                path.display()
            )));
        }

        let (data_offset, data_len) = data.ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "wave track `{}` is missing a data chunk",
                path.display()
            ))
        })?;
        if data_len % 2352 != 0 {
            return Err(RomWeaverError::Validation(format!(
                "wave track `{}` data length is not divisible by 2352 bytes",
                path.display()
            )));
        }
        Ok((data_offset, data_len))
    }
}
