// The verification planner: pure and I/O-free. Callers supply the base ROM's
// variant checksums and everything known about each enabled patch (embedded
// endpoints, filename/bundle/user expectations, declared basis); the planner
// resolves each patch's input basis, diagnoses chain order, and decides which
// output expectations are enforceable. `patch-validate --plan` and the apply
// pipeline share it.

use super::*;

/// What a patch's input checks were authored against: the original ROM
/// (`base` - verified once up front) or the previous enabled patch's output
/// (`previous` - today's chain semantics, the default).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum PatchInputBasis {
    Base,
    Previous,
}

/// Per-patch basis argument on the CLI/wasm surface: `auto` defers to
/// checksum inference.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[cfg_attr(not(target_arch = "wasm32"), derive(ValueEnum))]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "kebab-case")]
pub enum PatchBasisMode {
    #[default]
    Auto,
    Base,
    Previous,
}

impl PatchBasisMode {
    pub(crate) fn declared(self) -> Option<PatchInputBasis> {
        match self {
            Self::Auto => None,
            Self::Base => Some(PatchInputBasis::Base),
            Self::Previous => Some(PatchInputBasis::Previous),
        }
    }
}

/// How a patch's basis was decided.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum PatchBasisSource {
    Declared,
    InferredBase,
    InferredChain,
    Default,
}

/// What a patch's input checks matched.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PatchInputMatch {
    /// A base ROM variant (`raw`, `headerless`, later `track:<name>`).
    Base {
        variant: String,
    },
    /// Another patch's known output (position in the enabled chain).
    PatchOutput {
        index: u32,
    },
    None,
}

/// Static input verdict. `ChainDeferred` means the state is only provable by
/// applying the chain (mid-chain previous-basis patches) - it replaces the
/// false "invalid" such patches earn from independent dry-runs today.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum PatchInputVerdict {
    Passed,
    Failed,
    ChainDeferred,
    Unknown,
}

/// One patch's resolved plan entry. `index` / `expected_predecessor` are
/// 0-based positions in the enabled chain that was planned.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct PatchPlanVerdict {
    pub index: u32,
    pub patch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub format: Option<String>,
    pub basis: PatchInputBasis,
    pub basis_source: PatchBasisSource,
    pub matched: PatchInputMatch,
    pub input_verdict: PatchInputVerdict,
    pub message: String,
    /// Set when this patch's input matches a patch it does not directly
    /// follow - the order diagnosis behind `suggested_order`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub expected_predecessor: Option<u32>,
}

/// One output expectation and whether the current selection/order can
/// enforce it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct OutputEnforceableEntry {
    pub patch_index: u32,
    pub source: String,
    pub checks: BundleChecks,
    pub enforceable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub standdown_reason: Option<String>,
}

/// The typed `details.patch_validation` payload of `patch-validate --plan`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct PatchValidationPlan {
    pub plan: bool,
    pub per_patch: Vec<PatchPlanVerdict>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub suggested_order: Option<Vec<u32>>,
    pub output_verification: Vec<OutputEnforceableEntry>,
    pub status: String,
    pub patch_count: u32,
    pub passed_count: u32,
    pub failed_count: u32,
    pub formats: Vec<String>,
}

/// One candidate whole-file state: checksums (algorithm -> lowercase hex)
/// plus an optional exact byte size.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct PlanState {
    pub checksums: BTreeMap<String, String>,
    pub size: Option<u64>,
}

impl PlanState {
    pub(crate) fn from_bundle_checks(checks: &BundleChecks) -> Self {
        Self {
            checksums: checks.checksums.clone(),
            size: checks.size,
        }
    }

    pub(crate) fn has_checksum_evidence(&self) -> bool {
        !self.checksums.is_empty()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.checksums.is_empty() && self.size.is_none()
    }

    pub(crate) fn to_bundle_checks(&self) -> BundleChecks {
        BundleChecks {
            checksums: self.checksums.clone(),
            size: self.size,
        }
    }
}

/// Everything known about one enabled patch, in apply order.
#[derive(Clone, Debug, Default)]
pub(crate) struct PlanPatchInput {
    pub name: String,
    pub format: Option<String>,
    pub declared_basis: Option<PatchInputBasis>,
    /// Merged filename/bundle/user expectations for the input state.
    pub declared_input: PlanState,
    /// Declared expectations for the state after this patch.
    pub declared_output: PlanState,
    /// Embedded whole-file endpoint variants `(input, output)` from the
    /// patch file itself (RUP carries several).
    pub embedded: Vec<(PlanState, PlanState)>,
}

impl PlanPatchInput {
    fn input_candidates(&self) -> Vec<&PlanState> {
        let mut candidates = Vec::new();
        if !self.declared_input.is_empty() {
            candidates.push(&self.declared_input);
        }
        candidates.extend(self.embedded.iter().map(|(input, _)| input));
        candidates
    }

    fn output_candidates(&self) -> Vec<&PlanState> {
        let mut candidates = Vec::new();
        if !self.declared_output.is_empty() {
            candidates.push(&self.declared_output);
        }
        candidates.extend(self.embedded.iter().map(|(_, output)| output));
        candidates
    }

    fn has_input_evidence(&self) -> bool {
        self.input_candidates()
            .iter()
            .any(|state| state.has_checksum_evidence())
    }
}

/// One base ROM variant with its computed checksums.
#[derive(Clone, Debug)]
pub(crate) struct BaseVariant {
    pub name: String,
    pub state: PlanState,
}

/// Per-step verification spec threaded into the apply chain loop. An empty
/// slice (or all-default entries) reproduces today's behavior exactly.
#[derive(Clone, Debug, Default)]
pub(crate) struct PatchStepVerification {
    /// Resolved basis for this step; `None` behaves as previous (default).
    pub basis: Option<PatchInputBasis>,
    /// Where the basis came from (labels/tracing only).
    pub basis_source: Option<PatchBasisSource>,
    /// Declared (bundle/CLI) checks for the state this step consumes,
    /// verified against the real intermediate before the step runs (strict
    /// mode, previous basis, mid-chain).
    pub declared_input: Option<PlanState>,
    /// Declared checks for the state after this step, verified against the
    /// real intermediate when the step ends an exact chain prefix (strict
    /// mode, not the final step - the final output keeps its own gate).
    pub declared_output: Option<PlanState>,
    /// Whether the selection up to and including this step is exactly the
    /// bundle's chain prefix ending here.
    pub is_chain_prefix: bool,
}

/// The planner's resolution before dry-run results are merged in.
#[derive(Clone, Debug)]
pub(crate) struct ResolvedPlan {
    pub per_patch: Vec<PatchPlanVerdict>,
    pub suggested_order: Option<Vec<u32>>,
    pub output_verification: Vec<OutputEnforceableEntry>,
}

/// Parse a parse/describe report's normalized `details.patch.endpoints`
/// into planner states, one `(input, output)` pair per variant.
pub(crate) fn parse_endpoint_variants(details: Option<&Value>) -> Vec<(PlanState, PlanState)> {
    let Some(endpoints) = details
        .and_then(|value| value.get("patch"))
        .and_then(|patch| patch.get("endpoints"))
        .and_then(|endpoints| endpoints.as_array())
    else {
        return Vec::new();
    };
    endpoints
        .iter()
        .map(|variant| {
            (
                parse_endpoint_side(variant.get("input")),
                parse_endpoint_side(variant.get("output")),
            )
        })
        .collect()
}

fn parse_endpoint_side(side: Option<&Value>) -> PlanState {
    let mut state = PlanState::default();
    let Some(side) = side else {
        return state;
    };
    if let Some(checksums) = side.get("checksums").and_then(Value::as_object) {
        for (algorithm, hex) in checksums {
            if let Some(hex) = hex.as_str() {
                state
                    .checksums
                    .insert(algorithm.clone(), hex.to_ascii_lowercase());
            }
        }
    }
    state.size = side.get("size").and_then(Value::as_u64);
    state
}

/// How two states compare under shared-evidence matching.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EvidenceMatch {
    /// At least one checksum algorithm both sides pin agrees, none
    /// disagrees, and sizes agree when both are pinned.
    Match,
    /// A shared algorithm (or both-pinned size) disagrees.
    Conflict,
    /// No shared checksum algorithm. Size-only agreement is still disjoint:
    /// size alone is never evidence. (`bundle_checks_agree`, by contrast,
    /// lets disjoint declarations "agree" - unusable for inference.)
    Disjoint,
}

pub(crate) fn compare_states(expected: &PlanState, state: &PlanState) -> EvidenceMatch {
    let mut shared = 0usize;
    for (algorithm, hex) in &expected.checksums {
        if let Some(other) = state.checksums.get(algorithm) {
            if !other.eq_ignore_ascii_case(hex) {
                return EvidenceMatch::Conflict;
            }
            shared += 1;
        }
    }
    if let (Some(left), Some(right)) = (expected.size, state.size)
        && left != right
    {
        return EvidenceMatch::Conflict;
    }
    if shared == 0 {
        return EvidenceMatch::Disjoint;
    }
    EvidenceMatch::Match
}

/// The best comparison of any of `candidates` against `state`:
/// Match > Conflict > Disjoint (a Match on any candidate wins; a Conflict is
/// only reported when nothing matches but something was comparable).
fn compare_candidates(candidates: &[&PlanState], state: &PlanState) -> EvidenceMatch {
    let mut best = EvidenceMatch::Disjoint;
    for candidate in candidates {
        match compare_states(candidate, state) {
            EvidenceMatch::Match => return EvidenceMatch::Match,
            EvidenceMatch::Conflict => best = EvidenceMatch::Conflict,
            EvidenceMatch::Disjoint => {}
        }
    }
    best
}

/// First base variant the patch's input matches, else whether any variant
/// was comparable-and-conflicting.
fn match_base(patch: &PlanPatchInput, base_variants: &[BaseVariant]) -> (Option<usize>, bool) {
    let candidates = patch.input_candidates();
    let mut conflicted = false;
    for (index, variant) in base_variants.iter().enumerate() {
        match compare_candidates(&candidates, &variant.state) {
            EvidenceMatch::Match => return (Some(index), false),
            EvidenceMatch::Conflict => conflicted = true,
            EvidenceMatch::Disjoint => {}
        }
    }
    (None, conflicted)
}

/// Compare patch `i`'s input against patch `j`'s known outputs.
fn match_patch_output(patch: &PlanPatchInput, predecessor: &PlanPatchInput) -> EvidenceMatch {
    let candidates = patch.input_candidates();
    let mut best = EvidenceMatch::Disjoint;
    for output in predecessor.output_candidates() {
        match compare_candidates(&candidates, output) {
            EvidenceMatch::Match => return EvidenceMatch::Match,
            EvidenceMatch::Conflict => best = EvidenceMatch::Conflict,
            EvidenceMatch::Disjoint => {}
        }
    }
    best
}

/// 1-based position label used in human-readable messages.
fn position_label(index: usize) -> String {
    format!("patch {}", index + 1)
}

/// Resolve the verification plan for one enabled chain, in apply order.
/// Verdicts are static: the command layer overrides `Passed`/`Unknown`
/// entries with dry-run outcomes where it runs them.
pub(crate) fn resolve_verification_plan(
    base_variants: &[BaseVariant],
    patches: &[PlanPatchInput],
) -> ResolvedPlan {
    let mut per_patch: Vec<PatchPlanVerdict> = Vec::with_capacity(patches.len());

    for (index, patch) in patches.iter().enumerate() {
        let (base_match, base_conflict) = match_base(patch, base_variants);
        let previous_link = if index > 0 {
            match_patch_output(patch, &patches[index - 1])
        } else {
            EvidenceMatch::Disjoint
        };
        // A non-adjacent patch whose known output matches this input - the
        // order diagnosis. The immediate predecessor is checked separately.
        let other_match = patches.iter().enumerate().find_map(|(j, other)| {
            let adjacent = index > 0 && j == index - 1;
            if j == index || adjacent {
                return None;
            }
            (match_patch_output(patch, other) == EvidenceMatch::Match).then_some(j)
        });

        let mut expected_predecessor = None;
        let verdict = if index == 0 {
            // The first enabled patch always consumes the base.
            let basis_source = match patch.declared_basis {
                Some(_) => PatchBasisSource::Declared,
                None if base_match.is_some() => PatchBasisSource::InferredBase,
                None => PatchBasisSource::Default,
            };
            let (matched, input_verdict, message) = match (base_match, base_conflict) {
                (Some(variant), _) => (
                    PatchInputMatch::Base {
                        variant: base_variants[variant].name.clone(),
                    },
                    PatchInputVerdict::Passed,
                    format!("input matches the ROM ({})", base_variants[variant].name),
                ),
                (None, true) => (
                    PatchInputMatch::None,
                    PatchInputVerdict::Failed,
                    "input checks do not match the ROM".to_string(),
                ),
                (None, false) => (
                    PatchInputMatch::None,
                    PatchInputVerdict::Unknown,
                    if patch.has_input_evidence() {
                        "input checks share no algorithm with the computed ROM checksums"
                            .to_string()
                    } else {
                        "no whole-file input checks to verify".to_string()
                    },
                ),
            };
            PatchPlanVerdict {
                index: index as u32,
                patch: patch.name.clone(),
                format: patch.format.clone(),
                basis: PatchInputBasis::Base,
                basis_source,
                matched,
                input_verdict,
                message,
                expected_predecessor: None,
            }
        } else {
            // Basis precedence: declaration > immediately-previous match >
            // base-variant match > non-adjacent match > default previous.
            let (basis, basis_source) = match patch.declared_basis {
                Some(basis) => (basis, PatchBasisSource::Declared),
                None if previous_link == EvidenceMatch::Match => {
                    (PatchInputBasis::Previous, PatchBasisSource::InferredChain)
                }
                None if base_match.is_some() => {
                    (PatchInputBasis::Base, PatchBasisSource::InferredBase)
                }
                None if other_match.is_some() => {
                    (PatchInputBasis::Previous, PatchBasisSource::InferredChain)
                }
                None => (PatchInputBasis::Previous, PatchBasisSource::Default),
            };

            let (matched, input_verdict, message) = match basis {
                PatchInputBasis::Base => match (base_match, base_conflict) {
                    (Some(variant), _) => (
                        PatchInputMatch::Base {
                            variant: base_variants[variant].name.clone(),
                        },
                        PatchInputVerdict::Passed,
                        format!(
                            "input matches the ROM ({}); embedded checks are skipped mid-chain",
                            base_variants[variant].name
                        ),
                    ),
                    (None, true) => (
                        PatchInputMatch::None,
                        PatchInputVerdict::Failed,
                        "declared against the base ROM but input checks do not match it"
                            .to_string(),
                    ),
                    (None, false) => (
                        PatchInputMatch::None,
                        PatchInputVerdict::Unknown,
                        "declared against the base ROM; no comparable input checks".to_string(),
                    ),
                },
                PatchInputBasis::Previous => match previous_link {
                    EvidenceMatch::Match => (
                        PatchInputMatch::PatchOutput {
                            index: (index - 1) as u32,
                        },
                        PatchInputVerdict::ChainDeferred,
                        format!(
                            "input matches {}'s declared output",
                            position_label(index - 1)
                        ),
                    ),
                    EvidenceMatch::Conflict | EvidenceMatch::Disjoint => {
                        if let Some(j) = other_match {
                            expected_predecessor = Some(j as u32);
                            (
                                PatchInputMatch::PatchOutput { index: j as u32 },
                                PatchInputVerdict::ChainDeferred,
                                format!(
                                    "expects {}'s output but does not follow it",
                                    position_label(j)
                                ),
                            )
                        } else if previous_link == EvidenceMatch::Conflict
                            && base_conflict
                            && patch.has_input_evidence()
                        {
                            (
                                PatchInputMatch::None,
                                PatchInputVerdict::Failed,
                                "input checks match neither the ROM nor another patch's output"
                                    .to_string(),
                            )
                        } else if previous_link == EvidenceMatch::Conflict {
                            (
                                PatchInputMatch::None,
                                PatchInputVerdict::ChainDeferred,
                                "input checks disagree with the previous patch's declared output"
                                    .to_string(),
                            )
                        } else {
                            (
                                PatchInputMatch::None,
                                PatchInputVerdict::ChainDeferred,
                                "input state is only provable during apply".to_string(),
                            )
                        }
                    }
                },
            };
            PatchPlanVerdict {
                index: index as u32,
                patch: patch.name.clone(),
                format: patch.format.clone(),
                basis,
                basis_source,
                matched,
                input_verdict,
                message,
                expected_predecessor,
            }
        };
        per_patch.push(verdict);
    }

    let suggested_order = suggest_order(&per_patch);
    let output_verification = resolve_output_verification(patches, &per_patch);

    ResolvedPlan {
        per_patch,
        suggested_order,
        output_verification,
    }
}

/// Minimal-disturbance reorder: each diagnosed patch moves to directly after
/// its expected predecessor, in list order. `None` when nothing was
/// diagnosed or the moves change nothing.
fn suggest_order(per_patch: &[PatchPlanVerdict]) -> Option<Vec<u32>> {
    if per_patch
        .iter()
        .all(|verdict| verdict.expected_predecessor.is_none())
    {
        return None;
    }
    let mut order: Vec<u32> = (0..per_patch.len() as u32).collect();
    for verdict in per_patch {
        let Some(predecessor) = verdict.expected_predecessor else {
            continue;
        };
        let from = order
            .iter()
            .position(|&index| index == verdict.index)
            .expect("planned index present");
        let moved = order.remove(from);
        let after = order
            .iter()
            .position(|&index| index == predecessor)
            .expect("predecessor index present");
        order.insert(after + 1, moved);
    }
    let identity: Vec<u32> = (0..per_patch.len() as u32).collect();
    (order != identity).then_some(order)
}

/// Whether every link up to and including `index` is intact: no order
/// diagnosis, no failed input, and no previous-basis link that conflicts.
fn links_intact_through(per_patch: &[PatchPlanVerdict], index: usize) -> bool {
    per_patch.iter().take(index + 1).all(|verdict| {
        verdict.expected_predecessor.is_none() && verdict.input_verdict != PatchInputVerdict::Failed
    })
}

fn resolve_output_verification(
    patches: &[PlanPatchInput],
    per_patch: &[PatchPlanVerdict],
) -> Vec<OutputEnforceableEntry> {
    let mut entries = Vec::new();

    for (index, patch) in patches.iter().enumerate() {
        if patch.declared_output.is_empty() {
            continue;
        }
        let intact = links_intact_through(per_patch, index);
        entries.push(OutputEnforceableEntry {
            patch_index: index as u32,
            source: "declared output checks".to_string(),
            checks: patch.declared_output.to_bundle_checks(),
            enforceable: intact,
            standdown_reason: (!intact).then(|| {
                "an upstream patch is out of order or failed its input checks".to_string()
            }),
        });
    }

    // The last patch's embedded target describes patch(basis) - it verifies
    // the final output only when every upstream step consumed exactly the
    // state its author produced: a single patch, or an unbroken chain of
    // statically-matching previous-basis links.
    if let Some((last_index, last)) = patches.iter().enumerate().next_back() {
        let embedded_output = match last.embedded.len() {
            1 => Some(&last.embedded[0].1),
            _ => None,
        };
        if let Some(output) = embedded_output.filter(|output| !output.is_empty()) {
            let chain_exact = patches.len() == 1
                || per_patch.iter().skip(1).all(|verdict| {
                    verdict.basis == PatchInputBasis::Previous
                        && matches!(verdict.matched, PatchInputMatch::PatchOutput { .. })
                        && verdict.expected_predecessor.is_none()
                });
            let head_ok = per_patch
                .first()
                .is_some_and(|verdict| verdict.input_verdict != PatchInputVerdict::Failed);
            let enforceable = chain_exact && head_ok;
            let standdown_reason = if enforceable {
                None
            } else if per_patch
                .iter()
                .any(|verdict| verdict.basis == PatchInputBasis::Base && verdict.index > 0)
            {
                Some(
                    "a mid-chain patch was authored against the base ROM; the embedded output describes a different derivation"
                        .to_string(),
                )
            } else {
                Some("the chain is not statically proven link by link".to_string())
            };
            entries.push(OutputEnforceableEntry {
                patch_index: last_index as u32,
                source: "embedded target checks".to_string(),
                checks: output.to_bundle_checks(),
                enforceable,
                standdown_reason,
            });
        }
    }

    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(pairs: &[(&str, &str)], size: Option<u64>) -> PlanState {
        PlanState {
            checksums: pairs
                .iter()
                .map(|(algorithm, hex)| (algorithm.to_string(), hex.to_string()))
                .collect(),
            size,
        }
    }

    type BaseSpec<'a> = (&'a str, &'a [(&'a str, &'a str)], Option<u64>);

    fn base(variants: &[BaseSpec<'_>]) -> Vec<BaseVariant> {
        variants
            .iter()
            .map(|(name, pairs, size)| BaseVariant {
                name: name.to_string(),
                state: state(pairs, *size),
            })
            .collect()
    }

    fn patch(name: &str) -> PlanPatchInput {
        PlanPatchInput {
            name: name.to_string(),
            ..PlanPatchInput::default()
        }
    }

    fn embedded(input: PlanState, output: PlanState) -> Vec<(PlanState, PlanState)> {
        vec![(input, output)]
    }

    const BASE_CRC: &str = "11111111";
    const MID_CRC: &str = "22222222";
    const OUT_CRC: &str = "33333333";
    const HEADERLESS_CRC: &str = "aaaaaaaa";
    const OTHER_CRC: &str = "99999999";

    fn raw_base() -> Vec<BaseVariant> {
        base(&[("raw", &[("crc32", BASE_CRC)], Some(1024))])
    }

    #[test]
    fn same_base_multi_patch_all_resolve_to_base() {
        let mut a = patch("a.bps");
        a.embedded = embedded(
            state(&[("crc32", BASE_CRC)], Some(1024)),
            state(&[("crc32", MID_CRC)], Some(1024)),
        );
        let mut b = patch("b.bps");
        b.embedded = embedded(
            state(&[("crc32", BASE_CRC)], Some(1024)),
            state(&[("crc32", OUT_CRC)], Some(1024)),
        );

        let plan = resolve_verification_plan(&raw_base(), &[a, b]);

        assert_eq!(plan.per_patch[0].basis, PatchInputBasis::Base);
        assert_eq!(plan.per_patch[0].input_verdict, PatchInputVerdict::Passed);
        assert_eq!(plan.per_patch[1].basis, PatchInputBasis::Base);
        assert_eq!(
            plan.per_patch[1].basis_source,
            PatchBasisSource::InferredBase
        );
        assert_eq!(plan.per_patch[1].input_verdict, PatchInputVerdict::Passed);
        assert!(plan.suggested_order.is_none());
    }

    #[test]
    fn true_chain_resolves_to_previous_links() {
        let mut a = patch("a.bps");
        a.embedded = embedded(
            state(&[("crc32", BASE_CRC)], None),
            state(&[("crc32", MID_CRC)], None),
        );
        let mut b = patch("b.bps");
        b.embedded = embedded(
            state(&[("crc32", MID_CRC)], None),
            state(&[("crc32", OUT_CRC)], None),
        );

        let plan = resolve_verification_plan(&raw_base(), &[a, b]);

        assert_eq!(plan.per_patch[1].basis, PatchInputBasis::Previous);
        assert_eq!(
            plan.per_patch[1].basis_source,
            PatchBasisSource::InferredChain
        );
        assert_eq!(
            plan.per_patch[1].matched,
            PatchInputMatch::PatchOutput { index: 0 }
        );
        assert_eq!(
            plan.per_patch[1].input_verdict,
            PatchInputVerdict::ChainDeferred
        );
        assert!(plan.suggested_order.is_none());
    }

    #[test]
    fn out_of_order_chain_diagnoses_predecessor_and_suggests_order() {
        // b expects a's output but is listed first: [b, a] should become [a, b].
        let mut a = patch("a.bps");
        a.embedded = embedded(
            state(&[("crc32", BASE_CRC)], None),
            state(&[("crc32", MID_CRC)], None),
        );
        let mut b = patch("b.bps");
        b.embedded = embedded(
            state(&[("crc32", MID_CRC)], None),
            state(&[("crc32", OUT_CRC)], None),
        );

        let plan = resolve_verification_plan(&raw_base(), &[b, a]);

        // Position 0 is b: its checks conflict with the base.
        assert_eq!(plan.per_patch[0].input_verdict, PatchInputVerdict::Failed);
        // Position 1 is a: matches the base, not b's output.
        assert_eq!(plan.per_patch[1].basis, PatchInputBasis::Base);

        // The reverse diagnosis comes from b matching a's output only after
        // a runs - model it from b's side by planning [b, a] where b's input
        // matches a's (later) output.
        assert_eq!(plan.per_patch[0].expected_predecessor, None);

        // Re-plan with declared bases absent and a's output known: b at
        // index 0 cannot reference a later patch from position 0 (it is the
        // chain head), so the diagnosis lands when b sits mid-chain.
        let mut c = patch("c.ips");
        c.declared_input = state(&[("crc32", BASE_CRC)], None);
        let mut a2 = patch("a.bps");
        a2.embedded = embedded(
            state(&[("crc32", BASE_CRC)], None),
            state(&[("crc32", MID_CRC)], None),
        );
        let mut b2 = patch("b.bps");
        b2.embedded = embedded(
            state(&[("crc32", MID_CRC)], None),
            state(&[("crc32", OUT_CRC)], None),
        );
        let plan = resolve_verification_plan(&raw_base(), &[c, b2, a2]);
        assert_eq!(plan.per_patch[1].expected_predecessor, Some(2));
        assert_eq!(plan.suggested_order, Some(vec![0, 2, 1]));
    }

    #[test]
    fn base_and_chain_tie_prefers_previous() {
        // a's output happens to equal the base (a no-op patch): b matches
        // both the base and a's output - previous wins.
        let mut a = patch("a.bps");
        a.embedded = embedded(
            state(&[("crc32", BASE_CRC)], None),
            state(&[("crc32", BASE_CRC)], None),
        );
        let mut b = patch("b.bps");
        b.embedded = embedded(
            state(&[("crc32", BASE_CRC)], None),
            state(&[("crc32", OUT_CRC)], None),
        );

        let plan = resolve_verification_plan(&raw_base(), &[a, b]);

        assert_eq!(plan.per_patch[1].basis, PatchInputBasis::Previous);
        assert_eq!(
            plan.per_patch[1].basis_source,
            PatchBasisSource::InferredChain
        );
    }

    #[test]
    fn declared_basis_wins_over_inference() {
        let mut a = patch("a.bps");
        a.embedded = embedded(
            state(&[("crc32", BASE_CRC)], None),
            state(&[("crc32", MID_CRC)], None),
        );
        // b's checks match a's output, but the author declared base.
        let mut b = patch("b.ips");
        b.declared_basis = Some(PatchInputBasis::Base);
        b.declared_input = state(&[("crc32", MID_CRC)], None);

        let plan = resolve_verification_plan(&raw_base(), &[a, b]);

        assert_eq!(plan.per_patch[1].basis, PatchInputBasis::Base);
        assert_eq!(plan.per_patch[1].basis_source, PatchBasisSource::Declared);
        assert_eq!(plan.per_patch[1].input_verdict, PatchInputVerdict::Failed);
    }

    #[test]
    fn checksumless_ips_defaults_to_previous_deferred() {
        let a = patch("a.ips");
        let b = patch("b.ips");

        let plan = resolve_verification_plan(&raw_base(), &[a, b]);

        assert_eq!(plan.per_patch[0].input_verdict, PatchInputVerdict::Unknown);
        assert_eq!(plan.per_patch[1].basis, PatchInputBasis::Previous);
        assert_eq!(plan.per_patch[1].basis_source, PatchBasisSource::Default);
        assert_eq!(
            plan.per_patch[1].input_verdict,
            PatchInputVerdict::ChainDeferred
        );
    }

    #[test]
    fn disjoint_checks_never_match() {
        // md5-only patch expectations vs crc32-only base: disjoint, Unknown.
        let mut a = patch("a.rup");
        a.embedded = embedded(
            state(&[("md5", "d41d8cd98f00b204e9800998ecf8427e")], None),
            PlanState::default(),
        );

        let plan = resolve_verification_plan(&raw_base(), &[a]);

        assert_eq!(plan.per_patch[0].input_verdict, PatchInputVerdict::Unknown);
        assert_eq!(plan.per_patch[0].matched, PatchInputMatch::None);
    }

    #[test]
    fn size_only_agreement_is_not_evidence() {
        let mut a = patch("a.dps");
        a.embedded = embedded(state(&[], Some(1024)), state(&[], Some(2048)));

        let plan = resolve_verification_plan(&raw_base(), &[a]);

        assert_eq!(plan.per_patch[0].input_verdict, PatchInputVerdict::Unknown);
        assert_eq!(plan.per_patch[0].matched, PatchInputMatch::None);
    }

    #[test]
    fn size_conflict_is_a_conflict() {
        let mut a = patch("a.bps");
        a.embedded = embedded(
            state(&[("crc32", BASE_CRC)], Some(4096)),
            PlanState::default(),
        );

        let plan = resolve_verification_plan(&raw_base(), &[a]);

        assert_eq!(plan.per_patch[0].input_verdict, PatchInputVerdict::Failed);
    }

    #[test]
    fn headerless_variant_matches_by_name() {
        let variants = base(&[
            ("raw", &[("crc32", BASE_CRC)], Some(1024)),
            ("headerless", &[("crc32", HEADERLESS_CRC)], Some(512)),
        ]);
        let mut a = patch("a.bps");
        a.embedded = embedded(
            state(&[("crc32", HEADERLESS_CRC)], Some(512)),
            PlanState::default(),
        );

        let plan = resolve_verification_plan(&variants, &[a]);

        assert_eq!(
            plan.per_patch[0].matched,
            PatchInputMatch::Base {
                variant: "headerless".to_string()
            }
        );
    }

    #[test]
    fn mismatching_everything_fails() {
        let mut a = patch("a.bps");
        a.embedded = embedded(
            state(&[("crc32", BASE_CRC)], None),
            state(&[("crc32", MID_CRC)], None),
        );
        let mut b = patch("b.bps");
        b.embedded = embedded(
            state(&[("crc32", OTHER_CRC)], None),
            state(&[("crc32", OUT_CRC)], None),
        );

        let plan = resolve_verification_plan(&raw_base(), &[a, b]);

        assert_eq!(plan.per_patch[1].input_verdict, PatchInputVerdict::Failed);
        assert_eq!(plan.per_patch[1].matched, PatchInputMatch::None);
    }

    #[test]
    fn declared_output_not_enforceable_past_order_break() {
        let mut head = patch("head.ips");
        head.declared_input = state(&[("crc32", BASE_CRC)], None);
        let mut a = patch("a.bps");
        a.embedded = embedded(
            state(&[("crc32", BASE_CRC)], None),
            state(&[("crc32", MID_CRC)], None),
        );
        let mut b = patch("b.bps");
        b.embedded = embedded(
            state(&[("crc32", MID_CRC)], None),
            state(&[("crc32", OUT_CRC)], None),
        );
        b.declared_output = state(&[("crc32", OUT_CRC)], None);

        // In-order chain: enforceable.
        let plan = resolve_verification_plan(&raw_base(), &[head.clone(), a.clone(), b.clone()]);
        let entry = plan
            .output_verification
            .iter()
            .find(|entry| entry.source == "declared output checks")
            .expect("declared entry");
        assert!(entry.enforceable);

        // Swap a and b: order diagnosis breaks enforceability.
        let plan = resolve_verification_plan(&raw_base(), &[head, b, a]);
        let entry = plan
            .output_verification
            .iter()
            .find(|entry| entry.source == "declared output checks")
            .expect("declared entry");
        assert!(!entry.enforceable);
    }

    #[test]
    fn embedded_target_enforceable_only_on_exact_previous_chain() {
        // Single patch: enforceable.
        let mut solo = patch("solo.bps");
        solo.embedded = embedded(
            state(&[("crc32", BASE_CRC)], None),
            state(&[("crc32", OUT_CRC)], None),
        );
        let plan = resolve_verification_plan(&raw_base(), &[solo]);
        let entry = plan
            .output_verification
            .iter()
            .find(|entry| entry.source == "embedded target checks")
            .expect("embedded entry");
        assert!(entry.enforceable);

        // Base-basis stack: the last patch's embedded target describes
        // patch(base), not the combined result.
        let mut a = patch("a.bps");
        a.embedded = embedded(
            state(&[("crc32", BASE_CRC)], None),
            state(&[("crc32", MID_CRC)], None),
        );
        let mut b = patch("b.bps");
        b.embedded = embedded(
            state(&[("crc32", BASE_CRC)], None),
            state(&[("crc32", OUT_CRC)], None),
        );
        let plan = resolve_verification_plan(&raw_base(), &[a.clone(), b]);
        let entry = plan
            .output_verification
            .iter()
            .find(|entry| entry.source == "embedded target checks")
            .expect("embedded entry");
        assert!(!entry.enforceable);

        // Exact previous-basis chain: enforceable.
        let mut c = patch("c.bps");
        c.embedded = embedded(
            state(&[("crc32", MID_CRC)], None),
            state(&[("crc32", OUT_CRC)], None),
        );
        let plan = resolve_verification_plan(&raw_base(), &[a, c]);
        let entry = plan
            .output_verification
            .iter()
            .find(|entry| entry.source == "embedded target checks")
            .expect("embedded entry");
        assert!(entry.enforceable);
    }

    #[test]
    fn conflicting_declared_and_embedded_input_stay_separate_candidates() {
        // Filename token says one thing, the embedded footer another: either
        // matching the base counts as a base match (candidates, not a merge).
        let mut a = patch("a [crc32:11111111].bps");
        a.declared_input = state(&[("crc32", BASE_CRC)], None);
        a.embedded = embedded(state(&[("crc32", OTHER_CRC)], None), PlanState::default());

        let plan = resolve_verification_plan(&raw_base(), &[a]);

        assert_eq!(plan.per_patch[0].input_verdict, PatchInputVerdict::Passed);
    }
}
