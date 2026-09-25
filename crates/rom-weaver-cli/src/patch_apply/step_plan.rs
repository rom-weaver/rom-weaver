//! Planning of every apply step's input basis and verification before the
//! chain runs.

use super::*;

impl CliApp {
    /// Assemble apply's declarations, then use the same whole-file endpoint
    /// planner as `patch validate --plan` to resolve every step's basis.
    /// Declared base steps still verify against the base before the chain;
    /// ignore mode still resolves basis, representation, and execution but does
    /// not enforce declared or embedded checks.
    pub(super) fn plan_apply_step_verifications(
        &self,
        steps: &mut [PatchApplyStep],
        cheat_steps: usize,
        shared: PatchBasisMode,
        cli_basis_count: usize,
        base_inputs: PatchApplyBaseInputs<'_>,
        context: &OperationContext,
    ) -> Result<()> {
        let original_representation = Self::base_representation(
            base_inputs.original,
            None,
            base_inputs.original_n64_byte_order,
        )?;
        let prepared_representation = Self::base_representation(
            base_inputs.prepared,
            base_inputs.prepared_headerless,
            base_inputs.prepared_n64_byte_order,
        )?;
        let endpoint_inputs = if base_inputs.prepared == base_inputs.original {
            vec![(base_inputs.prepared, "raw", prepared_representation)]
        } else {
            vec![
                (
                    base_inputs.prepared,
                    "prepared-raw",
                    prepared_representation,
                ),
                (base_inputs.original, "raw", original_representation),
            ]
        };
        Self::declare_apply_step_bases(steps, cheat_steps, shared, cli_basis_count)?;
        let (plan_inputs, base_endpoint_matches) =
            self.apply_step_plan_inputs(steps, &endpoint_inputs, context)?;
        let base_variants = Self::plan_apply_base_variants(
            base_inputs.original,
            original_representation,
            base_inputs.prepared,
            prepared_representation,
            &plan_inputs,
            context,
        )?;
        let resolved = patch_plan::resolve_verification_plan(&base_variants, &plan_inputs);
        Self::check_apply_step_bases(steps, &plan_inputs, &resolved, &base_variants, context)?;

        let verifications = steps
            .iter_mut()
            .map(|step| step.metadata.verification.take().unwrap_or_default())
            .collect();
        let mut planned_verifications =
            patch_plan::apply_resolved_bases(&resolved, &base_variants, verifications);
        for ((step, verdict), endpoint_matches) in planned_verifications
            .iter_mut()
            .zip(&resolved.per_patch)
            .zip(&base_endpoint_matches)
        {
            if step.base_representation.is_none()
                && verdict.basis == patch_plan::PatchInputBasis::Base
                && let Some(selection) = verdict.execution
                && let Some(matched) = endpoint_matches
                    .iter()
                    .find(|matched| matched.selection == selection)
            {
                step.base_variant = Some(matched.variant.clone());
                step.base_representation = Some(matched.representation);
            }
        }
        for (step, verification) in steps.iter_mut().zip(planned_verifications) {
            step.metadata.verification = Some(verification);
        }
        Ok(())
    }

    /// Give cheat steps an empty verification and apply the shared basis and
    /// the per-step `--patch-basis` declarations to the user steps.
    fn declare_apply_step_bases(
        steps: &mut [PatchApplyStep],
        cheat_steps: usize,
        shared: PatchBasisMode,
        cli_basis_count: usize,
    ) -> Result<()> {
        let user_count = steps.len().saturating_sub(cheat_steps);
        // Declared sources align with the user-visible patch list; discovery
        // or archive expansion can change the resolved count, in which case
        // declarations cannot be attributed and only inference applies.
        let aligned = |declared_len: usize| declared_len == user_count;
        let bundle_steps_applied = user_count > 0
            && steps
                .iter()
                .skip(cheat_steps)
                .all(|step| step.metadata.verification.is_some());
        for step in steps.iter_mut().take(cheat_steps) {
            step.metadata.verification = Some(patch_plan::PatchStepVerification::default());
        }
        if !bundle_steps_applied {
            for step in steps.iter_mut().skip(cheat_steps) {
                let verification = step
                    .metadata
                    .verification
                    .get_or_insert_with(patch_plan::PatchStepVerification::default);
                verification.basis = shared.declared();
                verification.basis_source = verification.basis.map(|_| PatchBasisSource::Declared);
            }
        }
        if cli_basis_count > 0 {
            if !aligned(cli_basis_count) {
                return Err(RomWeaverError::Validation(format!(
                    "--patch-basis must be given once per --patch (or not at all); got {} value(s) for {user_count} patch(es)",
                    cli_basis_count
                )));
            }
            for step in steps.iter_mut().skip(cheat_steps) {
                let basis = step
                    .metadata
                    .cli_basis
                    .expect("aligned per-step basis metadata exists");
                let verification = step
                    .metadata
                    .verification
                    .get_or_insert_with(patch_plan::PatchStepVerification::default);
                verification.basis = basis.declared();
                verification.basis_source = verification.basis.map(|_| PatchBasisSource::Declared);
            }
        }
        Ok(())
    }

    /// Build the planner input for every step, with the handler-normalized
    /// base endpoints each step matches.
    fn apply_step_plan_inputs(
        &self,
        steps: &[PatchApplyStep],
        endpoint_inputs: &[(&Path, &str, patch_plan::BaseRepresentation)],
        context: &OperationContext,
    ) -> Result<(
        Vec<patch_plan::PlanPatchInput>,
        Vec<Vec<patch_plan::BaseEndpointMatch>>,
    )> {
        let mut base_endpoint_matches = vec![Vec::new(); steps.len()];
        let plan_inputs: Vec<patch_plan::PlanPatchInput> = steps
            .iter()
            .enumerate()
            .map(|(index, step)| {
                let patch_path = &step.patch.source;
                let resolved_patch_path = &step.patch.resolved;
                let handler = self.patches.probe(resolved_patch_path);
                let verification = step.metadata.verification.as_ref();
                let declared_basis = verification.and_then(|verification| verification.basis);
                // Unbased bundle checks constrain inference and remain a
                // previous-step runtime gate; only explicit declarations may
                // use them as independent base evidence. Ignore mode retains
                // endpoint planning without turning declarations back into
                // validation gates.
                let declared_input = if context.strict_patch_checksums() {
                    verification
                        .and_then(|verification| verification.declared_input.clone())
                        .unwrap_or_default()
                } else {
                    patch_plan::PlanState::default()
                };
                let declared_output = if context.strict_patch_checksums() {
                    verification
                        .and_then(|verification| verification.declared_output.clone())
                        .unwrap_or_default()
                } else {
                    patch_plan::PlanState::default()
                };
                let mut plan_input = Self::build_plan_patch_input(
                    patch_path,
                    resolved_patch_path,
                    handler.as_deref(),
                    declared_basis,
                    declared_input,
                    declared_output,
                    context,
                );
                plan_input.declared_input_infers_base = declared_basis.is_some();
                if patch_plan::should_resolve_base_endpoints(index, plan_input.declared_basis)
                    && let Some(handler) = handler.as_deref()
                {
                    plan_input.base_executions = match Self::resolve_base_endpoint_selections(
                        handler,
                        resolved_patch_path,
                        endpoint_inputs,
                        context,
                    ) {
                        Ok(matches) => {
                            let selections =
                                matches.iter().map(|matched| matched.selection).collect();
                            base_endpoint_matches[index] = matches;
                            selections
                        }
                        Err(RomWeaverError::Cancelled) => {
                            return Err(RomWeaverError::Cancelled);
                        }
                        Err(error) => {
                            debug!(
                                %error,
                                patch = %patch_path.display(),
                                "handler-normalized base endpoint evidence unavailable"
                            );
                            Vec::new()
                        }
                    };
                }
                Ok(plan_input)
            })
            .collect::<Result<Vec<_>>>()?;
        Ok((plan_inputs, base_endpoint_matches))
    }

    /// Reject a base step that matches more than one reversible endpoint, and
    /// a declared base step whose input checks do not match the base ROM.
    fn check_apply_step_bases(
        steps: &[PatchApplyStep],
        plan_inputs: &[patch_plan::PlanPatchInput],
        resolved: &patch_plan::ResolvedPlan,
        base_variants: &[patch_plan::BaseVariant],
        context: &OperationContext,
    ) -> Result<()> {
        for (index, verdict) in resolved.per_patch.iter().enumerate() {
            if verdict.basis == patch_plan::PatchInputBasis::Base
                && plan_inputs[index].base_executions.len() > 1
            {
                return Err(RomWeaverError::ValidationCode(
                    ValidationCodeError::new("patch.base.endpoint_ambiguous")
                        .with_message(
                            "patch input matches multiple reversible endpoints against the base ROM",
                        )
                        .with_field("patch_index", index as u64)
                        .with_field(
                            "patch",
                            steps[index].patch.source.display().to_string(),
                        )
                        .with_field(
                            "matches",
                            plan_inputs[index].base_executions.len() as u64,
                        ),
                ));
            }
        }

        for index in 0..steps.len() {
            let patch_path = &steps[index].patch.source;
            let required_base_failed = resolved.per_patch[index].input_verdict
                == patch_plan::PatchInputVerdict::Failed
                || (!plan_inputs[index].declared_input.is_empty()
                    && patch_plan::base_state_verdict(
                        &plan_inputs[index].declared_input,
                        base_variants,
                    ) == patch_plan::PatchInputVerdict::Failed);
            if context.strict_patch_checksums()
                && steps[index]
                    .metadata
                    .verification
                    .as_ref()
                    .is_some_and(|verification| {
                        verification.basis == Some(patch_plan::PatchInputBasis::Base)
                            && verification.basis_source
                                == Some(patch_plan::PatchBasisSource::Declared)
                    })
                && required_base_failed
            {
                let mut coded = ValidationCodeError::new("patch.base.input_mismatch")
                    .with_message(
                        "patch declares basis base but its input checks do not match the ROM",
                    )
                    .with_field("patch_index", index as u64)
                    .with_field("patch", patch_path.display().to_string())
                    .with_field("detail", resolved.per_patch[index].message.clone());
                let declared = &plan_inputs[index].declared_input;
                super::super::bundle_apply::describe_expected_state(
                    &declared.checksums,
                    declared.size,
                    &mut coded,
                );
                return Err(RomWeaverError::ValidationCode(coded));
            }
            if resolved.per_patch[index].basis_source == patch_plan::PatchBasisSource::InferredBase
            {
                debug!(
                    index,
                    patch = %patch_path.display(),
                    "patch input checks match the base ROM; resolved basis to base"
                );
            }
        }
        Ok(())
    }
}
