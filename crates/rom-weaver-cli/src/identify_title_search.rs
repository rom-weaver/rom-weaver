use super::identify_name_search::{NameQuery, SearchScratch};
use super::*;

#[derive(Deserialize)]
struct TitleIndex {
    format: String,
    packs: Vec<String>,
    titles: Vec<(String, Vec<usize>)>,
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
    let query = NameQuery::new(query)?;
    let mut scratch = SearchScratch::default();
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
        if let Some(score) = query.score_title(name, &mut scratch) {
            hits.push((row, score));
        }
    }
    hits.sort_by(|&(left, left_score), &(right, right_score)| {
        right_score
            .cmp(&left_score)
            .then_with(|| index.titles[left].0.cmp(&index.titles[right].0))
    });
    let matched = hits.len();
    hits.truncate(limit.unwrap_or(50) as usize);
    let matches = hits
        .into_iter()
        .map(|(row, score)| {
            let (name, packs) = &index.titles[row];
            IdentifyTitleSearchMatch {
                name: name.clone(),
                slugs: packs
                    .iter()
                    .map(|&pack| index.packs[pack].clone())
                    .collect(),
                score,
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
