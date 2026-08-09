//! `rom-weaver formats`: print what this build actually supports, straight from
//! the container registry, the patch registry, the compression metadata, and
//! the checksum registry. Native-only, like `completions`; it never enters the
//! shared `Commands` enum.

use rom_weaver_app::compression_metadata;
use rom_weaver_checksum::supported_algorithms;
use rom_weaver_containers::container_format_metadata;
use rom_weaver_patches::PatchRegistry;
use serde_json::{Value, json};

/// Which codec-field a container format's codecs live under. The metadata keys
/// are webapp form-field names, so the mapping back to a format name is here.
const FORMAT_CODEC_FIELDS: &[(&str, &[&str])] = &[
    ("chd", &["chdCreateCdCodecs", "chdCreateDvdCodecs"]),
    ("rvz", &["rvzCodec"]),
    ("7z", &["sevenZipCodec"]),
    ("zip", &["zipCodec"]),
];

fn codecs_for_format(format: &str) -> Vec<&'static str> {
    let metadata = compression_metadata();
    // Z3DS has one fixed codec and so carries no codec field of its own.
    if format.eq_ignore_ascii_case("z3ds") {
        return vec![metadata.defaults.z3ds_codec];
    }
    let mut codecs = Vec::new();
    for (name, fields) in FORMAT_CODEC_FIELDS {
        if !name.eq_ignore_ascii_case(format) {
            continue;
        }
        for field in *fields {
            if let Some(entry) = metadata
                .codec_fields
                .iter()
                .find(|candidate| candidate.name == *field)
            {
                for codec in entry.codecs {
                    if !codecs.contains(codec) {
                        codecs.push(*codec);
                    }
                }
            }
        }
    }
    codecs
}

fn report() -> Value {
    let containers = container_format_metadata()
        .into_iter()
        .map(|format| {
            json!({
                "name": format.name,
                "aliases": format.aliases,
                "extensions": format.extensions,
                "create": format.capabilities.create,
                "extract": format.capabilities.extract,
                "codecs": codecs_for_format(format.name),
            })
        })
        .collect::<Vec<_>>();
    let patches = PatchRegistry::new()
        .handlers()
        .iter()
        .map(|handler| {
            let descriptor = handler.descriptor();
            let capabilities = handler.capabilities();
            json!({
                "name": descriptor.name,
                "aliases": descriptor.aliases,
                "extensions": descriptor.extensions,
                "apply": capabilities.apply,
                "create": capabilities.create,
                "parse": capabilities.parse,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "containers": containers,
        "patches": patches,
        "codecs": compression_metadata()
            .codecs
            .iter()
            .map(|codec| json!({
                "name": codec.name,
                "aliases": codec.aliases,
                "minLevel": codec.level.map(|level| level.min),
                "maxLevel": codec.level.map(|level| level.max),
            }))
            .collect::<Vec<_>>(),
        "checksumAlgorithms": supported_algorithms(),
    })
}

fn join(values: &[&str]) -> String {
    if values.is_empty() {
        return "-".to_string();
    }
    values.join(", ")
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn flags(value: &Value, keys: &[&str]) -> String {
    let set = keys
        .iter()
        .filter(|key| value.get(**key).and_then(Value::as_bool).unwrap_or(false))
        .copied()
        .collect::<Vec<_>>();
    join(&set)
}

/// Print the report. `json` mirrors the global `--json` flag.
pub fn print_formats(json_output: bool) {
    let report = report();
    if json_output {
        println!(
            "{}",
            serde_json::to_string(&report).unwrap_or_else(|_| "{}".to_string())
        );
        return;
    }
    println!("Container formats");
    for format in report
        .get("containers")
        .and_then(Value::as_array)
        .unwrap_or(&Vec::new())
    {
        let name = format.get("name").and_then(Value::as_str).unwrap_or("?");
        let extensions = strings(format, "extensions");
        let codecs = strings(format, "codecs");
        let extensions = extensions.iter().map(String::as_str).collect::<Vec<_>>();
        let codecs = codecs.iter().map(String::as_str).collect::<Vec<_>>();
        println!(
            "  {name:<8} {:<18} extensions: {:<28} codecs: {}",
            flags(format, &["create", "extract"]),
            join(&extensions),
            join(&codecs)
        );
    }
    println!();
    println!("Patch formats");
    for format in report
        .get("patches")
        .and_then(Value::as_array)
        .unwrap_or(&Vec::new())
    {
        let name = format.get("name").and_then(Value::as_str).unwrap_or("?");
        let extensions = strings(format, "extensions");
        let extensions = extensions.iter().map(String::as_str).collect::<Vec<_>>();
        println!(
            "  {name:<8} {:<22} extensions: {}",
            flags(format, &["apply", "create", "parse"]),
            join(&extensions)
        );
    }
    println!();
    println!("Checksum algorithms");
    println!("  {}", supported_algorithms().join(", "));
}
