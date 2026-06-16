use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::Write as _,
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
};

use adler2::Adler32;
use blake3::Hasher as Blake3Hasher;
use crc16::{ARC, State as Crc16State};
use crc32c::{crc32c_append, crc32c_combine};
use crc32fast::Hasher as Crc32Hasher;
use rayon::prelude::*;
use rom_weaver_core::{
    CancellationToken, ChecksumRequest, OperationContext, Result, RomWeaverError, SharedThreadPool,
    ThreadCapability, ThreadExecution,
};
use tracing::trace;

#[path = "core.rs"]
mod core;
use self::core::*;
pub use self::core::{
    ChecksumProgress, ChecksumValues, NativeChecksumEngine, StreamingChecksum,
    StreamingChecksumTiming, checksum_file_values, checksum_reader_values_with_progress,
    crc16_ccitt_bytes, crc32_bytes, md5_bytes, md5_file,
};

#[path = "planning.rs"]
mod planning;
use self::planning::*;

#[path = "execution.rs"]
mod execution;
pub use self::execution::adler32_checksum;
use self::execution::*;

#[path = "reporting.rs"]
mod reporting;
pub use self::reporting::supported_algorithms;
use self::reporting::*;

#[cfg(test)]
#[path = "../tests/unit/engine.rs"]
mod tests;
