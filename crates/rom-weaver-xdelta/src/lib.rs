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

include!("vcdiff/core.rs");
include!("vcdiff/xdelta_secondary.rs");
include!("vcdiff/decode_secondary.rs");
include!("vcdiff/decode_helpers.rs");
#[cfg(test)]
include!("../tests/unit/vcdiff.rs");
