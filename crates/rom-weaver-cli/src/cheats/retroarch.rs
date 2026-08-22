use std::collections::{BTreeMap, BTreeSet};

use rom_weaver_core::Result;

use super::{CheatRecord, CheatSystem, coded};

pub const MAX_CHT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_CHT_RECORDS: usize = 100_000;

#[derive(Clone, Debug)]
pub struct RetroArchParseOptions<'a> {
    pub system: CheatSystem,
    pub game_id: &'a str,
    pub source_file: &'a str,
    pub source_revision: &'a str,
}

fn unescape_quoted(value: &str) -> Result<String> {
    let trimmed = value.trim();
    if !trimmed.starts_with('"') {
        return Ok(trimmed.to_string());
    }
    if !trimmed.ends_with('"') || trimmed.len() < 2 {
        return Err(coded(
            "cheat_cht_malformed",
            "a quoted cheat value has no closing quote",
            value,
        ));
    }
    let mut output = String::new();
    let mut escaped = false;
    for character in trimmed[1..trimmed.len() - 1].chars() {
        if escaped {
            match character {
                'n' => output.push('\n'),
                'r' => output.push('\r'),
                't' => output.push('\t'),
                '"' => output.push('"'),
                '\\' => output.push('\\'),
                other => {
                    output.push('\\');
                    output.push(other);
                }
            }
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else {
            output.push(character);
        }
    }
    if escaped {
        output.push('\\');
    }
    Ok(output)
}

fn parse_record_key(key: &str) -> Option<(usize, &str)> {
    let rest = key.strip_prefix("cheat")?;
    let digit_count = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digit_count == 0 {
        return None;
    }
    let index = rest[..digit_count].parse().ok()?;
    let field = rest[digit_count..].strip_prefix('_')?;
    if field.is_empty() {
        return None;
    }
    Some((index, field))
}

fn stable_record_id(
    options: &RetroArchParseOptions<'_>,
    index: usize,
    fields: &BTreeMap<String, String>,
) -> String {
    let mut hasher = crc32fast::Hasher::new();
    hasher.update(options.system.id().as_bytes());
    hasher.update(&[0]);
    hasher.update(options.game_id.as_bytes());
    hasher.update(&[0]);
    hasher.update(options.source_file.as_bytes());
    hasher.update(&[0]);
    hasher.update(index.to_string().as_bytes());
    for (name, value) in fields {
        hasher.update(&[0]);
        hasher.update(name.as_bytes());
        hasher.update(&[0]);
        hasher.update(value.as_bytes());
    }
    format!(
        "{}:{}:{:08x}",
        options.system.id(),
        options.game_id,
        hasher.finalize()
    )
}

/// Parse real-world RetroArch cheat files without trusting their `cheats`
/// count. Unknown entry fields remain in their original source order.
pub fn parse_retroarch_cht(
    input: &str,
    options: RetroArchParseOptions<'_>,
) -> Result<Vec<CheatRecord>> {
    if input.len() > MAX_CHT_BYTES {
        return Err(coded(
            "cheat_cht_too_large",
            "the RetroArch cheat file exceeds the input limit",
            &input.len().to_string(),
        ));
    }
    let mut records: BTreeMap<usize, BTreeMap<String, String>> = BTreeMap::new();
    for (line_index, line) in input.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            continue;
        }
        let Some((key, raw_value)) = trimmed.split_once('=') else {
            tracing::debug!(
                line = line_index + 1,
                "ignored malformed RetroArch cheat line"
            );
            continue;
        };
        let key = key.trim();
        let Some((index, field)) = parse_record_key(key) else {
            continue;
        };
        if !records.contains_key(&index) && records.len() >= MAX_CHT_RECORDS {
            return Err(coded(
                "cheat_cht_too_many_records",
                "the RetroArch cheat file exceeds the record limit",
                &records.len().to_string(),
            ));
        }
        let value = unescape_quoted(raw_value)?;
        records
            .entry(index)
            .or_default()
            .insert(field.to_string(), value);
    }

    Ok(records
        .into_iter()
        .map(|(source_index, raw_fields)| {
            let description = raw_fields
                .get("desc")
                .cloned()
                .unwrap_or_else(|| format!("Cheat {source_index}"));
            let raw_code = raw_fields.get("code").cloned();
            CheatRecord {
                id: stable_record_id(&options, source_index, &raw_fields),
                system: options.system,
                game_id: options.game_id.to_string(),
                description,
                raw_code,
                code_kind: None,
                raw_fields,
                source_file: options.source_file.to_string(),
                source_index,
                source_revision: options.source_revision.to_string(),
            }
        })
        .collect())
}

fn escape_value(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    output.push('"');
    for character in value.chars() {
        match character {
            '\\' => output.push_str("\\\\"),
            '"' => output.push_str("\\\""),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            other => output.push(other),
        }
    }
    output.push('"');
    output
}

fn ordered_fields(record: &CheatRecord) -> Vec<(String, String)> {
    let mut by_name = record.raw_fields.clone();
    if !by_name.contains_key("desc") {
        by_name.insert("desc".to_string(), record.description.clone());
    }
    if let Some(code) = record.raw_code.as_deref() {
        by_name.insert("code".to_string(), code.to_string());
    }
    by_name.insert("enable".to_string(), "true".to_string());

    let mut output = Vec::new();
    let mut used = BTreeSet::new();
    for name in ["desc", "code", "enable"] {
        if let Some(value) = by_name.get(name) {
            output.push((name.to_string(), value.clone()));
            used.insert(name);
        }
    }
    for (name, value) in by_name {
        if !used.contains(name.as_str()) {
            output.push((name, value));
        }
    }
    output
}

/// Export selected logical entries with contiguous indexes and deterministic
/// field order. Native and structured source values are not regenerated.
pub fn export_retroarch_cht(records: &[CheatRecord]) -> Result<String> {
    if records.len() > MAX_CHT_RECORDS {
        return Err(coded(
            "cheat_cht_too_many_records",
            "the RetroArch cheat export exceeds the record limit",
            &records.len().to_string(),
        ));
    }
    let mut output = format!("cheats = {}\n", records.len());
    for (index, record) in records.iter().enumerate() {
        for (name, value) in ordered_fields(record) {
            let rendered = if name == "enable" {
                "true".to_string()
            } else {
                escape_value(&value)
            };
            output.push_str(&format!("cheat{index}_{name} = {rendered}\n"));
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> RetroArchParseOptions<'static> {
        RetroArchParseOptions {
            system: CheatSystem::GameBoy,
            game_id: "invented-game",
            source_file: "Nintendo - Game Boy/Test.cht",
            source_revision: "0123456",
        }
    }

    #[test]
    fn parses_noncontiguous_records_and_ignores_wrong_count() {
        let input = r#"
            # public-domain synthetic fixture
            cheats = 99
            cheat2_desc = "Lives \"forever\""
            cheat2_code = 01050EC6+01060FC6
            cheat2_enable = false
            cheat2_future_field = "keep me"
            cheat7_desc = Duplicate
            cheat7_address = "1234"
            cheat7_handler = "1"
        "#;
        let records = parse_retroarch_cht(input, options()).unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].source_index, 2);
        assert_eq!(records[0].description, "Lives \"forever\"");
        assert_eq!(records[0].raw_code.as_deref(), Some("01050EC6+01060FC6"));
        assert_eq!(
            records[0]
                .raw_fields
                .get("future_field")
                .map(String::as_str),
            Some("keep me")
        );
        assert_eq!(records[1].source_index, 7);
        assert_eq!(records[1].raw_code, None);
    }

    #[test]
    fn export_is_deterministic_contiguous_and_selected_only() {
        let parsed = parse_retroarch_cht(
            "cheat3_desc = B\ncheat3_code = 0102ABCD\ncheat3_z = last\n\
             cheat9_desc = A\ncheat9_code = 0103ABCD\n",
            options(),
        )
        .unwrap();
        let output = export_retroarch_cht(&parsed[1..]).unwrap();
        assert_eq!(
            output,
            "cheats = 1\ncheat0_desc = \"A\"\ncheat0_code = \"0103ABCD\"\ncheat0_enable = true\n"
        );
        let reparsed = parse_retroarch_cht(&output, options()).unwrap();
        assert_eq!(reparsed[0].description, "A");
        assert_eq!(reparsed[0].raw_code.as_deref(), Some("0103ABCD"));
    }

    #[test]
    fn escaped_values_round_trip() {
        let parsed = parse_retroarch_cht(
            "cheat0_desc = \"line\\nquote: \\\" and slash: \\\\\"\ncheat0_code = 0102ABCD\n",
            options(),
        )
        .unwrap();
        let output = export_retroarch_cht(&parsed).unwrap();
        let reparsed = parse_retroarch_cht(&output, options()).unwrap();
        assert_eq!(reparsed[0].description, parsed[0].description);
    }

    #[test]
    fn ids_are_stable_and_source_sensitive() {
        let input = "cheat0_desc = A\ncheat0_code = 0102ABCD\n";
        let first = parse_retroarch_cht(input, options()).unwrap();
        let second = parse_retroarch_cht(input, options()).unwrap();
        assert_eq!(first[0].id, second[0].id);
        let mut changed = options();
        changed.source_file = "other.cht";
        let other = parse_retroarch_cht(input, changed).unwrap();
        assert_ne!(first[0].id, other[0].id);
    }
}
