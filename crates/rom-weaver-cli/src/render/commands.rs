//! Per-command terminal renderers. Each reads the succeeded event's `details`/`label` by field name
//! (the same convention the webapp uses) and falls back to the label when its expected shape is absent.

use rom_weaver_core::ProgressEvent;
use serde_json::{Map, Value};

use super::{Surface, humanize_bytes};

/// Render the summary for a succeeded command, dispatching on the command name.
pub fn render_success(surface: &Surface, event: &ProgressEvent) {
    match event.command.as_str() {
        "probe" => render_container_or_patch(surface, event),
        "extract" | "compress" | "patch-apply" | "patch-create" => {
            render_emitted_files(surface, event)
        }
        "checksum" => render_checksum(surface, event),
        "patch-create-candidates" => render_candidates(surface, event),
        _ => render_details_or_label(surface, event),
    }
    render_elapsed(surface, event);
}

fn label_line(surface: &Surface, event: &ProgressEvent) {
    if !event.label.is_empty() {
        surface.line(&event.label);
    }
}

/// Probe/list: the container entries or a patch metadata block; otherwise the label.
fn render_container_or_patch(surface: &Surface, event: &ProgressEvent) {
    let Some(details) = event.details.as_ref() else {
        return render_details_or_label(surface, event);
    };
    if let Some(container) = details.get("container") {
        return render_container(surface, event, container);
    }
    if let Some(patch) = details.get("patch") {
        render_object(surface, patch);
        return;
    }
    render_details_or_label(surface, event);
}

fn render_container(surface: &Surface, event: &ProgressEvent, container: &Value) {
    // `list` carries a compress recommendation in its JSON, but nothing consumes it and it is noise
    // here, so the human view shows just the entries (it remains available via --json).
    let Some(entries) = container.get("entry_records").and_then(Value::as_array) else {
        label_line(surface, event);
        return;
    };
    let rows = entries
        .iter()
        .map(|entry| {
            vec![
                string_field(entry, "file_name"),
                size_field(entry, "size_bytes"),
            ]
        })
        .collect::<Vec<_>>();
    surface.rows(&rows);
}

/// Extract/compress/patch-apply/patch-create: the output files; otherwise the label.
fn render_emitted_files(surface: &Surface, event: &ProgressEvent) {
    let files = event
        .details
        .as_ref()
        .and_then(|details| details.get("emitted_files"))
        .and_then(Value::as_array);
    let Some(files) = files else {
        return render_details_or_label(surface, event);
    };
    let rows = files
        .iter()
        .map(|file| {
            vec![
                string_field(file, "file_name"),
                size_field(file, "size_bytes"),
                file.get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            ]
        })
        .collect::<Vec<_>>();
    surface.rows(&rows);
    surface.note(&format!("{} file(s) written", files.len()));
}

/// Checksum: digests parsed out of the space-joined `key=value` label, with range/cache as notes.
fn render_checksum(surface: &Surface, event: &ProgressEvent) {
    let mut digests = Vec::new();
    let mut notes = Vec::new();
    for token in event.label.split_whitespace() {
        let Some((key, value)) = token.split_once('=') else {
            continue;
        };
        match key {
            "range" | "cache" => notes.push((key.to_string(), value.to_string())),
            _ => digests.push((key.to_uppercase(), value.to_string())),
        }
    }
    if digests.is_empty() {
        return render_details_or_label(surface, event);
    }
    surface.key_values(&digests);
    for (key, value) in notes {
        surface.note(&format!("{key}: {value}"));
    }
}

/// Patch create-candidates: the ranked formats with the default marked, plus the flattened context.
fn render_candidates(surface: &Surface, event: &ProgressEvent) {
    let candidates = event
        .details
        .as_ref()
        .and_then(|details| details.get("patch_create_format_candidates"));
    let Some(candidates) = candidates else {
        return render_details_or_label(surface, event);
    };
    let default = candidates.get("default").and_then(Value::as_str);
    if let Some(formats) = candidates.get("formats").and_then(Value::as_array) {
        let rows = formats
            .iter()
            .filter_map(Value::as_str)
            .map(|format| {
                if Some(format) == default {
                    vec![format.to_string(), "← default".to_string()]
                } else {
                    vec![format.to_string()]
                }
            })
            .collect::<Vec<_>>();
        surface.rows(&rows);
    } else if let Some(default) = default {
        surface.key_values(&[("Default".to_string(), default.to_string())]);
    }
}

/// Fallback: render a recognized `details` object as flattened key/values, else the plain label.
fn render_details_or_label(surface: &Surface, event: &ProgressEvent) {
    match event.details.as_ref() {
        Some(details) if details.is_object() => render_object(surface, details),
        _ => label_line(surface, event),
    }
}

fn render_elapsed(surface: &Surface, event: &ProgressEvent) {
    let Some(elapsed_ms) = event.elapsed_ms else {
        return;
    };
    surface.note(&format!("elapsed: {}", format_elapsed_ms(elapsed_ms)));
}

fn format_elapsed_ms(elapsed_ms: u32) -> String {
    if elapsed_ms < 1_000 {
        return format!("{elapsed_ms}ms");
    }
    if elapsed_ms < 60_000 {
        return format!("{:.1}s", elapsed_ms as f64 / 1_000.0);
    }
    let total_seconds = elapsed_ms / 1_000;
    let seconds = total_seconds % 60;
    let total_minutes = total_seconds / 60;
    if total_minutes < 60 {
        return format!("{total_minutes}m {seconds:02}s");
    }
    let minutes = total_minutes % 60;
    let hours = total_minutes / 60;
    format!("{hours}h {minutes:02}m {seconds:02}s")
}

/// Render a JSON object as key/values, flattening nested objects with dotted keys and joining
/// scalar arrays with commas. `*_bytes` numeric fields are humanized.
fn render_object(surface: &Surface, value: &Value) {
    let Some(object) = value.as_object() else {
        return;
    };
    let mut pairs = Vec::new();
    collect_pairs("", object, &mut pairs);
    surface.key_values(&pairs);
}

fn collect_pairs(prefix: &str, object: &Map<String, Value>, pairs: &mut Vec<(String, String)>) {
    for (key, value) in object {
        let full_key = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        match value {
            Value::Object(nested) => collect_pairs(&full_key, nested, pairs),
            Value::Array(items) => {
                let joined = items
                    .iter()
                    .filter_map(scalar)
                    .collect::<Vec<_>>()
                    .join(", ");
                if !joined.is_empty() {
                    pairs.push((humanize_key(&full_key), joined));
                }
            }
            _ => {
                if let Some(text) = scalar_for_key(&full_key, value) {
                    pairs.push((humanize_key(&full_key), text));
                }
            }
        }
    }
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("-")
        .to_string()
}

fn size_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_u64)
        .map(humanize_bytes)
        .unwrap_or_else(|| "-".to_string())
}

/// Convert a scalar JSON value to a display string; `None` for null/array/object.
fn scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

fn scalar_for_key(key: &str, value: &Value) -> Option<String> {
    if key.ends_with("_bytes")
        && let Some(bytes) = value.as_u64()
    {
        return Some(humanize_bytes(bytes));
    }
    scalar(value)
}

/// `repaired_files` -> `Repaired files`; the last dotted segment is title-cased.
fn humanize_key(key: &str) -> String {
    let last = key.rsplit('.').next().unwrap_or(key);
    let spaced = last.replace('_', " ");
    let mut chars = spaced.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
        None => spaced,
    }
}
