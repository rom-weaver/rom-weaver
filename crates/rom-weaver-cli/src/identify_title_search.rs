use super::identify_name_search::{NameQuery, SearchScratch};
use super::*;
use rom_weaver_checksum::identify_catalog::IdentifyCatalog;

#[derive(Deserialize)]
struct TitleIndex {
    format: String,
    packs: Vec<String>,
    #[serde(default)]
    systems: Vec<Vec<String>>,
    titles: Vec<(String, Vec<usize>)>,
}

struct ScoredTitleHit {
    row: usize,
    score: i64,
    packs: Vec<usize>,
}

/// The title index can include canonical platform names and aliases alongside
/// its pack slugs. Older native indexes fall back to the built-in catalog,
/// then to the slug itself when that catalog does not know the pack.
fn system_names(index: &TitleIndex) -> Vec<Vec<String>> {
    if !index.systems.is_empty() {
        return index.systems.clone();
    }
    let catalog = IdentifyCatalog::builtin();
    index
        .packs
        .iter()
        .map(|slug| {
            let Some(entry) = catalog
                .entries()
                .iter()
                .find(|entry| entry.pack_slug == *slug)
            else {
                return vec![slug.replace('-', " ")];
            };
            std::iter::once(entry.canonical_platform.clone())
                .chain(entry.aliases.iter().cloned())
                .collect()
        })
        .collect()
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct IdentifyTitleSearchMatch {
    pub name: String,
    pub slugs: Vec<String>,
    #[cfg_attr(feature = "typescript-types", ts(type = "number"))]
    pub score: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct IdentifyTitleSearchResult {
    pub matches: Vec<IdentifyTitleSearchMatch>,
}

pub(super) fn search_title_index(
    path: &Path,
    query: &str,
    limit: Option<u32>,
) -> Result<OperationReport> {
    if limit == Some(0) {
        return Err(RomWeaverError::Validation(
            "--limit must be at least 1".to_string(),
        ));
    }
    let index: TitleIndex = serde_json::from_slice(&fs::read(path)?)
        .map_err(|error| RomWeaverError::Validation(format!("title index is invalid: {error}")))?;
    if index.format != "rom-weaver-identify-title-index-v1" {
        return Err(RomWeaverError::Validation(format!(
            "title index is invalid: unexpected format {}",
            index.format
        )));
    }
    if index.packs.iter().any(|slug| slug.is_empty()) {
        return Err(RomWeaverError::Validation(
            "title index is invalid: empty pack slug".to_string(),
        ));
    }
    if !index.systems.is_empty()
        && (index.systems.len() != index.packs.len()
            || index
                .systems
                .iter()
                .any(|system| system.is_empty() || system.iter().any(String::is_empty)))
    {
        return Err(RomWeaverError::Validation(
            "title index is invalid: systems must name every pack with non-empty aliases"
                .to_string(),
        ));
    }
    let query = NameQuery::new(query)?;
    let systems = system_names(&index);
    let mut scratch = SearchScratch::default();
    let system_matches = systems
        .iter()
        .map(|system| query.score_systems(system.iter().map(String::as_str), &mut scratch))
        .collect::<Vec<_>>();
    let mut hits = Vec::new();
    for (row, (name, packs)) in index.titles.iter().enumerate() {
        if name.is_empty()
            || packs.is_empty()
            || packs.iter().any(|&pack| pack >= index.packs.len())
        {
            return Err(RomWeaverError::Validation(format!(
                "title index is invalid: title row {row} has an empty name or invalid pack indexes"
            )));
        }
        let mut matching_packs = Vec::new();
        let mut best_score = None;
        let mut best_system_rank = None;
        let mut title_score = None;
        for &pack in packs {
            let Some((score, title_only)) =
                query.score_title_with_system_match(name, &system_matches[pack], &mut scratch)
            else {
                continue;
            };
            if title_only {
                title_score = Some(score);
                break;
            }
            let Some(system_rank) = query.system_match_rank(&system_matches[pack]) else {
                continue;
            };
            match best_system_rank {
                Some(best) if system_rank < best => continue,
                Some(best) if system_rank > best => {
                    matching_packs.clear();
                    best_score = None;
                }
                _ => {}
            }
            best_system_rank = Some(system_rank);
            matching_packs.push(pack);
            best_score = Some(best_score.map_or(score, |best: i64| best.max(score)));
        }
        if let Some(score) = title_score {
            hits.push(ScoredTitleHit {
                row,
                score,
                packs: packs.clone(),
            });
            continue;
        }
        if let Some(score) = best_score {
            hits.push(ScoredTitleHit {
                row,
                score,
                packs: matching_packs,
            });
        }
    }
    hits.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| index.titles[left.row].0.cmp(&index.titles[right.row].0))
    });
    let matched = hits.len();
    hits.truncate(limit.unwrap_or(50) as usize);
    let matches = hits
        .into_iter()
        .map(|hit| {
            let (name, _) = &index.titles[hit.row];
            IdentifyTitleSearchMatch {
                name: name.clone(),
                slugs: hit
                    .packs
                    .iter()
                    .map(|&pack| index.packs[pack].clone())
                    .collect(),
                score: hit.score,
            }
        })
        .collect::<Vec<_>>();
    debug!(
        candidates = index.titles.len(),
        matched,
        returned = matches.len(),
        "title index search finished"
    );
    let mut report = OperationReport::succeeded(
        OperationFamily::Command,
        Some("identify".to_string()),
        "identify",
        format!("found {} matching titles", matches.len()),
        Some(100.0),
        None,
    );
    report.details = Some(json!({ "identifyTitles": IdentifyTitleSearchResult { matches } }));
    Ok(report)
}
