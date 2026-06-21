use std::{
    borrow::Cow,
    cell::{Cell, RefCell},
    fs::{self, File, OpenOptions},
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

use oxidelta::{
    compress::{
        encoder::CompressOptions,
        pipeline,
        secondary::{self, SecondaryCompression},
    },
    hash::{config, matching::MatchEngine},
    vcdiff::{
        code_table::Instruction,
        decoder::{self as oxidelta_decoder, DecodeError as OxideltaDecodeError},
        encoder::{SourceWindow, StreamEncoder, WindowEncoder, WindowSections},
        header::{VCD_ADLER32, VCD_SOURCE, VCD_TARGET, WindowHeader as OxideltaWindowHeader},
    },
};
use rayon::prelude::*;
use rom_weaver_checksum::adler32_checksum as adler32;
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, OperationStatus,
    PatchApplyRequest, PatchCapabilities, PatchCreateRequest, PatchHandler, ProbeConfidence,
    ProgressEvent, Result, RomWeaverError, SharedThreadPool, ThreadBudget, ThreadCapability,
    ThreadExecution, XdeltaSecondaryMode,
};
use serde_json::json;
use tracing::{debug, trace};

#[cfg(test)]
const VCDIFF: rom_weaver_core::FormatDescriptor = rom_weaver_core::FormatDescriptor {
    family: rom_weaver_core::OperationFamily::Patch,
    name: "VCDIFF",
    aliases: &["vcdiff"],
    extensions: &[".vcdiff"],
};

#[cfg(test)]
const XDELTA: rom_weaver_core::FormatDescriptor = rom_weaver_core::FormatDescriptor {
    family: rom_weaver_core::OperationFamily::Patch,
    name: "xdelta",
    aliases: &["xdelta3"],
    extensions: &[".xdelta"],
};

#[path = "vcdiff/varint.rs"]
mod varint;
use self::varint::*;

#[path = "vcdiff/core.rs"]
mod core;
use self::core::*;
pub use self::core::{VcdiffPatchHandler, apply_patch_bytes, vcdiff_output_size};

#[path = "vcdiff/xdelta_secondary.rs"]
mod xdelta_secondary;
use self::xdelta_secondary::*;

#[path = "vcdiff/decode_secondary.rs"]
mod decode_secondary;
use self::decode_secondary::*;

#[path = "vcdiff/decode_helpers.rs"]
mod decode_helpers;
use self::decode_helpers::*;

#[cfg(test)]
#[path = "../tests/unit/vcdiff.rs"]
mod tests;
