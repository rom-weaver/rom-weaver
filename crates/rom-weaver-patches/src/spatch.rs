use std::{
    fs::{self, File},
    io::{BufReader, BufWriter, Write},
    ops::Range,
    path::Path,
};

use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchCreateRequest, PatchHandler, ProbeConfidence, Result, RomWeaverError,
    ThreadCapability,
};

use crate::ips::IpsPatchHandler;

const IPS_MAGIC: &[u8; 5] = b"PATCH";
const IPS_EOF: &[u8; 3] = b"EOF";
const SPATCH_HEADER_SIZE: u64 = 512;

const INTERNAL_IPS: FormatDescriptor = FormatDescriptor {
    family: OperationFamily::Patch,
    name: "IPS",
    aliases: &[],
    extensions: &[".ips"],
};

pub struct SpatchPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl SpatchPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl PatchHandler for SpatchPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let bytes = fs::read(patch_path)?;
        let parsed = parse_spatch_bytes(&bytes)?;
        let mut label = format!(
            "parsed {} patch with {} primary record(s)",
            self.descriptor.name, parsed.primary.record_count
        );
        if let Some(size) = parsed.primary.truncate_size {
            label.push_str(&format!(" and primary output size {size}"));
        }
        if let Some(secondary) = &parsed.secondary {
            label.push_str(&format!(
                " plus {} secondary record(s)",
                secondary.record_count
            ));
            if let Some(size) = secondary.truncate_size {
                label.push_str(&format!(" and secondary output size {size}"));
            }
        }

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "parse",
            label,
            Some(1.0),
            None,
        ))
    }

    fn apply(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        if request.patches.len() != 1 {
            return Err(RomWeaverError::Validation(format!(
                "{} apply expects exactly one patch file",
                self.descriptor.name
            )));
        }

        let patch_bytes = fs::read(&request.patches[0])?;
        let parsed = parse_spatch_bytes(&patch_bytes)?;
        let input_len = fs::metadata(&request.input)?.len();
        let use_secondary = parsed.secondary.as_ref().is_some_and(|secondary| {
            (input_len >= SPATCH_HEADER_SIZE
                && parsed.primary.touches_header
                && !secondary.touches_header)
                || looks_headered_input(input_len)
        });
        let selected = if use_secondary {
            parsed.secondary.as_ref().expect("checked")
        } else {
            &parsed.primary
        };

        let selected_path = context
            .temp_paths()
            .next_path("spatch-selected-stream", Some("ips"));
        write_slice(&patch_bytes, &selected.range, &selected_path)?;

        let ips_handler = IpsPatchHandler::new(&INTERNAL_IPS);
        let apply_result = ips_handler.apply(
            &PatchApplyRequest {
                input: request.input.clone(),
                patches: vec![selected_path.clone()],
                output: request.output.clone(),
            },
            context,
        );
        let _ = fs::remove_file(&selected_path);
        let mut report = apply_result?;
        report.format = Some(self.descriptor.name.to_string());
        report.label = format!(
            "applied {} patch with {} {} record(s)",
            self.descriptor.name,
            selected.record_count,
            if use_secondary {
                "secondary"
            } else {
                "primary"
            }
        );
        Ok(report)
    }

    fn create(
        &self,
        request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let ips_handler = IpsPatchHandler::new(&INTERNAL_IPS);

        let primary_path = context
            .temp_paths()
            .next_path("spatch-primary-stream", Some("ips"));
        let headered_original = context
            .temp_paths()
            .next_path("spatch-original-headered", Some("bin"));
        let headered_modified = context
            .temp_paths()
            .next_path("spatch-modified-headered", Some("bin"));
        let secondary_path = context
            .temp_paths()
            .next_path("spatch-secondary-stream", Some("ips"));

        let create_result: Result<(usize, usize)> = (|| {
            ips_handler.create(
                &PatchCreateRequest {
                    original: request.original.clone(),
                    modified: request.modified.clone(),
                    output: primary_path.clone(),
                    format: "IPS".into(),
                },
                context,
            )?;

            create_headered_copy(&request.original, &headered_original)?;
            create_headered_copy(&request.modified, &headered_modified)?;
            ips_handler.create(
                &PatchCreateRequest {
                    original: headered_original.clone(),
                    modified: headered_modified.clone(),
                    output: secondary_path.clone(),
                    format: "IPS".into(),
                },
                context,
            )?;

            if let Some(parent) = request.output.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut output = BufWriter::new(File::create(&request.output)?);
            let primary_bytes = fs::read(&primary_path)?;
            let secondary_bytes = fs::read(&secondary_path)?;
            output.write_all(&primary_bytes)?;
            output.write_all(&secondary_bytes)?;
            output.flush()?;
            Ok((primary_bytes.len(), secondary_bytes.len()))
        })();

        let _ = fs::remove_file(&primary_path);
        let _ = fs::remove_file(&headered_original);
        let _ = fs::remove_file(&headered_modified);
        let _ = fs::remove_file(&secondary_path);

        let (primary_len, secondary_len) = create_result?;
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created {} patch with primary ({primary_len} byte(s)) and secondary ({secondary_len} byte(s)) streams",
                self.descriptor.name
            ),
            Some(1.0),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> PatchCapabilities {
        PatchCapabilities {
            parse: true,
            apply: true,
            create: true,
            threaded_scan: false,
            threaded_diff: false,
            threaded_output: false,
        }
    }
}

#[derive(Debug)]
struct ParsedSpatchBytes {
    primary: ParsedIpsStream,
    secondary: Option<ParsedIpsStream>,
}

#[derive(Debug)]
struct ParsedIpsStream {
    range: Range<usize>,
    record_count: usize,
    truncate_size: Option<u32>,
    touches_header: bool,
}

#[derive(Debug)]
struct ParsedIpsCore {
    eof_end: usize,
    record_count: usize,
    max_written_end: u64,
    touches_header: bool,
}

fn parse_spatch_bytes(bytes: &[u8]) -> Result<ParsedSpatchBytes> {
    let first = parse_ips_core(bytes)?;
    let mut primary_only = None;

    for has_truncate in [false, true] {
        let boundary = if has_truncate {
            first.eof_end.saturating_add(3)
        } else {
            first.eof_end
        };
        if boundary > bytes.len() {
            continue;
        }

        let truncate_size = if has_truncate {
            let truncate = read_u24(&bytes[first.eof_end..boundary]);
            validate_truncate_size(first.max_written_end, truncate)?;
            Some(truncate)
        } else {
            None
        };

        let primary = ParsedIpsStream {
            range: 0..boundary,
            record_count: first.record_count,
            truncate_size,
            touches_header: first.touches_header,
        };

        let trailing = &bytes[boundary..];
        if trailing.is_empty() {
            primary_only.get_or_insert(primary);
            continue;
        }
        if !trailing.starts_with(IPS_MAGIC) {
            continue;
        }

        if let Ok(secondary) = parse_ips_standalone(trailing) {
            return Ok(ParsedSpatchBytes {
                primary,
                secondary: Some(ParsedIpsStream {
                    range: boundary..bytes.len(),
                    record_count: secondary.record_count,
                    truncate_size: secondary.truncate_size,
                    touches_header: secondary.touches_header,
                }),
            });
        }
    }

    if let Some(primary) = primary_only {
        return Ok(ParsedSpatchBytes {
            primary,
            secondary: None,
        });
    }

    Err(RomWeaverError::Validation(
        "SPATCH file is not a valid IPS or double-IPS stream".into(),
    ))
}

pub(crate) fn is_double_ips_stream(bytes: &[u8]) -> bool {
    parse_spatch_bytes(bytes)
        .ok()
        .is_some_and(|parsed| parsed.secondary.is_some())
}

fn parse_ips_standalone(bytes: &[u8]) -> Result<ParsedIpsStream> {
    let core = parse_ips_core(bytes)?;
    let remaining = &bytes[core.eof_end..];
    let truncate_size = match remaining.len() {
        0 => None,
        3 => {
            let truncate = read_u24(remaining);
            validate_truncate_size(core.max_written_end, truncate)?;
            Some(truncate)
        }
        _ => {
            return Err(RomWeaverError::Validation(
                "IPS patch contained unexpected trailing data after EOF".into(),
            ));
        }
    };

    Ok(ParsedIpsStream {
        range: 0..bytes.len(),
        record_count: core.record_count,
        truncate_size,
        touches_header: core.touches_header,
    })
}

fn parse_ips_core(bytes: &[u8]) -> Result<ParsedIpsCore> {
    if bytes.len() < IPS_MAGIC.len() + IPS_EOF.len() {
        return Err(RomWeaverError::Validation(
            "IPS patch is too small to contain a valid header and footer".into(),
        ));
    }
    if &bytes[..IPS_MAGIC.len()] != IPS_MAGIC {
        return Err(RomWeaverError::Validation("Patch header invalid".into()));
    }

    let mut cursor = IPS_MAGIC.len();
    let mut record_count = 0usize;
    let mut max_written_end = 0u64;
    let mut touches_header = false;
    loop {
        let marker = read_exact(bytes, cursor, IPS_EOF.len())?;
        cursor += IPS_EOF.len();
        if marker == IPS_EOF {
            return Ok(ParsedIpsCore {
                eof_end: cursor,
                record_count,
                max_written_end,
                touches_header,
            });
        }

        let offset = u64::from(read_u24(marker));
        let size_bytes = read_exact(bytes, cursor, 2)?;
        cursor += 2;
        let size = u16::from_be_bytes([size_bytes[0], size_bytes[1]]);
        let len = if size == 0 {
            let rle_len_bytes = read_exact(bytes, cursor, 2)?;
            cursor += 2;
            let rle_len = u16::from_be_bytes([rle_len_bytes[0], rle_len_bytes[1]]);
            if rle_len == 0 {
                return Err(RomWeaverError::Validation(
                    "IPS RLE record length must be greater than zero".into(),
                ));
            }
            let _ = read_exact(bytes, cursor, 1)?;
            cursor += 1;
            u64::from(rle_len)
        } else {
            let literal_len = usize::from(size);
            let _ = read_exact(bytes, cursor, literal_len)?;
            cursor += literal_len;
            u64::from(size)
        };

        let end = offset.checked_add(len).ok_or_else(|| {
            RomWeaverError::Validation("IPS record end overflowed available range".into())
        })?;
        if offset < SPATCH_HEADER_SIZE && len > 0 {
            touches_header = true;
        }
        max_written_end = max_written_end.max(end);
        record_count = record_count
            .checked_add(1)
            .ok_or_else(|| RomWeaverError::Validation("IPS record count overflowed".into()))?;
    }
}

fn validate_truncate_size(max_written_end: u64, truncate_size: u32) -> Result<()> {
    let truncate_size = u64::from(truncate_size);
    if max_written_end > truncate_size {
        return Err(RomWeaverError::Validation(format!(
            "IPS record exceeded declared output size {truncate_size}"
        )));
    }
    Ok(())
}

fn looks_headered_input(input_len: u64) -> bool {
    input_len >= SPATCH_HEADER_SIZE && input_len % 1024 == SPATCH_HEADER_SIZE
}

fn write_slice(bytes: &[u8], range: &Range<usize>, path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, &bytes[range.clone()])?;
    Ok(())
}

fn read_u24(bytes: &[u8]) -> u32 {
    (u32::from(bytes[0]) << 16) | (u32::from(bytes[1]) << 8) | u32::from(bytes[2])
}

fn read_exact<'a>(bytes: &'a [u8], offset: usize, len: usize) -> Result<&'a [u8]> {
    let end = offset
        .checked_add(len)
        .ok_or_else(|| RomWeaverError::Validation("IPS parser offset overflowed".into()))?;
    if end > bytes.len() {
        return Err(RomWeaverError::Validation(
            "IPS patch ended unexpectedly while reading record data".into(),
        ));
    }
    Ok(&bytes[offset..end])
}

fn create_headered_copy(input_path: &Path, output_path: &Path) -> Result<()> {
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut output = BufWriter::new(File::create(output_path)?);
    output.write_all(&[0u8; SPATCH_HEADER_SIZE as usize])?;

    let mut input = BufReader::new(File::open(input_path)?);
    std::io::copy(&mut input, &mut output)?;
    output.flush()?;
    Ok(())
}
