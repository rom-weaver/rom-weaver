use super::*;
use std::sync::Mutex;

use crate::chd_rs::Chd;
use crate::chd_rs::header::CodecType;
use crate::chd_rs::write::{ChdWriteOptions, ChdWriter, HunkCompressor};
use num_traits::FromPrimitive as _;

#[derive(Clone, Copy)]
pub(super) struct CompressedCreateParams<'a> {
    pub(super) output: &'a Path,
    pub(super) logical_bytes: u64,
    pub(super) create_kind: &'a ChdCreateKind,
    pub(super) codecs: [ChdCodec; CHD_MAX_COMPRESSORS],
    /// The level for every codec that has levels, clamped to each codec's range; `None`
    /// compresses at the levels chdman uses.
    pub(super) compression_level: Option<i32>,
    pub(super) thread_count: usize,
    pub(super) parent_source: Option<&'a Path>,
    pub(super) on_progress: Option<&'a Arc<dyn Fn(u64) + Send + Sync>>,
}

/// The CHD file being written: buffered, because small hunks (e.g. the 4 KiB DVD hunk)
/// make for hundreds of thousands of payload writes on a large image.
type ChdOutput = BufWriter<File>;

impl ChdContainerHandler {
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
        let hunk_count = Self::create_hunk_count(hunk_bytes, unit_bytes, logical_bytes)?;
        debug!(
            hunk_count,
            hunk_bytes, unit_bytes, "chd uncompressed create start"
        );

        // Unlike chdman, uncompressed CHDs carry the data and overall SHA-1s.
        let options = ChdWriteOptions::new(hunk_bytes, unit_bytes)
            .logical_bytes(logical_bytes)
            .hash_uncompressed(true);
        let mut writer = ChdWriter::new(Self::create_output_file(output)?, options)
            .map_err(|error| Self::chd_write_error(output, error))?;
        self.add_create_metadata(&mut writer, output, create_kind)?;

        let hunk_bytes_usize = usize::try_from(hunk_bytes).map_err(|_| {
            RomWeaverError::Validation("CHD hunk size exceeded addressable memory".to_string())
        })?;
        let mut remaining = logical_bytes;
        for _ in 0..hunk_count {
            let hunk = read_source_hunk(
                source,
                source_label,
                &mut remaining,
                hunk_bytes,
                hunk_bytes_usize,
                on_progress,
            )?;
            writer
                .write_hunk(&hunk)
                .map_err(|error| Self::chd_write_error(output, error))?;
        }
        Self::finish_chd_output(writer, output)?;
        debug!(hunk_count, "chd uncompressed create done");

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

    /// Opens the parent of a differential create, which must have a SHA-1 and the same
    /// unit and hunk sizes as the child.
    pub(super) fn open_create_parent(
        &self,
        parent_source: &Path,
        expected_unit_bytes: u32,
        expected_hunk_bytes: u32,
    ) -> Result<Chd<BufReader<File>>> {
        let parent = ChdReadSession::open_rust_chd(parent_source, None).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to open parent chd `{}` for differential create: {error}",
                parent_source.display()
            ))
        })?;
        let parent_header = parent.header();
        if parent_header.sha1().is_none() {
            return Err(RomWeaverError::Validation(format!(
                "parent chd `{}` does not expose a sha1 in its header",
                parent_source.display()
            )));
        }
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
        Ok(parent)
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
        let mut codec_types = arrayvec::ArrayVec::<CodecType, CHD_MAX_COMPRESSORS>::new();
        let mut codec_levels = [None; CHD_MAX_COMPRESSORS];
        for codec in codecs
            .into_iter()
            .take_while(|codec| *codec != ChdCodec::NONE)
        {
            let codec_type = CodecType::from_u32(codec.raw())
                .filter(|_| {
                    self.supports_create_codec(create_kind, codec)
                        && self.supports_rust_encode_codec(create_kind, codec)
                })
                .ok_or_else(|| {
                    RomWeaverError::Unsupported(UnsupportedOp::ChdCodecInvalidForMedia {
                        codec: self.codec_label(codec).to_string(),
                        media: self
                            .media_label(self.media_kind_from_create_kind(create_kind))
                            .to_string(),
                    })
                })?;
            codec_levels[codec_types.len()] =
                compression_level.and_then(|level| Self::chd_rs_codec_level(codec, level));
            codec_types.push(codec_type);
        }
        let Some(&primary_codec) = codecs.first().filter(|_| !codec_types.is_empty()) else {
            return Err(RomWeaverError::Validation(
                "compressed rust CHD create requires at least one codec".to_string(),
            ));
        };

        let hunk_bytes = self.hunk_bytes(create_kind, logical_bytes, primary_codec);
        let unit_bytes = self.unit_bytes(create_kind);
        let hunk_count = Self::create_hunk_count(hunk_bytes, unit_bytes, logical_bytes)?;
        let hunk_count_usize = usize::try_from(hunk_count).map_err(|_| {
            RomWeaverError::Validation("CHD hunk count exceeded addressable memory".to_string())
        })?;
        let hunk_bytes_usize = usize::try_from(hunk_bytes).map_err(|_| {
            RomWeaverError::Validation("CHD hunk size exceeded addressable memory".to_string())
        })?;

        let options = ChdWriteOptions::new(hunk_bytes, unit_bytes)
            .logical_bytes(logical_bytes)
            .compression(&codec_types)
            .compression_levels(codec_levels);
        let mut parent = parent_source
            .map(|parent_source| self.open_create_parent(parent_source, unit_bytes, hunk_bytes))
            .transpose()?;
        let output_file = Self::create_output_file(output)?;
        let mut writer = match parent.as_mut() {
            Some(parent) => ChdWriter::with_parent(output_file, options, parent),
            None => ChdWriter::new(output_file, options),
        }
        .map_err(|error| Self::chd_write_error(output, error))?;
        drop(parent);
        self.add_create_metadata(&mut writer, output, create_kind)?;

        let effective_threads = thread_count.max(1).min(hunk_count_usize.max(1));
        debug!(
            primary_codec = ?primary_codec,
            codecs = codec_types.len(),
            ?codec_levels,
            hunk_count,
            hunk_bytes,
            unit_bytes,
            requested_threads = thread_count,
            effective_threads,
            has_parent = parent_source.is_some(),
            "chd compressed create start"
        );

        let mut remaining = logical_bytes;
        if effective_threads <= 1 {
            // Sequential path: no worker threads are spawned, so this also serves targets
            // without thread support.
            trace!(hunk_count, "chd compressed create sequential path");
            for _ in 0..hunk_count {
                let hunk = read_source_hunk(
                    source,
                    source_label,
                    &mut remaining,
                    hunk_bytes,
                    hunk_bytes_usize,
                    on_progress,
                )?;
                writer
                    .write_hunk(&hunk)
                    .map_err(|error| Self::chd_write_error(output, error))?;
            }
        } else {
            // The coordinator reads hunks and writes results in order while workers
            // compress; the pipeline bounds buffered work and drains producers on error
            // before joining their threads. The compressors are made up front because the
            // writer is borrowed mutably to write the results.
            trace!(
                hunk_count,
                effective_threads, "chd compressed create streaming pipeline path"
            );
            let compressors = (0..effective_threads)
                .map(|_| writer.compressor())
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|error| Self::chd_write_error(output, error))?;
            let compressors = Mutex::new(compressors);
            ordered_streaming_compress(
                0..hunk_count_usize,
                effective_threads,
                OrderedStreamingMessages {
                    worker_closed: "chd compression workers ended before all hunks were consumed",
                    result_closed: "chd compression pipeline ended before all hunks were produced",
                },
                |_, _| {
                    read_source_hunk(
                        source,
                        source_label,
                        &mut remaining,
                        hunk_bytes,
                        hunk_bytes_usize,
                        on_progress,
                    )
                },
                || -> Option<HunkCompressor> {
                    compressors
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .pop()
                },
                |compressor, _, hunk| {
                    compressor
                        .as_mut()
                        .ok_or_else(|| {
                            RomWeaverError::Validation(
                                "chd compression pipeline started more workers than compressors"
                                    .to_string(),
                            )
                        })?
                        .compress_owned(hunk)
                        .map_err(|error| Self::chd_write_error(output, error))
                },
                |_, compressed| {
                    writer
                        .write_compressed_hunk(compressed)
                        .map_err(|error| Self::chd_write_error(output, error))
                },
            )?;
        }
        Self::finish_chd_output(writer, output)?;
        debug!(hunk_count, "chd compressed create done");

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

    /// The level of `codec` for a requested level, clamped to the codec's range, or `None`
    /// for codecs without levels.
    fn chd_rs_codec_level(codec: ChdCodec, level: i32) -> Option<i32> {
        let (min, max) = match codec {
            ChdCodec::ZLIB | ChdCodec::CD_ZLIB => (Self::ZLIB_LEVEL_MIN, Self::ZLIB_LEVEL_MAX),
            ChdCodec::LZMA | ChdCodec::CD_LZMA => (Self::LZMA_LEVEL_MIN, Self::LZMA_LEVEL_MAX),
            // `--level 9` stays accepted for FLAC and compresses like libFLAC's top level, 8.
            ChdCodec::FLAC | ChdCodec::CD_FLAC => (Self::FLAC_LEVEL_MIN, 8),
            ChdCodec::ZSTD | ChdCodec::CD_ZSTD => (
                zstd::zstd_safe::min_c_level(),
                zstd::zstd_safe::max_c_level(),
            ),
            _ => return None,
        };
        Some(level.clamp(min, max))
    }

    fn create_hunk_count(hunk_bytes: u32, unit_bytes: u32, logical_bytes: u64) -> Result<u32> {
        if hunk_bytes == 0 || unit_bytes == 0 || !hunk_bytes.is_multiple_of(unit_bytes) {
            return Err(RomWeaverError::Validation(
                "invalid CHD geometry for rust create".into(),
            ));
        }
        u32::try_from(logical_bytes.div_ceil(u64::from(hunk_bytes))).map_err(|_| {
            RomWeaverError::Validation(
                "input is too large for CHD v5 hunk table limits".to_string(),
            )
        })
    }

    fn create_output_file(output: &Path) -> Result<ChdOutput> {
        let file = File::options()
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
        Ok(BufWriter::with_capacity(8 * 1024 * 1024, file))
    }

    /// Adds the media metadata, which goes before the hunks like chdman.
    fn add_create_metadata(
        &self,
        writer: &mut ChdWriter<ChdOutput>,
        output: &Path,
        create_kind: &ChdCreateKind,
    ) -> Result<()> {
        for entry in self.rust_metadata_entries(create_kind)? {
            trace!(
                tag = entry.tag,
                bytes = entry.data.len(),
                "chd create metadata"
            );
            writer
                .add_metadata(
                    entry.tag,
                    entry.data.as_slice(),
                    entry.flags & CHD_METADATA_FLAG_CHECKSUM != 0,
                )
                .map_err(|error| Self::chd_write_error(output, error))?;
        }
        Ok(())
    }

    fn finish_chd_output(writer: ChdWriter<ChdOutput>, output: &Path) -> Result<()> {
        let mut output_file = writer
            .finish()
            .map_err(|error| Self::chd_write_error(output, error))?;
        output_file.flush().map_err(|error| {
            RomWeaverError::Validation(format!("failed to flush `{}`: {error}", output.display()))
        })
    }

    fn chd_write_error(output: &Path, error: crate::chd_rs::Error) -> RomWeaverError {
        RomWeaverError::Validation(format!(
            "failed to write CHD `{}`: {error}",
            output.display()
        ))
    }
}

#[cfg(test)]
#[path = "../../tests/unit/create_pipeline.rs"]
mod create_pipeline_tests;

/// Reads the next hunk of the create source into a zero-padded hunk buffer, feeding the
/// progress callback with only the bytes read.
fn read_source_hunk(
    source: &mut dyn Read,
    source_label: &str,
    remaining: &mut u64,
    hunk_bytes: u32,
    hunk_bytes_usize: usize,
    on_progress: Option<&Arc<dyn Fn(u64) + Send + Sync>>,
) -> Result<Vec<u8>> {
    let read_len = usize::try_from((*remaining).min(u64::from(hunk_bytes))).map_err(|_| {
        RomWeaverError::Validation("decoded CHD chunk exceeded addressable memory".to_string())
    })?;
    let mut hunk = vec![0_u8; hunk_bytes_usize];
    source.read_exact(&mut hunk[..read_len]).map_err(|error| {
        RomWeaverError::Validation(format!("failed to read source `{source_label}`: {error}",))
    })?;
    *remaining = remaining.saturating_sub(read_len as u64);
    if let Some(on_progress) = on_progress {
        on_progress(read_len as u64);
    }
    Ok(hunk)
}
