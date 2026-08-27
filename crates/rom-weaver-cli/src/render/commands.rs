//! Per-command terminal renderers. Each reads the succeeded event's `details`/`label` by field name
//! (the same convention the webapp uses) and falls back to the label when its expected shape is absent.

use rom_weaver_core::ProgressEvent;
use serde_json::{Map, Value};

use super::{Surface, humanize_bytes};

/// Commands whose success rendering is a recap of work done rather than the
/// answer the user asked for. `--quiet` drops these; `probe`, `checksum`,
/// `patch validate` and friends keep printing because their summary *is* the
/// output.
const WRITE_SUMMARY_COMMANDS: &[&str] = &[
    "extract",
    "compress",
    "patch-apply",
    "patch-create",
    "trim",
    "ingest",
    "bundle-create",
    "bundle-apply",
    "save-set",
];

pub fn success_is_write_summary(command: &str) -> bool {
    WRITE_SUMMARY_COMMANDS.contains(&command)
}

/// Render the summary for a succeeded command, dispatching on the command name.
pub fn render_success(surface: &Surface, event: &ProgressEvent) {
    match event.command.as_str() {
        "probe" => render_container_or_patch(surface, event),
        "extract" | "compress" | "patch-apply" => render_emitted_files(surface, event),
        "patch-create" => {
            if event
                .details
                .as_ref()
                .and_then(|details| details.get("patch_create_format_candidates"))
                .is_some()
            {
                render_candidates(surface, event);
            } else {
                render_emitted_files(surface, event);
            }
        }
        "checksum" => render_checksum(surface, event),
        "save-identify" => render_save_identify(surface, event),
        "save-inspect" => render_save_inspect(surface, event),
        "save-get" => label_line(surface, event),
        "save-set" => render_save_result(surface, event),
        "save-export-schema" => render_save_schema(surface, event),
        _ => render_details_or_label(surface, event),
    }
    render_elapsed(surface, event);
}

fn save_editor_details(event: &ProgressEvent) -> Option<&Value> {
    event.details.as_ref()?.get("save_editor")
}

fn render_save_identify(surface: &Surface, event: &ProgressEvent) {
    let Some(save) = save_editor_details(event) else {
        return label_line(surface, event);
    };
    let document = save.get("document").filter(|value| value.is_object());
    if let Some(document) = document {
        let identity = document.get("identity").unwrap_or(&Value::Null);
        let integrity = document.get("integrity").unwrap_or(&Value::Null);
        let confidence = save
            .get("recognition")
            .and_then(|recognition| recognition.get("outcome"))
            .and_then(|outcome| outcome.get("recognized"))
            .and_then(|recognized| recognized.get("candidate"))
            .map(|candidate| title_case(&string_field(candidate, "confidence")))
            .filter(|value| !value.is_empty())
            .map(|value| format!("{value} confidence"))
            .unwrap_or_default();
        surface.key_values(&[
            ("Game".to_string(), string_field(identity, "name")),
            ("Platform".to_string(), string_field(document, "platform")),
            (
                "Save format".to_string(),
                string_field(document, "save_format_name"),
            ),
            ("Parser".to_string(), string_field(document, "handler_id")),
            ("Save size".to_string(), size_field(save, "save_size")),
            ("Integrity".to_string(), string_field(integrity, "state")),
            ("Recognition".to_string(), confidence),
            (
                "Active save slot".to_string(),
                number_field(document, "active_slot"),
            ),
        ]);
        return;
    }
    let recognition = save.get("recognition").unwrap_or(&Value::Null);
    let outcome = recognition.get("outcome").unwrap_or(&Value::Null);
    let recognition_label = if outcome.get("ambiguous").is_some() {
        "Ambiguous"
    } else {
        "Unsupported"
    };
    surface.key_values(&[
        ("Recognition".to_string(), recognition_label.to_string()),
        ("Save size".to_string(), size_field(save, "save_size")),
        (
            "Potential format".to_string(),
            string_field(save, "potential_format"),
        ),
    ]);
}

fn render_save_inspect(surface: &Surface, event: &ProgressEvent) {
    let Some(document) = save_editor_details(event).and_then(|save| save.get("document")) else {
        return label_line(surface, event);
    };
    let Some(fields) = document.get("fields").and_then(Value::as_array) else {
        return render_object(surface, document);
    };
    let mut current_group = String::new();
    for field in fields {
        let id = field.get("id").and_then(Value::as_str).unwrap_or("");
        let group = id.split_once('.').map(|(group, _)| group).unwrap_or("Save");
        if group != current_group {
            current_group = group.to_string();
            surface.note(&title_case(group));
        }
        surface.key_values(&[(
            string_field(field, "label"),
            save_json_value(field.get("value").unwrap_or(&Value::Null)),
        )]);
    }
}

fn render_save_result(surface: &Surface, event: &ProgressEvent) {
    let Some(save) = save_editor_details(event) else {
        return label_line(surface, event);
    };
    if let Some(result) = save.get("result") {
        if let Some(changes) = result
            .get("preview")
            .and_then(|preview| preview.get("changes"))
            .and_then(Value::as_array)
        {
            for change in changes {
                let field = change
                    .get("field")
                    .and_then(Value::as_str)
                    .unwrap_or("field");
                let old = change
                    .get("old_value")
                    .or_else(|| change.get("old"))
                    .map(save_json_value)
                    .unwrap_or_default();
                let new = change
                    .get("new_value")
                    .or_else(|| change.get("value"))
                    .map(save_json_value)
                    .unwrap_or_default();
                surface.key_values(&[(field.to_string(), format!("{old} -> {new}"))]);
            }
        }
    } else if let Some(schema) = save.get("schema") {
        render_object(surface, schema);
    } else {
        label_line(surface, event);
    }
}

fn render_save_schema(surface: &Surface, event: &ProgressEvent) {
    let Some(schema) = save_editor_details(event).and_then(|save| save.get("schema")) else {
        return label_line(surface, event);
    };
    if let Some(game) = schema.get("game") {
        surface.key_values(&[("Game".to_string(), string_field(game, "name"))]);
    }
    let Some(fields) = schema.get("fields").and_then(Value::as_array) else {
        return;
    };
    surface.note("Fields");
    let mut rows = vec![vec![
        "ID".to_string(),
        "Kind".to_string(),
        "Editable".to_string(),
    ]];
    rows.extend(fields.iter().map(|field| {
        vec![
            string_field(field, "id"),
            string_field(field, "kind"),
            field
                .get("editable")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                .to_string(),
        ]
    }));
    surface.rows(&rows);
}

fn save_json_value(value: &Value) -> String {
    if let Some(object) = value.as_object()
        && let Some(value) = object.values().next()
    {
        return match value {
            Value::String(value) => value.clone(),
            other => other.to_string(),
        };
    }
    match value {
        Value::String(value) => value.clone(),
        other => other.to_string(),
    }
}

fn number_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_u64)
        .map(|value| value.to_string())
        .unwrap_or_default()
}

fn title_case(value: &str) -> String {
    let mut chars = value.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
        .unwrap_or_default()
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

/// Patch create planning: the ranked formats with the default marked.
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
