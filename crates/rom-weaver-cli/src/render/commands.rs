//! Per-command terminal renderers. Each reads the succeeded event's `details`/`label` by field name
//! (the same convention the webapp uses) and falls back to the label when its expected shape is absent.

use rom_weaver_core::ProgressEvent;
use serde_json::{Map, Value};

use super::{Surface, humanize_bytes};

#[derive(Default)]
pub(super) struct OutputSelection {
    explicit_output: Option<std::path::PathBuf>,
    suppress_files: bool,
    probe: bool,
}

impl OutputSelection {
    pub(super) fn for_command(command: &crate::Commands) -> Self {
        use crate::{BundleCommands, Commands, PatchCommands, SaveCommands, ToolsCommands};
        let mut selection = Self::default();
        selection.explicit_output = match command {
            Commands::Compress(args) => Some(args.output.clone()),
            Commands::Patch(PatchCommands::Apply(args)) => args.output.clone(),
            Commands::Patch(PatchCommands::Create(args)) => args.output.clone(),
            Commands::Bundle(BundleCommands::Create(args)) => Some(args.output.clone()),
            Commands::Save(SaveCommands::Set(args)) => args.output.clone(),
            Commands::Tools(ToolsCommands::PpfUndo(args)) => Some(args.output.clone()),
            Commands::Trim(args) => {
                selection.suppress_files = args.in_place;
                args.output.clone()
            }
            Commands::Extract(args) => {
                selection.probe = args.probe;
                None
            }
            _ => None,
        };
        selection
    }

    fn shows_file(&self, file: &Value) -> bool {
        if self.suppress_files {
            return false;
        }
        let Some(output) = &self.explicit_output else {
            return true;
        };
        if output == std::path::Path::new("-") {
            return false;
        }
        let Some(path) = file.get("path").and_then(Value::as_str) else {
            return false;
        };
        let output = std::fs::canonicalize(output).unwrap_or_else(|_| output.clone());
        let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.into());
        output != path
    }
}

pub(super) fn render_success(
    surface: &Surface,
    event: &ProgressEvent,
    selection: &OutputSelection,
) {
    if is_dry_run(event) {
        return render_dry_run(surface, event);
    }
    match event.command.as_str() {
        "probe" => render_container_or_patch(surface, event),
        "extract" | "compress" | "patch-apply" | "trim" | "bundle-create" | "tools-ppf-undo" => {
            render_emitted_files(surface, event, selection);
        }
        "patch-create" => {
            if event
                .details
                .as_ref()
                .and_then(|details| details.get("patch_create_format_candidates"))
                .is_some()
            {
                render_candidates(surface, event);
            } else {
                render_emitted_files(surface, event, selection);
            }
        }
        "patch-validate" => label_line(surface, event),
        "checksum" => render_checksum(surface, event),
        "identify" if event.format.as_deref() == Some("identify-database") => {
            render_database(surface, event);
        }
        "identify" => render_identify(surface, event),
        "setup" => {}
        "cheat" => render_cheat_list(surface, event),
        "save-identify" => render_save_identify(surface, event),
        "save-inspect" => render_save_inspect(surface, event),
        "save-get" => label_line(surface, event),
        "save-set" if is_save_preview(event) => render_save_result(surface, event),
        "save-set" => render_emitted_files(surface, event, selection),
        "save-export-schema" => render_save_schema(surface, event),
        _ => render_details_or_label(surface, event),
    }
}

pub(super) fn render_verbose(surface: &Surface, event: &ProgressEvent) {
    let diagnostics = surface.diagnostics();
    if is_dry_run(event) || is_save_preview(event) {
        return;
    }
    if let Some(files) = event
        .details
        .as_ref()
        .and_then(|details| details.get("emitted_files"))
        .and_then(Value::as_array)
        .filter(|files| !files.is_empty())
    {
        for file in files {
            let path = emitted_file_path(file);
            let size = size_field(file, "size_bytes");
            let codec = event
                .details
                .as_ref()
                .and_then(|details| details.get("compression"))
                .and_then(|compression| compression.get("codec"))
                .and_then(Value::as_str)
                .or(event.format.as_deref());
            let kind = codec.map(|codec| format!(", {codec}")).unwrap_or_default();
            diagnostics.line(&format!("{}: wrote {path} ({size}{kind})", event.command));
        }
    } else if !event.label.is_empty() {
        diagnostics.line(&format!("{}: {}", event.command, event.label));
    }
    if event.command == "probe" {
        if let Some(details) = event.details.as_ref() {
            let container = details.get("container").unwrap_or(details);
            for field in ["recommended_compress_format", "reason"] {
                if let Some(value) = container.get(field).and_then(Value::as_str) {
                    diagnostics.line(&format!("probe: {}: {value}", humanize_key(field)));
                }
            }
        }
    } else if event.command == "patch-validate"
        && let Some(details) = &event.details
    {
        render_object(&diagnostics, details);
    }
    if let Some(elapsed) = event.elapsed_ms {
        diagnostics.line(&format!(
            "{}: finished in {}",
            event.command,
            format_elapsed_ms(elapsed)
        ));
    }
}

fn render_database(surface: &Surface, event: &ProgressEvent) {
    let Some(details) = &event.details else {
        return;
    };
    match event.stage.as_str() {
        "path" => {
            if let Some(path) = details.get("database_dir").and_then(Value::as_str) {
                surface.line(path);
            }
        }
        "list" => {
            if let Some(platforms) = details.get("platforms").and_then(Value::as_array) {
                let rows = platforms
                    .iter()
                    .map(|platform| {
                        vec![
                            string_field(platform, "platform"),
                            string_field(platform, "source"),
                            string_field(platform, "pack_slug"),
                            if platform.get("installed").and_then(Value::as_bool) == Some(true) {
                                "installed".to_string()
                            } else {
                                "not installed".to_string()
                            },
                        ]
                    })
                    .collect::<Vec<_>>();
                surface.rows(&rows);
            }
        }
        "status" => {
            if let Some(packs) = details.get("packs").and_then(Value::as_array) {
                let rows = packs
                    .iter()
                    .map(|pack| {
                        vec![
                            string_field(pack, "slug"),
                            string_field(pack, "format"),
                            size_field(pack, "bytes"),
                            string_field(pack, "sha256"),
                        ]
                    })
                    .collect::<Vec<_>>();
                surface.rows(&rows);
            }
        }
        _ => {}
    }
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
            ("Container".to_string(), container_field(save)),
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
    let recognition_label = if outcome.get("recognized").is_some() {
        "Recognized"
    } else if outcome.get("ambiguous").is_some() {
        "Ambiguous"
    } else {
        "Unsupported"
    };
    surface.key_values(&[
        ("Recognition".to_string(), recognition_label.to_string()),
        ("Save size".to_string(), size_field(save, "save_size")),
        ("Container".to_string(), container_field(save)),
        (
            "Potential format".to_string(),
            string_field(save, "potential_format"),
        ),
    ]);
    if let Some(candidate) = outcome
        .get("recognized")
        .and_then(|recognized| recognized.get("candidate"))
    {
        render_save_candidate(surface, candidate);
    }
    if let Some(candidates) = outcome
        .get("ambiguous")
        .and_then(|ambiguous| ambiguous.get("candidates"))
        .and_then(Value::as_array)
    {
        for candidate in candidates {
            render_save_candidate(surface, candidate);
        }
    }
}

fn render_save_candidate(surface: &Surface, candidate: &Value) {
    if let Some(identity) = candidate.get("identity") {
        surface.key_values(&[
            ("Game".to_string(), string_field(identity, "name")),
            ("Game ID".to_string(), string_field(identity, "id")),
            (
                "Confidence".to_string(),
                string_field(candidate, "confidence"),
            ),
        ]);
    }
}

fn container_field(save: &Value) -> String {
    save.get("container")
        .filter(|container| container.is_object())
        .map_or_else(
            || "none".to_string(),
            |container| string_field(container, "name"),
        )
}

fn render_save_inspect(surface: &Surface, event: &ProgressEvent) {
    let Some(document) = save_editor_details(event).and_then(|save| save.get("document")) else {
        return label_line(surface, event);
    };
    let Some(fields) = document.get("fields").and_then(Value::as_array) else {
        render_object(surface, document);
        return;
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
        return label_line(surface, event);
    }
    label_line(surface, event);
    surface.note("no files written");
}

fn is_save_preview(event: &ProgressEvent) -> bool {
    event.command == "save-set" && event.stage == "preview"
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
    if let Some(patch) = details.get("patch")
        && render_object(surface, patch)
    {
        return;
    }
    if let Some(format) = &event.format {
        surface.key_values(&[("Format".to_string(), format.clone())]);
    }
    let pairs = probe_pairs(details);
    if pairs.is_empty() {
        label_line(surface, event);
    } else {
        surface.key_values(&pairs);
    }
}

fn probe_pairs(details: &Value) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    if let Some(details) = details.as_object() {
        for (key, value) in details {
            if !matches!(
                key.as_str(),
                "container" | "recommended_compress_format" | "reason"
            ) {
                collect_value(key, value, &mut pairs);
            }
        }
    }
    pairs
}

fn render_container(surface: &Surface, event: &ProgressEvent, container: &Value) {
    if let Some(format) = &event.format {
        surface.key_values(&[("Format".to_string(), format.clone())]);
    }
    if let Some(details) = event.details.as_ref() {
        surface.key_values(&probe_pairs(details));
    }
    if let Some(container) = container.as_object() {
        let mut pairs = Vec::new();
        for (key, value) in container {
            if !matches!(
                key.as_str(),
                "entries"
                    | "entry_records"
                    | "recommended_compress_format"
                    | "compress_recommendation"
                    | "reason"
            ) {
                collect_value(key, value, &mut pairs);
            }
        }
        surface.key_values(&pairs);
    }
    let Some(entries) = container.get("entry_records").and_then(Value::as_array) else {
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

fn render_emitted_files(surface: &Surface, event: &ProgressEvent, selection: &OutputSelection) {
    let Some(files) = event
        .details
        .as_ref()
        .and_then(|details| details.get("emitted_files"))
        .and_then(Value::as_array)
    else {
        return;
    };
    let rows = files
        .iter()
        .filter(|file| selection.shows_file(file))
        .map(|file| emitted_file_row(file, selection.probe))
        .collect::<Vec<_>>();
    surface.rows(&rows);
}

fn emitted_file_path(file: &Value) -> String {
    nonempty_string_field(file, "path").unwrap_or_else(|| string_field(file, "file_name"))
}

fn emitted_file_row(file: &Value, probe: bool) -> Vec<String> {
    let mut row = vec![emitted_file_path(file)];
    if probe {
        if let Some(kind) = file.get("kind").and_then(Value::as_str) {
            row.push(kind.to_string());
        }
        for field in ["format", "platform", "disc_format"] {
            if let Some(value) = file.get(field).and_then(Value::as_str) {
                row.push(format!("{field}={value}"));
            }
        }
    }
    if let Some(checksums) = file.get("checksums").and_then(Value::as_object) {
        for (algorithm, digest) in checksums {
            if let Some(digest) = digest.as_str() {
                row.push(format!("{algorithm}={digest}"));
            }
        }
    }
    row
}

/// Dry runs describe the command plan without using the normal success renderer, which would say
/// that planned files were written. Existing detailed plans retain their fields, and common plans
/// use `writes`/`downloads` to make every side effect explicit.
fn render_dry_run(surface: &Surface, event: &ProgressEvent) {
    label_line(surface, event);
    let Some(details) = event.details.as_ref().and_then(Value::as_object) else {
        surface.note("no files written");
        return;
    };

    surface.key_values(&dry_run_pairs(details));

    if needs_no_files_written_notice(&event.label) {
        surface.note("no files written");
    }
}

fn needs_no_files_written_notice(label: &str) -> bool {
    !label.contains("nothing written") && !label.contains("no changes planned")
}

fn dry_run_pairs(details: &Map<String, Value>) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for (key, value) in details {
        if matches!(
            key.as_str(),
            "dry_run" | "command" | "writes" | "downloads" | "read_only"
        ) {
            continue;
        }
        collect_value(key, value, &mut pairs);
    }
    append_plan_targets("Writes", details.get("writes"), &mut pairs);
    append_plan_targets("Downloads", details.get("downloads"), &mut pairs);
    if let Some(read_only) = details.get("read_only").and_then(Value::as_bool) {
        pairs.push(("Read only".to_string(), yes_no(read_only).to_string()));
    }
    pairs
}

pub(super) fn is_dry_run(event: &ProgressEvent) -> bool {
    event
        .details
        .as_ref()
        .and_then(|details| details.get("dry_run"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn append_plan_targets(label: &str, value: Option<&Value>, pairs: &mut Vec<(String, String)>) {
    let Some(value) = value else {
        pairs.push((label.to_string(), "none".to_string()));
        return;
    };
    match value {
        Value::Array(items) if items.is_empty() => {
            pairs.push((label.to_string(), "none".to_string()));
        }
        Value::Array(items) => {
            for item in items {
                pairs.push((label.to_string(), display_value(item)));
            }
        }
        _ => pairs.push((label.to_string(), display_value(value))),
    }
}

/// Structured digests MUST take precedence over labels, which can contain contextual suffixes.
fn render_checksum(surface: &Surface, event: &ProgressEvent) {
    let digests = checksum_pairs(event);
    if digests.is_empty() {
        return render_details_or_label(surface, event);
    }
    surface.key_values(&digests);
    for token in checksum_label(event).split_whitespace() {
        let Some((key, value)) = token.split_once('=') else {
            continue;
        };
        if key == "range" {
            surface.key_values(&[("Range".to_string(), value.to_string())]);
        }
    }
}

fn checksum_label(event: &ProgressEvent) -> &str {
    event.label.split(';').next().unwrap_or(&event.label)
}

fn checksum_pairs(event: &ProgressEvent) -> Vec<(String, String)> {
    if let Some(checksums) = event
        .details
        .as_ref()
        .and_then(|details| details.get("checksums"))
        .and_then(Value::as_object)
    {
        return checksums
            .iter()
            .filter_map(|(algorithm, value)| {
                value
                    .as_str()
                    .map(|value| (algorithm.to_uppercase(), value.to_string()))
            })
            .collect();
    }
    checksum_label(event)
        .split_whitespace()
        .filter_map(|token| token.split_once('='))
        .filter(|(key, _)| !matches!(*key, "range" | "cache"))
        .map(|(key, value)| (key.to_uppercase(), value.to_string()))
        .collect()
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
    if let Some(formats) = candidates
        .get("formats")
        .and_then(Value::as_array)
        .filter(|formats| !formats.is_empty())
    {
        let rows = formats
            .iter()
            .filter_map(Value::as_str)
            .map(|format| {
                if Some(format) == default {
                    vec![format.to_string(), "(default)".to_string()]
                } else {
                    vec![format.to_string()]
                }
            })
            .collect::<Vec<_>>();
        surface.rows(&rows);
    } else if let Some(default) = default {
        surface.key_values(&[("Default".to_string(), default.to_string())]);
    } else {
        label_line(surface, event);
    }
}

/// Cheat attribution MUST remain visible with every result, including an empty list.
fn render_cheat_list(surface: &Surface, event: &ProgressEvent) {
    let Some(list) = event
        .details
        .as_ref()
        .and_then(|details| details.get("cheat_list"))
    else {
        return render_details_or_label(surface, event);
    };
    let text = |key: &str| list.get(key).and_then(Value::as_str).unwrap_or("");
    surface.line(&format!(
        "system {}, matched by {}{}",
        text("system"),
        text("match_kind"),
        match text("game_id") {
            "" => String::new(),
            id => format!(" (game {id})"),
        }
    ));
    let entries = list.get("entries").and_then(Value::as_array);
    let Some(entries) = entries else {
        return surface.line(text("attribution"));
    };
    let rows = entries
        .iter()
        .map(|entry| {
            ["id", "delivery", "code", "description"]
                .iter()
                .map(|key| string_field(entry, key))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    surface.rows(&rows);
    surface.line(text("attribution"));
}

fn render_identify(surface: &Surface, event: &ProgressEvent) {
    let Some(identify) = event
        .details
        .as_ref()
        .and_then(|details| details.get("identify"))
        .and_then(Value::as_object)
    else {
        return render_details_or_label(surface, event);
    };
    if let Some(hint) = identify.get("hint").and_then(Value::as_str) {
        surface.diagnostics().line(&format!("identify: {hint}"));
    }
    let Some(matches) = identify.get("matches").and_then(Value::as_array) else {
        return label_line(surface, event);
    };
    if matches.is_empty() {
        return label_line(surface, event);
    }
    surface.rows(&identify_rows(matches));
    let mut qualifiers = Vec::new();
    if let Some(quality) = identify.get("quality").and_then(Value::as_str) {
        qualifiers.push(("Match quality".to_string(), quality.to_string()));
    }
    if let Some(evidence) = identify.get("evidence") {
        for key in ["missing_components", "unexpected_components"] {
            if let Some(value) = evidence
                .get(key)
                .filter(|value| value.as_array().is_some_and(|items| !items.is_empty()))
            {
                collect_value(key, value, &mut qualifiers);
            }
        }
    }
    surface.key_values(&qualifiers);
}

fn identify_rows(matches: &[Value]) -> Vec<Vec<String>> {
    matches
        .iter()
        .map(|entry| {
            let mut row = vec![string_field(entry, "name"), string_field(entry, "platform")];
            if let Some(names) = entry.get("alternate_names").and_then(Value::as_array) {
                let names = names
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|name| Some(*name) != entry.get("name").and_then(Value::as_str))
                    .collect::<Vec<_>>();
                if !names.is_empty() {
                    row.push(format!("also={}", names.join("; ")));
                }
            }
            for key in ["region", "language", "revision", "disc_number", "game_id"] {
                if let Some(value) = entry.get(key).and_then(scalar) {
                    row.push(format!("{key}={value}"));
                }
            }
            if let Some(tags) = entry.get("dump_tags").and_then(Value::as_array) {
                row.extend(tags.iter().filter_map(Value::as_str).map(str::to_string));
            }
            if let Some(component) = entry
                .get("expected_components")
                .and_then(Value::as_array)
                .and_then(|components| components.first())
            {
                for algorithm in ["crc32", "sha1", "md5"] {
                    if let Some(digest) = component.get(algorithm).and_then(Value::as_str) {
                        row.push(format!("{algorithm}={digest}"));
                        break;
                    }
                }
            }
            if let Some(variant) = entry.get("variant").and_then(Value::as_str)
                && variant != "name"
            {
                row.push(format!("variant={variant}"));
            }
            if let Some(database) = entry.get("database").and_then(Value::as_str) {
                row.push(format!("database={database}"));
            }
            row
        })
        .collect()
}

fn render_details_or_label(surface: &Surface, event: &ProgressEvent) {
    label_line(surface, event);
    if let Some(details) = event.details.as_ref() {
        render_object(surface, details);
    }
}

pub(crate) fn format_elapsed_ms(elapsed_ms: u32) -> String {
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

/// Render a JSON object as key/values, flattening nested objects. Arrays keep all their values,
/// including objects, so an otherwise valid response never becomes a blank terminal summary.
/// `*_bytes` numeric fields are humanized. Returns whether it rendered anything.
fn render_object(surface: &Surface, value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let mut pairs = Vec::new();
    collect_pairs("", object, &mut pairs);
    if pairs.is_empty() {
        return false;
    }
    surface.key_values(&pairs);
    true
}

fn collect_pairs(prefix: &str, object: &Map<String, Value>, pairs: &mut Vec<(String, String)>) {
    for (key, value) in object {
        let full_key = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        collect_value(&full_key, value, pairs);
    }
}

fn collect_value(key: &str, value: &Value, pairs: &mut Vec<(String, String)>) {
    if key == "warnings" || is_execution_detail(key) {
        return;
    }
    match value {
        Value::Object(nested) if nested.is_empty() => {
            pairs.push((humanize_key(key), "none".to_string()));
        }
        Value::Object(nested) => collect_pairs(key, nested, pairs),
        Value::Array(items) if items.iter().any(|item| item.is_object() || item.is_array()) => {
            for (index, item) in items.iter().enumerate() {
                collect_value(&format!("{key}[{}]", index + 1), item, pairs);
            }
        }
        Value::Array(_) => pairs.push((humanize_key(key), display_value(value))),
        _ => {
            if let Some(text) = scalar_for_key(key, value) {
                pairs.push((humanize_key(key), text));
            }
        }
    }
}

fn is_execution_detail(key: &str) -> bool {
    let Some((parent, field)) = key.rsplit_once('.') else {
        return false;
    };
    matches!(parent, "compression" | "extraction")
        && matches!(
            field,
            "requested_threads"
                | "effective_threads"
                | "thread_mode"
                | "used_parallelism"
                | "thread_fallback"
                | "thread_fallback_reason"
        )
}

fn display_value(value: &Value) -> String {
    match value {
        Value::Array(items) => {
            let values = items
                .iter()
                .filter(|item| !item.is_null())
                .map(|item| scalar(item).unwrap_or_else(|| item.to_string()))
                .collect::<Vec<_>>();
            if values.is_empty() {
                "none".to_string()
            } else {
                values.join(", ")
            }
        }
        _ => scalar(value).unwrap_or_else(|| value.to_string()),
    }
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("-")
        .to_string()
}

fn nonempty_string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
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

fn yes_no(value: bool) -> &'static str {
    if value { "yes" } else { "no" }
}

/// Parent labels MUST remain visible so source and target values do not share the same heading.
fn humanize_key(key: &str) -> String {
    key.split('.')
        .map(|part| title_case(&part.replace('_', " ")))
        .collect::<Vec<_>>()
        .join(" / ")
}

#[cfg(test)]
#[path = "../../tests/unit/render_commands.rs"]
mod tests;
