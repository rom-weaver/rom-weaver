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

/// The compact title lookup attached to ingest assets and patch source hints.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct IdentifyLookupResult {
    pub status: IdentifyStatus,
    pub matches: Vec<IdentifyTitleMatch>,
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

/// Parsed identify packs shared by one command invocation. Packs are parsed once, then reused for
/// every ROM asset and patch descriptor produced by that invocation.
pub(super) struct IdentifyDatabaseSet {
    packs: Vec<(String, SystemPack)>,
}

impl IdentifyDatabaseSet {
    pub(super) fn load(databases: &[PathBuf]) -> Result<Option<Self>> {
        if databases.is_empty() {
            #[cfg(target_arch = "wasm32")]
            return Ok(None);
            #[cfg(not(target_arch = "wasm32"))]
            return Self::from_builtin_packs().map(Some);
        }

        let mut packs = Vec::with_capacity(databases.len());
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
            packs.push((database_name, pack));
        }
        Ok(Some(Self { packs }))
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn from_builtin_packs() -> Result<Self> {
        let mut packs = Vec::with_capacity(super::identify_builtin::PACKS.len());
        for &(database_name, bytes) in super::identify_builtin::PACKS {
            trace!(
                database = database_name,
                "loading built-in ROM identify pack"
            );
            packs.push((database_name.to_string(), SystemPack::parse(bytes)?));
        }
        Ok(Self { packs })
    }

    pub(super) fn resolve_variants(&self, variants: &[Value]) -> Result<IdentifyLookupResult> {
        let mut output = Vec::new();
        let mut seen = BTreeSet::new();
        for variant in variants {
            let variant_id = variant.get("id").and_then(Value::as_str).unwrap_or("raw");
            let values = checksum_map(variant.get("checksums"));
            self.resolve_query(
                &IdentifyQuery {
                    crc32: values.get("crc32").map(String::as_str),
                    md5: values.get("md5").map(String::as_str),
                    sha1: values.get("sha1").map(String::as_str),
                },
                variant_id,
                &mut seen,
                &mut output,
            )?;
        }
        Ok(identify_lookup_result(output))
    }

    pub(super) fn resolve_source(
        &self,
        source_crc32: Option<u32>,
        source_checksum_variants: &[BTreeMap<String, String>],
        filename_checksums: &BTreeMap<String, String>,
    ) -> Result<Option<IdentifyLookupResult>> {
        let mut embedded = source_checksum_variants.to_vec();
        if let Some(crc32) = source_crc32 {
            let crc32 = format!("{crc32:08x}");
            if !embedded
                .iter()
                .any(|checksums| checksums.get("crc32") == Some(&crc32))
            {
                embedded.push(BTreeMap::from([(String::from("crc32"), crc32)]));
            }
        }
        if embedded.is_empty() && filename_checksums.is_empty() {
            return Ok(None);
        }
        let mut output = Vec::new();
        let mut seen = BTreeSet::new();
        if !embedded.is_empty() {
            for (index, checksums) in embedded.iter().enumerate() {
                let variant = if index == 0 {
                    "source".to_string()
                } else {
                    format!("source-{}", index + 1)
                };
                self.resolve_query(
                    &IdentifyQuery {
                        crc32: checksums.get("crc32").map(String::as_str),
                        md5: checksums.get("md5").map(String::as_str),
                        sha1: checksums.get("sha1").map(String::as_str),
                    },
                    &variant,
                    &mut seen,
                    &mut output,
                )?;
            }
        } else {
            self.resolve_query(
                &IdentifyQuery {
                    crc32: filename_checksums.get("crc32").map(String::as_str),
                    md5: filename_checksums.get("md5").map(String::as_str),
                    sha1: filename_checksums.get("sha1").map(String::as_str),
                },
                "filename",
                &mut seen,
                &mut output,
            )?;
        }
        Ok(Some(identify_lookup_result(output)))
    }

    fn resolve_query(
        &self,
        query: &IdentifyQuery<'_>,
        variant: &str,
        seen: &mut BTreeSet<(String, String)>,
        output: &mut Vec<IdentifyTitleMatch>,
    ) -> Result<()> {
        for (database_name, pack) in &self.packs {
            let lookup = pack.resolve(query)?;
            trace!(
                database = database_name,
                algorithm = lookup.algorithm.unwrap_or("none"),
                variant,
                match_count = lookup.matches.len(),
                "resolved ROM identify lookup"
            );
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
                    variant: variant.to_string(),
                    database: database_name.clone(),
                });
            }
        }
        Ok(())
    }
}

fn identify_lookup_result(mut matches: Vec<IdentifyTitleMatch>) -> IdentifyLookupResult {
    matches.sort_by(|left, right| {
        (&left.platform, &left.name, &left.variant).cmp(&(
            &right.platform,
            &right.name,
            &right.variant,
        ))
    });
    let status = match matches.len() {
        0 => IdentifyStatus::Unknown,
        1 => IdentifyStatus::Matched,
        _ => IdentifyStatus::Ambiguous,
    };
    IdentifyLookupResult { status, matches }
}

impl CliApp {
    pub(super) fn run_identify(&self, mut args: IdentifyCommand) -> AppRunOutcome {
        if args.input.is_some() == args.hash.is_some() {
            return self.finish(
                "identify",
                OperationReport::failed(
                    OperationFamily::Command,
                    Some("identify".to_string()),
                    "identify",
                    "provide exactly one of --input or --hash",
                    None,
                ),
            );
        }
        let _stdin_guard = match args
            .input
            .as_mut()
            .map(crate::stdin_input::spool_stdin_if_dash)
            .transpose()
        {
            Ok(guard) => guard.flatten(),
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
            source = ?args.input,
            hash = ?args.hash,
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
            hash,
            database,
            select,
            filter,
            no_extract,
            no_ignore,
            no_trim_fix,
            threads,
        } = args;
        let databases = match IdentifyDatabaseSet::load(&database) {
            Ok(Some(databases)) => databases,
            Ok(None) => {
                return self.finish(
                    "identify",
                    OperationReport::failed(
                        OperationFamily::Command,
                        Some("identify".to_string()),
                        "identify",
                        "the browser identify command requires a staged --database pack",
                        None,
                    ),
                );
            }
            Err(error) => {
                return self.finish(
                    "identify",
                    OperationReport::failed(
                        OperationFamily::Command,
                        Some("identify".to_string()),
                        "identify",
                        error.to_string(),
                        None,
                    ),
                );
            }
        };
        if let Some(hash) = hash {
            return self.run_identify_hash(&hash, &databases);
        }
        let input = input.expect("validated: input is Some when hash is None");
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

        let lookup = match databases.resolve_variants(&checksum_variants) {
            Ok(lookup) => lookup,
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
        let label = match lookup.status {
            IdentifyStatus::Matched => format!("identified {}", lookup.matches[0].name),
            IdentifyStatus::Ambiguous => format!("found {} possible titles", lookup.matches.len()),
            IdentifyStatus::Unknown => "no title matched the supplied database".to_string(),
        };
        let result = IdentifyResult {
            status: lookup.status,
            input: input.to_string_lossy().replace('\\', "/"),
            detected_platform,
            checksums,
            checksum_variants,
            matches: lookup.matches,
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

    /// Look a user-supplied checksum up in the identify packs, with no file I/O.
    fn run_identify_hash(&self, hash: &str, databases: &IdentifyDatabaseSet) -> AppRunOutcome {
        let hash = hash.trim().to_ascii_lowercase();
        let algo = match hash.len() {
            _ if !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) => None,
            8 => Some("crc32"),
            32 => Some("md5"),
            40 => Some("sha1"),
            _ => None,
        };
        let Some(algo) = algo else {
            return self.finish(
                "identify",
                OperationReport::failed(
                    OperationFamily::Command,
                    Some("identify".to_string()),
                    "identify",
                    "--hash must be hex: 8 chars for crc32, 32 for md5, or 40 for sha1",
                    None,
                ),
            );
        };
        trace!(
            algorithm = algo,
            hash = %hash,
            "resolving manual identify hash lookup"
        );
        let checksum_variants = vec![json!({
            "id": "manual",
            "label": "Manual",
            "checksums": { algo: hash },
        })];
        let lookup = match databases.resolve_variants(&checksum_variants) {
            Ok(lookup) => lookup,
            Err(error) => {
                return self.finish(
                    "identify",
                    OperationReport::failed(
                        OperationFamily::Command,
                        Some("identify".to_string()),
                        "identify",
                        error.to_string(),
                        None,
                    ),
                );
            }
        };
        let label = match lookup.status {
            IdentifyStatus::Matched => format!("identified {}", lookup.matches[0].name),
            IdentifyStatus::Ambiguous => format!("found {} possible titles", lookup.matches.len()),
            IdentifyStatus::Unknown => "no title matched the supplied database".to_string(),
        };
        let result = IdentifyResult {
            status: lookup.status,
            input: hash.clone(),
            detected_platform: None,
            checksums: BTreeMap::from([(algo.to_string(), hash)]),
            checksum_variants,
            matches: lookup.matches,
        };
        let mut report = OperationReport::succeeded(
            OperationFamily::Command,
            Some("identify".to_string()),
            "identify",
            label,
            Some(100.0),
            None,
        );
        report.details = Some(json!({ "identify": result }));
        self.finish("identify", report)
    }
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
