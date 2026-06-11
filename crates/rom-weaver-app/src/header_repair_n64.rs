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
        if magic == N64_BIG_ENDIAN_MAGIC {
            Ok(Some(N64ByteOrder::BigEndian))
        } else if magic == N64_LITTLE_ENDIAN_MAGIC {
            Ok(Some(N64ByteOrder::LittleEndian))
        } else if magic == N64_BYTE_SWAPPED_MAGIC {
            Ok(Some(N64ByteOrder::ByteSwapped))
        } else {
            Ok(None)
        }
    }

    pub(super) fn transform_n64_word(bytes: &mut [u8; 4], order: N64ByteOrder) {
        match order {
            N64ByteOrder::BigEndian => {}
            N64ByteOrder::LittleEndian => bytes.reverse(),
            N64ByteOrder::ByteSwapped => {
                bytes.swap(0, 1);
                bytes.swap(2, 3);
            }
        }
    }

    pub(super) fn read_n64_word_normalized(
        file: &mut File,
        offset: u64,
        order: N64ByteOrder,
    ) -> Result<u32> {
        let mut bytes = [0u8; 4];
        read_exact_at(file, offset, &mut bytes)?;
        Self::transform_n64_word(&mut bytes, order);
        Ok(u32::from_be_bytes(bytes))
    }

    pub(super) fn write_n64_word_original_order(
        file: &mut File,
        offset: u64,
        value: u32,
        order: N64ByteOrder,
    ) -> Result<()> {
        let mut bytes = value.to_be_bytes();
        Self::transform_n64_word(&mut bytes, order);
        write_all_at(file, offset, &bytes)
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
                    Self::transform_n64_word(&mut word, from);
                    Self::transform_n64_word(&mut word, to);
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

    pub(super) fn rewrite_n64_byte_order_to_temp(
        input: &Path,
        output: &Path,
        target: N64ByteOrder,
    ) -> Result<Option<N64ByteOrderTransform>> {
        let Some(source) = Self::detect_n64_byte_order_path(input)? else {
            return Err(RomWeaverError::Validation(format!(
                "could not detect N64 byte order for `{}`",
                input.display()
            )));
        };
        if source == target {
            return Ok(None);
        }
        Self::rewrite_n64_byte_order(input, output, source, target)?;
        Ok(Some(N64ByteOrderTransform {
            from: target,
            to: source,
        }))
    }
}
