// The verification planner: pure and I/O-free. Callers supply the base ROM's
// variant checksums and everything known about each enabled patch (embedded
// endpoints, filename/bundle/user expectations, declared basis); the planner
// resolves each patch's input basis, diagnoses chain order, and decides which
// output expectations are enforceable. `patch-validate --plan` and the apply
// pipeline share it.

use super::*;

/// What a patch's input checks were authored against: the original ROM
/// (`base`) or the previous enabled patch's output (`previous`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum PatchInputBasis {
    Base,
    Previous,
}

/// Input rule on the CLI/wasm surface. `auto` defers to checksum inference.
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
    /// Exact reversible endpoint selected from embedded patch metadata. Apply
    /// uses it when a base-authored mid-chain patch cannot infer direction
    /// from the running intermediate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub execution: Option<PatchEndpointSelection>,
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
    /// Whether a matching declaration may independently infer base basis.
    /// Bundle `inputChecks` without an explicit basis are mid-chain gates: they
    /// constrain base inference but do not opt a checksumless patch into it.
    pub declared_input_infers_base: bool,
    /// Declared expectations for the state after this patch.
    pub declared_output: PlanState,
    /// Embedded whole-file endpoint variants `(input, output)` from the
    /// patch file itself (RUP carries several).
    pub embedded: Vec<PlanEndpointVariant>,
    /// Endpoints proven against the base through handler-specific input
    /// normalization. An empty list means no match, one entry selects the exact
    /// execution, and multiple entries preserve the format's ambiguity.
    pub base_executions: Vec<PatchEndpointSelection>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct PlanEndpointVariant {
    pub input: PlanState,
    pub output: PlanState,
    pub execution: Option<PatchEndpointSelection>,
}

impl PlanPatchInput {
    pub(crate) fn has_forward_base_execution(&self) -> bool {
        self.base_executions
            .iter()
            .any(|selection| selection.direction == rom_weaver_core::PatchApplyDirection::Forward)
    }

    pub(crate) fn has_only_reverse_base_executions(&self) -> bool {
        !self.base_executions.is_empty() && !self.has_forward_base_execution()
    }

    fn input_candidates(&self) -> Vec<&PlanState> {
        let mut candidates = Vec::new();
        if !self.declared_input.is_empty() {
            candidates.push(&self.declared_input);
        }
        candidates.extend(self.embedded.iter().map(|variant| &variant.input));
        candidates
    }

    fn base_input_candidates(&self, allow_reverse: bool) -> Vec<&PlanState> {
        let mut candidates = Vec::new();
        if !self.declared_input.is_empty()
            && (self.declared_basis == Some(PatchInputBasis::Base)
                || self.declared_input_infers_base)
        {
            candidates.push(&self.declared_input);
        }
        candidates.extend(self.embedded_base_input_candidates(allow_reverse));
        candidates
    }

    fn embedded_base_input_candidates(&self, allow_reverse: bool) -> Vec<&PlanState> {
        self.embedded
            .iter()
            .filter(|variant| {
                allow_reverse
                    || variant.execution.is_none_or(|selection| {
                        selection.direction == rom_weaver_core::PatchApplyDirection::Forward
                    })
            })
            .map(|variant| &variant.input)
            .collect()
    }

    fn output_candidates(&self, execution: Option<PatchEndpointSelection>) -> Vec<&PlanState> {
        let mut candidates = Vec::new();
        if !self.declared_output.is_empty() {
            candidates.push(&self.declared_output);
        }
        candidates.extend(
            self.embedded
                .iter()
                .filter(|variant| execution.is_none() || variant.execution == execution)
                .map(|variant| &variant.output),
        );
        candidates
    }

    fn has_input_evidence(&self) -> bool {
        self.input_candidates()
            .iter()
            .any(|state| state.has_checksum_evidence())
    }
}

/// The byte representation a base match was computed from. Apply carries this
/// proof into later Base-authored steps instead of trying to rediscover it
/// from an already-modified chain intermediate.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct BaseRepresentation {
    pub headerless: Option<bool>,
    pub n64_byte_order: Option<N64ByteOrder>,
}

/// One base ROM variant with its computed checksums and byte representation.
#[derive(Clone, Debug)]
pub(crate) struct BaseVariant {
    pub name: String,
    pub state: PlanState,
    pub representation: BaseRepresentation,
}

/// Handler-normalized endpoint evidence tied to the concrete base bytes that
/// produced it. Apply keeps this parallel to the pure planner's selections.
#[derive(Clone, Debug)]
pub(crate) struct BaseEndpointMatch {
    pub selection: PatchEndpointSelection,
    pub variant: String,
    pub representation: BaseRepresentation,
}

/// Per-step verification spec threaded into the apply chain loop. An empty
/// slice (or all-default entries) reproduces today's behavior exactly.
#[derive(Clone, Debug, Default)]
pub(crate) struct PatchStepVerification {
    /// Resolved basis for this step; `None` behaves as previous (default).
    pub basis: Option<PatchInputBasis>,
    /// Where the basis came from (labels/tracing only).
    pub basis_source: Option<PatchBasisSource>,
    /// Planner-selected reversible endpoint for this step.
    pub execution: Option<PatchEndpointSelection>,
    /// Exact base representation selected by checksum planning (`raw`,
    /// `headerless`, or a handler-specific label).
    pub base_variant: Option<String>,
    /// Typed execution state for the selected base representation.
    pub base_representation: Option<BaseRepresentation>,
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

/// Copy the planner's basis decisions onto apply's declaration-carrying step
/// records without disturbing bundle checks or chain-prefix metadata.
pub(crate) fn apply_resolved_bases(
    resolved: &ResolvedPlan,
    base_variants: &[BaseVariant],
    mut steps: Vec<PatchStepVerification>,
) -> Vec<PatchStepVerification> {
    debug_assert_eq!(resolved.per_patch.len(), steps.len());
    for (step, verdict) in steps.iter_mut().zip(&resolved.per_patch) {
        step.basis = Some(verdict.basis);
        step.basis_source = Some(verdict.basis_source);
        step.execution = verdict.execution;
        if let PatchInputMatch::Base { variant } = &verdict.matched {
            step.base_variant = Some(variant.clone());
            step.base_representation = base_variants
                .iter()
                .find(|candidate| candidate.name == *variant)
                .map(|candidate| candidate.representation);
        } else {
            step.base_variant = None;
            step.base_representation = None;
        }
    }
    steps
}

/// Parse a parse/describe report's normalized `details.patch.endpoints`
/// into planner states, one `(input, output)` pair per variant.
pub(crate) fn parse_endpoint_variants(details: Option<&Value>) -> Vec<PlanEndpointVariant> {
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
            let execution = variant
                .get("execution")
                .and_then(|value| serde_json::from_value(value.clone()).ok());
            PlanEndpointVariant {
                input: parse_endpoint_side(variant.get("input")),
                output: parse_endpoint_side(variant.get("output")),
                execution,
            }
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

/// Compare a declared requirement rather than inference evidence. Every
/// declared field must be present and equal; unlike inference, an exact size
/// is sufficient because the user explicitly pinned it.
fn compare_declared_state(expected: &PlanState, state: &PlanState) -> EvidenceMatch {
    let mut matched_fields = 0usize;
    let mut missing_field = false;
    for (algorithm, hex) in &expected.checksums {
        match state.checksums.get(algorithm) {
            Some(other) if !other.eq_ignore_ascii_case(hex) => {
                return EvidenceMatch::Conflict;
            }
            Some(_) => matched_fields += 1,
            None => missing_field = true,
        }
    }
    if let Some(expected_size) = expected.size {
        match state.size {
            Some(actual_size) if actual_size != expected_size => {
                return EvidenceMatch::Conflict;
            }
            Some(_) => matched_fields += 1,
            None => missing_field = true,
        }
    }
    if missing_field || matched_fields == 0 {
        EvidenceMatch::Disjoint
    } else {
        EvidenceMatch::Match
    }
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

/// Select an embedded execution only when exactly one endpoint matches.
fn matching_execution(patch: &PlanPatchInput, state: &PlanState) -> Option<PatchEndpointSelection> {
    let mut matches = patch.embedded.iter().filter_map(|variant| {
        (compare_states(&variant.input, state) == EvidenceMatch::Match)
            .then_some(variant.execution)
            .flatten()
    });
    let selection = matches.next()?;
    matches.next().is_none().then_some(selection)
}

fn matching_base_execution(
    patch: &PlanPatchInput,
    state: &PlanState,
    allow_reverse: bool,
) -> Option<PatchEndpointSelection> {
    let mut matches = patch.embedded.iter().filter_map(|variant| {
        let selection = variant.execution?;
        (compare_states(&variant.input, state) == EvidenceMatch::Match
            && (allow_reverse
                || selection.direction == rom_weaver_core::PatchApplyDirection::Forward))
            .then_some(selection)
    });
    let selection = matches.next()?;
    matches.next().is_none().then_some(selection)
}

fn unique_execution(selections: &[PatchEndpointSelection]) -> Option<PatchEndpointSelection> {
    match selections {
        [selection] => Some(*selection),
        _ => None,
    }
}

/// Match only the patch's own endpoint evidence against compatible base
/// representations. A declared Base check is an additional constraint: it
/// must not hide a comparable embedded conflict. Handler-normalized matches
/// win when a format proves a representation generic whole-file hashes cannot
/// see.
fn match_embedded_base(
    patch: &PlanPatchInput,
    base_variants: &[BaseVariant],
    allow_reverse_handler_match: bool,
) -> (Option<String>, bool, Option<PatchEndpointSelection>) {
    let candidates = patch.embedded_base_input_candidates(allow_reverse_handler_match);
    let mut conflicted = false;
    for (index, variant) in base_variants.iter().enumerate() {
        match compare_candidates(&candidates, &variant.state) {
            EvidenceMatch::Match => {
                let execution = if patch.base_executions.is_empty() {
                    matching_base_execution(patch, &variant.state, allow_reverse_handler_match)
                } else {
                    unique_execution(&patch.base_executions)
                };
                return (Some(base_variants[index].name.clone()), false, execution);
            }
            EvidenceMatch::Conflict => conflicted = true,
            EvidenceMatch::Disjoint => {}
        }
    }
    let handler_can_infer_base = patch.has_forward_base_execution();
    if !patch.base_executions.is_empty() && (allow_reverse_handler_match || handler_can_infer_base)
    {
        return (
            Some("handler-normalized".to_string()),
            false,
            unique_execution(&patch.base_executions),
        );
    }
    (None, conflicted, None)
}

/// Verdict for one required state against every compatible representation of
/// the base ROM. Apply uses this for declared base checks, which are mandatory
/// even when a patch's embedded endpoint independently matches the base.
pub(crate) fn base_state_verdict(
    state: &PlanState,
    base_variants: &[BaseVariant],
) -> PatchInputVerdict {
    let mut conflicted = false;
    for variant in base_variants {
        match compare_declared_state(state, &variant.state) {
            EvidenceMatch::Match => return PatchInputVerdict::Passed,
            EvidenceMatch::Conflict => conflicted = true,
            EvidenceMatch::Disjoint => {}
        }
    }
    if conflicted {
        PatchInputVerdict::Failed
    } else {
        PatchInputVerdict::Unknown
    }
}

fn match_base(
    patch: &PlanPatchInput,
    base_variants: &[BaseVariant],
    allow_reverse_handler_match: bool,
) -> (Option<String>, bool, Option<PatchEndpointSelection>) {
    if !patch.declared_input.is_empty() {
        match base_state_verdict(&patch.declared_input, base_variants) {
            PatchInputVerdict::Failed => return (None, true, None),
            PatchInputVerdict::Passed if patch.declared_basis == Some(PatchInputBasis::Base) => {
                let (index, variant) = base_variants
                    .iter()
                    .enumerate()
                    .find(|(_, variant)| {
                        compare_declared_state(&patch.declared_input, &variant.state)
                            == EvidenceMatch::Match
                    })
                    .expect("passed declaration has a matching base variant");
                let (embedded_match, embedded_conflict, execution) =
                    match_embedded_base(patch, base_variants, allow_reverse_handler_match);
                if let Some(embedded_match) = embedded_match {
                    return (Some(embedded_match), false, execution);
                }
                if embedded_conflict {
                    return (None, true, None);
                }
                return (
                    Some(base_variants[index].name.clone()),
                    false,
                    matching_base_execution(patch, &variant.state, allow_reverse_handler_match),
                );
            }
            PatchInputVerdict::Passed
            | PatchInputVerdict::ChainDeferred
            | PatchInputVerdict::Unknown => {}
        }
    }
    let candidates = patch.base_input_candidates(allow_reverse_handler_match);
    let mut conflicted = false;
    for (index, variant) in base_variants.iter().enumerate() {
        match compare_candidates(&candidates, &variant.state) {
            EvidenceMatch::Match => {
                let execution = if patch.base_executions.is_empty() {
                    matching_base_execution(patch, &variant.state, allow_reverse_handler_match)
                } else {
                    unique_execution(&patch.base_executions)
                };
                return (Some(base_variants[index].name.clone()), false, execution);
            }
            EvidenceMatch::Conflict => conflicted = true,
            EvidenceMatch::Disjoint => {}
        }
    }
    let handler_can_infer_base = patch.has_forward_base_execution();
    if !patch.base_executions.is_empty() && (allow_reverse_handler_match || handler_can_infer_base)
    {
        return (
            Some("handler-normalized".to_string()),
            false,
            unique_execution(&patch.base_executions),
        );
    }
    (None, conflicted, None)
}

pub(crate) fn should_resolve_base_endpoints(
    index: usize,
    declared_basis: Option<PatchInputBasis>,
) -> bool {
    index == 0 || declared_basis != Some(PatchInputBasis::Previous)
}

/// Compare patch `i`'s input against patch `j`'s known outputs.
fn match_patch_output(
    patch: &PlanPatchInput,
    predecessor: &PlanPatchInput,
    predecessor_execution: Option<PatchEndpointSelection>,
) -> (EvidenceMatch, Option<PatchEndpointSelection>) {
    let candidates = patch.input_candidates();
    let mut best = EvidenceMatch::Disjoint;
    for output in predecessor.output_candidates(predecessor_execution) {
        match compare_candidates(&candidates, output) {
            EvidenceMatch::Match => {
                return (EvidenceMatch::Match, matching_execution(patch, output));
            }
            EvidenceMatch::Conflict => best = EvidenceMatch::Conflict,
            EvidenceMatch::Disjoint => {}
        }
    }
    (best, None)
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
        let allow_reverse_handler_match =
            index == 0 || patch.declared_basis == Some(PatchInputBasis::Base);
        let (base_match, base_conflict, base_execution) =
            match_base(patch, base_variants, allow_reverse_handler_match);
        let (previous_link, previous_execution) = if index > 0 {
            match_patch_output(patch, &patches[index - 1], per_patch[index - 1].execution)
        } else {
            (EvidenceMatch::Disjoint, None)
        };
        // A non-adjacent patch whose known output matches this input - the
        // order diagnosis. The immediate predecessor is checked separately.
        let other_match = patches.iter().enumerate().find_map(|(j, other)| {
            let adjacent = index > 0 && j == index - 1;
            if j == index || adjacent {
                return None;
            }
            let predecessor_execution = per_patch
                .get(j)
                .and_then(|verdict| verdict.execution)
                .or_else(|| {
                    match_base(
                        other,
                        base_variants,
                        j == 0 || other.declared_basis == Some(PatchInputBasis::Base),
                    )
                    .2
                });
            let (evidence, execution) = match_patch_output(patch, other, predecessor_execution);
            (evidence == EvidenceMatch::Match).then_some((j, execution))
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
                        variant: variant.clone(),
                    },
                    PatchInputVerdict::Passed,
                    format!("input matches the ROM ({variant})"),
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
                execution: base_execution,
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

            let (matched, input_verdict, execution, message) = match basis {
                PatchInputBasis::Base => match (base_match, base_conflict) {
                    (Some(variant), _) => (
                        PatchInputMatch::Base {
                            variant: variant.clone(),
                        },
                        PatchInputVerdict::Passed,
                        base_execution,
                        format!(
                            "input matches the ROM ({}); embedded checks are skipped mid-chain",
                            variant
                        ),
                    ),
                    (None, true) => (
                        PatchInputMatch::None,
                        PatchInputVerdict::Failed,
                        None,
                        "declared against the base ROM but input checks do not match it"
                            .to_string(),
                    ),
                    (None, false) => (
                        PatchInputMatch::None,
                        PatchInputVerdict::Unknown,
                        None,
                        "declared against the base ROM; no comparable input checks".to_string(),
                    ),
                },
                PatchInputBasis::Previous => match previous_link {
                    EvidenceMatch::Match => (
                        PatchInputMatch::PatchOutput {
                            index: (index - 1) as u32,
                        },
                        PatchInputVerdict::ChainDeferred,
                        previous_execution,
                        format!(
                            "input matches {}'s declared output",
                            position_label(index - 1)
                        ),
                    ),
                    EvidenceMatch::Conflict | EvidenceMatch::Disjoint => {
                        if let Some((j, execution)) = other_match {
                            expected_predecessor = Some(j as u32);
                            (
                                PatchInputMatch::PatchOutput { index: j as u32 },
                                PatchInputVerdict::ChainDeferred,
                                execution,
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
                                None,
                                "input checks match neither the ROM nor another patch's output"
                                    .to_string(),
                            )
                        } else if previous_link == EvidenceMatch::Conflict {
                            (
                                PatchInputMatch::None,
                                PatchInputVerdict::ChainDeferred,
                                None,
                                "input checks disagree with the previous patch's declared output"
                                    .to_string(),
                            )
                        } else {
                            (
                                PatchInputMatch::None,
                                PatchInputVerdict::ChainDeferred,
                                None,
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
                execution,
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

pub(crate) fn resolve_output_verification(
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
        let selected_execution = per_patch[last_index].execution;
        let (embedded_output, execution_resolved) = if let Some(selection) = selected_execution {
            (
                last.embedded
                    .iter()
                    .find(|variant| variant.execution == Some(selection))
                    .map(|variant| &variant.output),
                true,
            )
        } else {
            match last.embedded.as_slice() {
                [variant] => (Some(&variant.output), true),
                _ => {
                    let mut forward = last.embedded.iter().filter(|variant| {
                        variant.execution.is_some_and(|selection| {
                            selection.direction == rom_weaver_core::PatchApplyDirection::Forward
                        })
                    });
                    let first = forward.next();
                    let output = match (first, forward.next()) {
                        (Some(variant), None) => Some(&variant.output),
                        _ => None,
                    };
                    (output, false)
                }
            }
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
            let enforceable = execution_resolved && chain_exact && head_ok;
            let standdown_reason = if enforceable {
                None
            } else if !execution_resolved {
                Some("the reversible patch execution direction is unresolved".to_string())
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
                representation: BaseRepresentation::default(),
            })
            .collect()
    }

    fn patch(name: &str) -> PlanPatchInput {
        PlanPatchInput {
            name: name.to_string(),
            declared_input_infers_base: true,
            ..PlanPatchInput::default()
        }
    }

    fn embedded(input: PlanState, output: PlanState) -> Vec<PlanEndpointVariant> {
        vec![PlanEndpointVariant {
            input,
            output,
            execution: None,
        }]
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
    fn ambiguous_endpoint_matches_do_not_choose_the_first_execution() {
        let mut reversible = patch("ambiguous.rup");
        reversible.embedded = [0, 1]
            .into_iter()
            .map(|variant| PlanEndpointVariant {
                input: state(&[("crc32", BASE_CRC)], Some(1024)),
                output: state(&[("crc32", OUT_CRC)], Some(1024)),
                execution: Some(PatchEndpointSelection {
                    variant,
                    direction: rom_weaver_core::PatchApplyDirection::Forward,
                }),
            })
            .collect();

        let plan = resolve_verification_plan(&raw_base(), &[reversible]);

        assert_eq!(plan.per_patch[0].input_verdict, PatchInputVerdict::Passed);
        assert_eq!(plan.per_patch[0].execution, None);
    }

    #[test]
    fn declared_handler_normalized_endpoint_can_match_after_raw_base_conflict() {
        let selection = PatchEndpointSelection {
            variant: 0,
            direction: rom_weaver_core::PatchApplyDirection::Reverse,
        };
        let mut reversible = patch("normalized.rup");
        reversible.declared_basis = Some(PatchInputBasis::Base);
        reversible.embedded = vec![PlanEndpointVariant {
            input: state(&[("md5", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")], Some(1024)),
            output: state(&[("md5", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")], Some(1024)),
            execution: Some(selection),
        }];
        reversible.base_executions = vec![selection];
        let raw = base(&[(
            "raw",
            &[("md5", "cccccccccccccccccccccccccccccccc")],
            Some(1024),
        )]);

        let plan = resolve_verification_plan(&raw, &[reversible]);

        assert_eq!(plan.per_patch[0].basis, PatchInputBasis::Base);
        assert_eq!(plan.per_patch[0].input_verdict, PatchInputVerdict::Passed);
        assert_eq!(plan.per_patch[0].execution, Some(selection));
        assert_eq!(
            plan.per_patch[0].matched,
            PatchInputMatch::Base {
                variant: "handler-normalized".to_string()
            }
        );
    }

    #[test]
    fn declared_input_conflict_blocks_embedded_and_handler_base_matches() {
        let selection = PatchEndpointSelection {
            variant: 0,
            direction: rom_weaver_core::PatchApplyDirection::Forward,
        };
        let mut reversible = patch("normalized.rup");
        reversible.declared_input = state(&[("crc32", OTHER_CRC)], Some(1024));
        reversible.embedded = vec![PlanEndpointVariant {
            input: state(&[("crc32", BASE_CRC)], Some(1024)),
            output: state(&[("crc32", OUT_CRC)], Some(1024)),
            execution: Some(selection),
        }];
        reversible.base_executions = vec![selection];

        let plan = resolve_verification_plan(&raw_base(), &[reversible]);

        assert_eq!(plan.per_patch[0].input_verdict, PatchInputVerdict::Failed);
        assert_eq!(plan.per_patch[0].matched, PatchInputMatch::None);
        assert_eq!(plan.per_patch[0].execution, None);
    }

    #[test]
    fn declared_base_match_does_not_hide_embedded_base_conflict() {
        let mut declared = patch("wrong.bps");
        declared.declared_basis = Some(PatchInputBasis::Base);
        declared.declared_input = state(&[("crc32", BASE_CRC)], Some(1024));
        declared.embedded = embedded(
            state(&[("crc32", OTHER_CRC)], Some(1024)),
            state(&[("crc32", OUT_CRC)], Some(1024)),
        );

        let plan = resolve_verification_plan(&raw_base(), &[declared]);

        assert_eq!(plan.per_patch[0].input_verdict, PatchInputVerdict::Failed);
        assert_eq!(plan.per_patch[0].matched, PatchInputMatch::None);
    }

    #[test]
    fn declared_and_embedded_inputs_can_match_compatible_base_variants() {
        let mut declared = patch("headerless.bps");
        declared.declared_basis = Some(PatchInputBasis::Base);
        declared.declared_input = state(&[("crc32", BASE_CRC)], Some(1024));
        declared.embedded = embedded(
            state(&[("crc32", HEADERLESS_CRC)], Some(512)),
            state(&[("crc32", OUT_CRC)], Some(512)),
        );
        let variants = base(&[
            ("raw", &[("crc32", BASE_CRC)], Some(1024)),
            ("headerless", &[("crc32", HEADERLESS_CRC)], Some(512)),
        ]);

        let plan = resolve_verification_plan(&variants, &[declared]);

        assert_eq!(plan.per_patch[0].input_verdict, PatchInputVerdict::Passed);
        assert_eq!(
            plan.per_patch[0].matched,
            PatchInputMatch::Base {
                variant: "headerless".to_string()
            }
        );
    }

    #[test]
    fn declared_input_accepts_a_compatible_headerless_base_variant() {
        let mut declared = patch("headerless.ips");
        declared.declared_basis = Some(PatchInputBasis::Base);
        declared.declared_input = state(&[], Some(512));
        let variants = base(&[
            ("raw", &[("crc32", BASE_CRC)], Some(1024)),
            ("headerless", &[("crc32", HEADERLESS_CRC)], Some(512)),
        ]);

        let plan = resolve_verification_plan(&variants, &[declared]);

        assert_eq!(plan.per_patch[0].input_verdict, PatchInputVerdict::Passed);
        assert_eq!(
            plan.per_patch[0].matched,
            PatchInputMatch::Base {
                variant: "headerless".to_string()
            }
        );
    }

    #[test]
    fn base_endpoint_resolution_skips_only_later_declared_previous_steps() {
        assert!(should_resolve_base_endpoints(
            0,
            Some(PatchInputBasis::Previous)
        ));
        assert!(!should_resolve_base_endpoints(
            1,
            Some(PatchInputBasis::Previous)
        ));
        assert!(should_resolve_base_endpoints(
            1,
            Some(PatchInputBasis::Base)
        ));
        assert!(should_resolve_base_endpoints(1, None));
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
    fn previous_basis_ignores_ambiguous_base_endpoints() {
        let mut a = patch("a.bps");
        a.embedded = embedded(
            state(&[("crc32", BASE_CRC)], None),
            state(&[("crc32", MID_CRC)], None),
        );
        let mut b = patch("ambiguous.rup");
        b.declared_basis = Some(PatchInputBasis::Previous);
        b.embedded = [0, 1]
            .into_iter()
            .map(|variant| PlanEndpointVariant {
                input: state(&[("crc32", MID_CRC)], None),
                output: state(&[("crc32", OUT_CRC)], None),
                execution: Some(PatchEndpointSelection {
                    variant,
                    direction: rom_weaver_core::PatchApplyDirection::Forward,
                }),
            })
            .collect();
        b.base_executions = b
            .embedded
            .iter()
            .filter_map(|variant| variant.execution)
            .collect();

        let plan = resolve_verification_plan(&raw_base(), &[a, b]);

        assert_eq!(plan.per_patch[1].basis, PatchInputBasis::Previous);
        assert_eq!(plan.per_patch[1].basis_source, PatchBasisSource::Declared);
        assert_eq!(plan.per_patch[1].execution, None);
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
    fn unresolved_reversible_patch_keeps_forward_target_as_non_enforceable() {
        let mut reversible = patch("unresolved.rup");
        reversible.embedded = vec![
            PlanEndpointVariant {
                input: state(&[("md5", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")], None),
                output: state(&[("md5", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")], None),
                execution: Some(PatchEndpointSelection {
                    variant: 0,
                    direction: rom_weaver_core::PatchApplyDirection::Forward,
                }),
            },
            PlanEndpointVariant {
                input: state(&[("md5", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")], None),
                output: state(&[("md5", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")], None),
                execution: Some(PatchEndpointSelection {
                    variant: 0,
                    direction: rom_weaver_core::PatchApplyDirection::Reverse,
                }),
            },
        ];

        let plan = resolve_verification_plan(&raw_base(), &[reversible]);
        assert_eq!(plan.per_patch[0].execution, None);
        let entry = plan
            .output_verification
            .iter()
            .find(|entry| entry.source == "embedded target checks")
            .expect("forward target remains visible");
        assert_eq!(
            entry.checks.checksums.get("md5").map(String::as_str),
            Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        );
        assert!(!entry.enforceable);
        assert_eq!(
            entry.standdown_reason.as_deref(),
            Some("the reversible patch execution direction is unresolved")
        );
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
