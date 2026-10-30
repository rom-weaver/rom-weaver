use super::nod_shared::nod_extract_only_handler;
use super::*;

nod_extract_only_handler!(WIA_NOD_CORE, WiaContainerHandler, &WIA, NodFormat::Wia);

pub(crate) fn validate_integrity(disc: &NodDiscReader, context: &OperationContext) -> Result<()> {
    use crate::nod::{
        disc::{SECTOR_SIZE, wii::SECTOR_DATA_SIZE},
        read::PartitionOptions,
    };
    use digest::Digest;
    use tracing::debug;

    for partition in disc
        .partitions()
        .iter()
        .filter(|partition| partition.has_hashes)
    {
        context.cancel().check()?;
        debug!(
            partition = partition.index,
            "verifying WIA Wii partition hashes"
        );
        let label = format!("verifying WIA partition {} hashes", partition.index);
        emit_container_indeterminate_progress(
            context,
            "extract",
            "wia",
            "verify-partition",
            &label,
            None,
        );
        let mut reader = disc
            .open_partition(
                partition.index,
                &PartitionOptions {
                    validate_hashes: true,
                },
            )
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "WIA partition {} integrity check failed: {error}",
                    partition.index
                ))
            })?;
        let mut completed = 0u64;
        let progress_bucket = AtomicU8::new(0);
        let data_size = partition.data_size() / SECTOR_SIZE as u64 * SECTOR_DATA_SIZE as u64;
        loop {
            context.cancel().check()?;
            let len = reader
                .fill_buf()
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "WIA partition {} integrity check failed: {error}",
                        partition.index
                    ))
                })?
                .len();
            if len == 0 {
                break;
            }
            reader.consume(len);
            completed += len as u64;
            maybe_emit_container_byte_progress(
                context,
                completed,
                data_size,
                ContainerByteProgress {
                    command: "extract",
                    format: "wia",
                    stage: "verify-partition",
                    label: &label,
                    thread_execution: None,
                    emitted_progress_bucket: &progress_bucket,
                },
            );
        }
    }

    let meta = disc.meta();
    let mut crc32 = meta.crc32.map(|_| crc32fast::Hasher::new());
    let mut md5 = meta.md5.map(|_| md5::Md5::new());
    let mut sha1 = meta.sha1.map(|_| sha1::Sha1::new());
    let mut xxh64 = meta.xxh64.map(|_| xxhash_rust::xxh64::Xxh64::new(0));
    if crc32.is_none() && md5.is_none() && sha1.is_none() && xxh64.is_none() {
        return Ok(());
    }

    debug!("verifying WIA NKit image checksums");
    emit_container_indeterminate_progress(
        context,
        "extract",
        "wia",
        "verify-image",
        "verifying WIA NKit image checksums",
        None,
    );
    let mut reader = disc.clone();
    let mut buffer = vec![0; copy_progress_buffer_size(reader.disc_size())];
    let mut completed = 0u64;
    let progress_bucket = AtomicU8::new(0);
    loop {
        context.cancel().check()?;
        let len = reader.read(&mut buffer)?;
        if len == 0 {
            break;
        }
        let data = &buffer[..len];
        if let Some(hash) = &mut crc32 {
            hash.update(data);
        }
        if let Some(hash) = &mut md5 {
            hash.update(data);
        }
        if let Some(hash) = &mut sha1 {
            hash.update(data);
        }
        if let Some(hash) = &mut xxh64 {
            hash.update(data);
        }
        completed += len as u64;
        maybe_emit_container_byte_progress(
            context,
            completed,
            reader.disc_size(),
            ContainerByteProgress {
                command: "extract",
                format: "wia",
                stage: "verify-image",
                label: "verifying WIA NKit image checksums",
                thread_execution: None,
                emitted_progress_bucket: &progress_bucket,
            },
        );
    }
    let mismatch = if crc32.map(|hash| hash.finalize()) != meta.crc32 {
        Some("CRC32")
    } else if md5.map(|hash| <[u8; 16]>::from(hash.finalize())) != meta.md5 {
        Some("MD5")
    } else if sha1.map(|hash| <[u8; 20]>::from(hash.finalize())) != meta.sha1 {
        Some("SHA-1")
    } else if xxh64.map(|hash| hash.digest()) != meta.xxh64 {
        Some("XXH64")
    } else {
        None
    };
    if let Some(algorithm) = mismatch {
        return Err(RomWeaverError::Validation(format!(
            "WIA NKit {algorithm} checksum mismatch"
        )));
    }
    Ok(())
}
