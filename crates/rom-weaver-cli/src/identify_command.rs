use std::collections::{BTreeMap, BTreeSet};

use rom_weaver_checksum::identify_pack::{IdentifyQuery, SystemPack};

use super::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "typescript-types", ts(rename_all = "snake_case"))]
pub enum IdentifyStatus {
    Matched,
    Ambiguous,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct IdentifyTitleMatch {
    pub name: String,
    pub platform: String,
    pub algorithm: String,
    pub variant: String,
    pub database: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct IdentifyResult {
    pub status: IdentifyStatus,
    pub input: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub detected_platform: Option<String>,
    pub checksums: BTreeMap<String, String>,
    pub checksum_variants: Vec<Value>,
    pub matches: Vec<IdentifyTitleMatch>,
}

impl CliApp {
    pub(super) fn run_identify(&self, mut args: IdentifyCommand) -> AppRunOutcome {
        let _stdin_guard = match crate::stdin_input::spool_stdin_if_dash(&mut args.input) {
            Ok(guard) => guard,
            Err(error) => {
                return self.finish(
                    "identify",
                    OperationReport::failed(
                        OperationFamily::Command,
                        Some("identify".to_string()),
                        "read",
                        format!("failed to read stdin input: {error}"),
                        None,
                    ),
                );
            }
        };
        trace!(
            source = %args.input.display(),
            databases = args.database.len(),
            selections = args.select.len(),
            no_extract = args.no_extract,
            no_ignore = args.no_ignore,
            no_trim_fix = args.no_trim_fix,
            threads = %args.threads,
            "starting identify command"
        );
        let IdentifyCommand {
            input,
            database,
            select,
            filter,
            no_extract,
            no_ignore,
            no_trim_fix,
            threads,
        } = args;
        let mut checksum_report = self.run_checksum_inner_for_identify(ChecksumCommand {
            input: input.clone(),
            algo: vec!["crc32".to_string(), "md5".to_string(), "sha1".to_string()],
            select,
            filter,
            no_extract,
            no_ignore,
            no_trim_fix,
            start: None,
            length: None,
            probe: false,
            threads,
        });
        if checksum_report.status != OperationStatus::Succeeded {
            checksum_report.stage = "identify".to_string();
            return self.finish("identify", checksum_report);
        }

        let details = checksum_report.details.take().unwrap_or(Value::Null);
        let checksums = checksum_map(details.get("checksums"));
        let checksum_variants = details
            .get("checksum_variants")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| {
                vec![json!({
                    "id": "raw",
                    "label": "Raw",
                    "checksums": checksums,
                })]
            });
        let detected_platform = details
            .get("platform")
            .and_then(Value::as_str)
            .map(str::to_string);

        let matches = match identify_variants(&database, &checksum_variants) {
            Ok(matches) => matches,
            Err(error) => {
                return self.finish(
                    "identify",
                    OperationReport::failed(
                        OperationFamily::Command,
                        Some("identify".to_string()),
                        "identify",
                        error.to_string(),
                        checksum_report.thread_execution,
                    ),
                );
            }
        };
        let status = match matches.len() {
            0 => IdentifyStatus::Unknown,
            1 => IdentifyStatus::Matched,
            _ => IdentifyStatus::Ambiguous,
        };
        let label = match status {
            IdentifyStatus::Matched => format!("identified {}", matches[0].name),
            IdentifyStatus::Ambiguous => format!("found {} possible titles", matches.len()),
            IdentifyStatus::Unknown => "no title matched the supplied database".to_string(),
        };
        let result = IdentifyResult {
            status,
            input: input.to_string_lossy().replace('\\', "/"),
            detected_platform,
            checksums,
            checksum_variants,
            matches,
        };
        let mut report = OperationReport::succeeded(
            OperationFamily::Command,
            Some("identify".to_string()),
            "identify",
            label,
            Some(100.0),
            checksum_report.thread_execution,
        );
        report.details = Some(json!({ "identify": result }));
        self.finish("identify", report)
    }
}

fn identify_variants(databases: &[PathBuf], variants: &[Value]) -> Result<Vec<IdentifyTitleMatch>> {
    let mut output = Vec::new();
    let mut seen = BTreeSet::new();
    if databases.is_empty() {
        #[cfg(target_arch = "wasm32")]
        return Err(RomWeaverError::Validation(
            "the browser identify command requires a staged --database pack".to_string(),
        ));
        #[cfg(not(target_arch = "wasm32"))]
        for &(database_name, bytes) in super::identify_builtin::PACKS {
            identify_pack(database_name, bytes, variants, &mut seen, &mut output)?;
        }
    }
    for database in databases {
        trace!(database = %database.display(), "loading ROM identify pack");
        let bytes = fs::read(database).map_err(|error| {
            RomWeaverError::Validation(format!(
                "failed to read ROM identify pack `{}`: {error}",
                database.display()
            ))
        })?;
        let pack = SystemPack::parse(&bytes)?;
        let database_name = database
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| database.to_string_lossy().into_owned());
        identify_parsed_pack(&database_name, &pack, variants, &mut seen, &mut output)?;
    }
    output.sort_by(|left, right| {
        (&left.platform, &left.name, &left.variant).cmp(&(
            &right.platform,
            &right.name,
            &right.variant,
        ))
    });
    Ok(output)
}

#[cfg(not(target_arch = "wasm32"))]
fn identify_pack(
    database_name: &str,
    bytes: &[u8],
    variants: &[Value],
    seen: &mut BTreeSet<(String, String)>,
    output: &mut Vec<IdentifyTitleMatch>,
) -> Result<()> {
    trace!(
        database = database_name,
        "loading built-in ROM identify pack"
    );
    let pack = SystemPack::parse(bytes)?;
    identify_parsed_pack(database_name, &pack, variants, seen, output)
}

fn identify_parsed_pack(
    database_name: &str,
    pack: &SystemPack,
    variants: &[Value],
    seen: &mut BTreeSet<(String, String)>,
    output: &mut Vec<IdentifyTitleMatch>,
) -> Result<()> {
    for variant in variants {
        let variant_id = variant.get("id").and_then(Value::as_str).unwrap_or("raw");
        let values = checksum_map(variant.get("checksums"));
        let lookup = pack.resolve(&IdentifyQuery {
            crc32: values.get("crc32").map(String::as_str),
            md5: values.get("md5").map(String::as_str),
            sha1: values.get("sha1").map(String::as_str),
        })?;
        let Some(algorithm) = lookup.algorithm else {
            continue;
        };
        for title in lookup.matches {
            let key = (title.name.clone(), title.platform.clone());
            if !seen.insert(key) {
                continue;
            }
            output.push(IdentifyTitleMatch {
                name: title.name,
                platform: title.platform,
                algorithm: algorithm.to_string(),
                variant: variant_id.to_string(),
                database: database_name.to_string(),
            });
        }
    }
    Ok(())
}

fn checksum_map(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| {
                    value
                        .as_str()
                        .map(|value| (key.to_ascii_lowercase(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}
