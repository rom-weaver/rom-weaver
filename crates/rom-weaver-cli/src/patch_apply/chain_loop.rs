//! The patch-apply chain loop: each step selects its input, transitions its
//! representation, verifies, applies, and records its output.

use super::*;

/// The state the chain loop carries from one step to the next.
struct ChainLoopState {
    normal_patch_count: usize,
    patch_count: usize,
    cheat_positions: Vec<usize>,
    ordered_cheats: bool,
    current_input: PathBuf,
    initial_output: ProducedPatchOutput,
    producer_outputs: BTreeMap<String, ProducedPatchOutput>,
    target_outputs: BTreeMap<BundlePatchInput, ProducedPatchOutput>,
    lane_seeds: BTreeMap<Option<BundlePatchInput>, ProducedPatchOutput>,
    lane_plans:
        BTreeMap<Option<BundlePatchInput>, BTreeMap<usize, patch_plan::PatchStepVerification>>,
    legacy_output: ProducedPatchOutput,
    applied_formats: Vec<&'static str>,
    disc_track_replacements: BTreeMap<PathBuf, PathBuf>,
    report: OperationReport,
    stage_index: usize,
}

/// One chain step, with its lane and planned verification resolved.
struct ChainStep<'s> {
    index: usize,
    apply_step: &'s PatchApplyStep,
    target: Option<&'s BundlePatchInput>,
    explicit_input: Option<&'s BundlePatchInput>,
    lane_position: usize,
    verification: Option<patch_plan::PatchStepVerification>,
    handler: Arc<dyn rom_weaver_core::PatchHandler>,
    patch_start_percent: f32,
}

impl ChainStep<'_> {
    fn patch_path(&self) -> &Path {
        &self.apply_step.patch.source
    }

    fn format(&self) -> &'static str {
        self.handler.descriptor().name
    }

    fn verification(&self) -> Option<&patch_plan::PatchStepVerification> {
        self.verification.as_ref()
    }
}

impl CliApp {
    /// Apply the resolved chain through temporary intermediates into
    /// `staged_output`. Errors carry the failing operation report.
    pub(super) fn run_patch_apply_loop(
        &self,
        mut inputs: RunPatchApplyLoopInputs<'_>,
    ) -> std::result::Result<PatchApplyLoopOutcome, Box<OperationReport>> {
        let mut state = Self::start_chain_loop(&mut inputs)?;
        let steps = inputs.steps;
        for (index, apply_step) in steps.iter().enumerate() {
            self.apply_positioned_cheat_stage(&mut inputs, &mut state, index)?;
            let step = self.select_chain_step(&mut inputs, &mut state, index, apply_step)?;
            self.transition_chain_step_input(&mut inputs, &mut state, &step)?;
            let is_last = state.stage_index + 1 == state.patch_count;
            let apply_output = Self::chain_step_apply_output(&mut inputs, &step, is_last)?;
            self.emit_running(
                OperationLabel {
                    command: "patch-apply",
                    family: OperationFamily::Patch,
                    format: Some(step.format()),
                },
                "apply",
                if state.patch_count == 1 {
                    format!("applying patch using {}", step.format())
                } else {
                    format!(
                        "applying patch {}/{} using {} (`{}`)",
                        index + 1,
                        state.patch_count,
                        step.format(),
                        step.patch_path().display()
                    )
                },
                Some(step.patch_start_percent),
                None,
            );
            self.execute_chain_step(&mut inputs, &mut state, &step, &apply_output)?;
            self.record_chain_step_output(&mut inputs, &mut state, &step, is_last, apply_output)?;
            state.stage_index += 1;
        }
        self.apply_trailing_cheat_stage(&mut inputs, &mut state)?;

        Ok(PatchApplyLoopOutcome {
            report: state.report,
            applied_formats: state.applied_formats,
            disc_track_replacements: state.disc_track_replacements,
        })
    }

    fn start_chain_loop(
        inputs: &mut RunPatchApplyLoopInputs<'_>,
    ) -> std::result::Result<ChainLoopState, Box<OperationReport>> {
        let context = inputs.context;
        let normal_patch_count = inputs.steps.len();
        let (cheat_positions, ordered_cheats, cheat_stage_count) = resolve_cheat_stage_positions(
            inputs.cheat_positions,
            inputs.cheat_records.len(),
            normal_patch_count,
        )
        .map_err(|error| {
            Box::new(OperationReport::failed_with_error(
                OperationFamily::Patch,
                Some("cheat".to_string()),
                "validate",
                error,
                context.single_thread_execution(),
            ))
        })?;
        let patch_count = normal_patch_count + cheat_stage_count;
        let current_input = std::mem::take(&mut inputs.apply_input);
        let initial_input = current_input.clone();
        let initial_header_state = inputs.header_state.clone();
        let initial_n64_order = *inputs.n64_order;
        let initial_output = ProducedPatchOutput {
            path: initial_input.clone(),
            header_state: initial_header_state.clone(),
            n64_order: initial_n64_order,
        };
        let lane_seeds = BTreeMap::from([(
            None,
            ProducedPatchOutput {
                path: initial_input.clone(),
                header_state: initial_header_state.clone(),
                n64_order: initial_n64_order,
            },
        )]);
        let legacy_output = ProducedPatchOutput {
            path: initial_input.clone(),
            header_state: initial_header_state.clone(),
            n64_order: initial_n64_order,
        };
        Ok(ChainLoopState {
            normal_patch_count,
            patch_count,
            cheat_positions,
            ordered_cheats,
            current_input,
            initial_output,
            producer_outputs: BTreeMap::new(),
            target_outputs: BTreeMap::new(),
            lane_seeds,
            lane_plans: BTreeMap::new(),
            legacy_output,
            applied_formats: Vec::with_capacity(patch_count),
            disc_track_replacements: BTreeMap::new(),
            report: OperationReport::failed(
                OperationFamily::Patch,
                None,
                "apply",
                "patch apply was not executed",
                context.single_thread_execution(),
            ),
            stage_index: 0,
        })
    }

    /// Bake the database cheats positioned before step `index`, when the
    /// cheats carry explicit positions.
    fn apply_positioned_cheat_stage(
        &self,
        inputs: &mut RunPatchApplyLoopInputs<'_>,
        state: &mut ChainLoopState,
        index: usize,
    ) -> std::result::Result<(), Box<OperationReport>> {
        let positioned_records =
            cheat_records_at_position(inputs.cheat_records, &state.cheat_positions, index);
        if !state.ordered_cheats || positioned_records.is_empty() {
            return Ok(());
        }
        let apply_output = database_cheat_stage_output(
            state.stage_index,
            state.patch_count,
            inputs.staged_output,
            inputs.context,
            inputs.temp_paths,
        );
        self.apply_database_cheat_stage(ApplyDatabaseCheatStageInputs {
            input: &state.current_input,
            output: &apply_output,
            records: &positioned_records,
            allow_conflicts: inputs.allow_cheat_conflicts,
            stage_index: state.stage_index,
            stage_count: state.patch_count,
            context: inputs.context,
        })?;
        state.current_input = apply_output;
        state.legacy_output = ProducedPatchOutput {
            path: state.current_input.clone(),
            header_state: inputs.header_state.clone(),
            n64_order: *inputs.n64_order,
        };
        state.stage_index += 1;
        Ok(())
    }

    /// Select the bytes step `index` reads from (its target lane seed, then
    /// its explicit input), resolve its lane verification, and probe its
    /// handler.
    fn select_chain_step<'s>(
        &self,
        inputs: &mut RunPatchApplyLoopInputs<'_>,
        state: &mut ChainLoopState,
        index: usize,
        apply_step: &'s PatchApplyStep,
    ) -> std::result::Result<ChainStep<'s>, Box<OperationReport>> {
        let context = inputs.context;
        let explicit_input = apply_step.metadata.input.as_ref();
        let target = apply_step.metadata.target.as_ref();
        if let Some(target) = target {
            let selected = if let Some(output) = state.target_outputs.get(target) {
                output.clone()
            } else {
                self.resolve_chain_source(
                    target,
                    ChainSourceRole::Target,
                    ChainSourceInputs {
                        initial: &state.initial_output,
                        rom_member_inputs: inputs.rom_member_inputs,
                        producer_outputs: &state.producer_outputs,
                        generated_member_flags: inputs.generated_member_flags,
                        context,
                        temp_paths: inputs.temp_paths,
                    },
                )?
            };
            state.current_input = selected.path.clone();
            *inputs.header_state = selected.header_state.clone();
            *inputs.n64_order = selected.n64_order;
            state
                .lane_seeds
                .entry(Some(target.clone()))
                .or_insert(selected);
        } else {
            state.current_input = state.legacy_output.path.clone();
            *inputs.header_state = state.legacy_output.header_state.clone();
            *inputs.n64_order = state.legacy_output.n64_order;
        }
        if let Some(input) = explicit_input {
            let selected = self.resolve_chain_source(
                input,
                ChainSourceRole::Input,
                ChainSourceInputs {
                    initial: &state.initial_output,
                    rom_member_inputs: inputs.rom_member_inputs,
                    producer_outputs: &state.producer_outputs,
                    generated_member_flags: inputs.generated_member_flags,
                    context,
                    temp_paths: inputs.temp_paths,
                },
            )?;
            state.current_input = selected.path;
            *inputs.header_state = selected.header_state;
            *inputs.n64_order = selected.n64_order;
        }
        let steps = inputs.steps;
        let lane_key = target.cloned();
        let lane_position = (0..=index)
            .filter(|candidate| steps[*candidate].metadata.target == lane_key)
            .count()
            .saturating_sub(1);
        let verification = self
            .resolve_lane_step_verification(LaneVerificationInputs {
                index,
                steps,
                plan_target_lanes: inputs.plan_target_lanes,
                lane_key: &lane_key,
                lane_seeds: &state.lane_seeds,
                lane_plans: &mut state.lane_plans,
                shared_patch_basis: inputs.shared_patch_basis,
                context,
            })
            .map_err(|error| {
                Box::new(OperationReport::failed_with_error(
                    OperationFamily::Patch,
                    None,
                    "validate",
                    error,
                    context.single_thread_execution(),
                ))
            })?;

        let handler = self.probe_patch_handler(
            &apply_step.patch.source,
            &apply_step.patch.resolved,
            index,
            state.patch_count,
            inputs.probe_threads.clone(),
        )?;
        state.applied_formats.push(handler.descriptor().name);
        let patch_start_percent =
            patch_progress_segment_start(state.stage_index, state.patch_count);
        Ok(ChainStep {
            index,
            apply_step,
            target,
            explicit_input,
            lane_position,
            verification,
            handler,
            patch_start_percent,
        })
    }

    /// Later chain steps may need a different header state or N64 byte order
    /// than the previous patch left behind (explicit per-patch mode, or auto
    /// evidence from this patch's embedded source checksum).
    fn transition_chain_step_input(
        &self,
        inputs: &mut RunPatchApplyLoopInputs<'_>,
        state: &mut ChainLoopState,
        step: &ChainStep<'_>,
    ) -> std::result::Result<(), Box<OperationReport>> {
        if step.lane_position == 0 {
            return Ok(());
        }
        let context = inputs.context;
        let resolved_patch_path = &step.apply_step.patch.resolved;
        let verification = step.verification();
        let patch_count = state.patch_count;
        let failed = |what: &str, error: RomWeaverError| {
            Box::new(
                OperationReport::failed(
                    OperationFamily::Patch,
                    Some(step.format().to_string()),
                    "prepare",
                    format!(
                        "patch {}/{} (`{}`): {what} transition failed: {error}",
                        step.index + 1,
                        patch_count,
                        step.patch_path().display()
                    ),
                    context.single_thread_execution(),
                )
                .with_error_kind(error.kind()),
            )
        };
        let mut current_input = std::mem::take(&mut state.current_input);
        let header_result = self.chain_header_transition(
            ChainHeaderTransitionPlan {
                mode: step.apply_step.metadata.header_mode,
                base_variant: verification.and_then(|step| step.base_variant.as_deref()),
                base_representation: verification.and_then(|step| step.base_representation),
            },
            resolved_patch_path,
            &mut current_input,
            inputs.header_state,
            context,
            inputs.temp_paths,
        );
        if let Err(error) = header_result {
            return Err(failed("header", error));
        }
        let n64_result = self.transition_n64_byte_order(
            ChainN64TransitionPlan {
                mode: step.apply_step.metadata.n64_byte_order_mode,
                base_variant: verification.and_then(|step| step.base_variant.as_deref()),
                base_representation: verification.and_then(|step| step.base_representation),
            },
            resolved_patch_path,
            &mut current_input,
            inputs.n64_order,
            context,
            inputs.temp_paths,
        );
        if let Err(error) = n64_result {
            return Err(failed("N64 byte-order", error));
        }
        state.current_input = current_input;
        Ok(())
    }

    /// The last stage writes `staged_output`; earlier stages write a temporary
    /// intermediate.
    fn chain_step_apply_output(
        inputs: &mut RunPatchApplyLoopInputs<'_>,
        step: &ChainStep<'_>,
        is_last: bool,
    ) -> std::result::Result<PathBuf, Box<OperationReport>> {
        let apply_output = if is_last {
            inputs.staged_output.to_path_buf()
        } else {
            let intermediate_output = inputs
                .context
                .temp_paths()
                .next_path("patch-apply-output-step", Some("bin"));
            inputs.temp_paths.push(intermediate_output.clone());
            intermediate_output
        };
        if let Some(parent) = apply_output.parent()
            && !parent.exists()
            && let Err(error) = fs::create_dir_all(parent)
        {
            return Err(Box::new(
                OperationReport::failed(
                    OperationFamily::Patch,
                    Some(step.format().to_string()),
                    "prepare",
                    format!(
                        "failed to prepare output path `{}`: {error}",
                        apply_output.display()
                    ),
                    inputs.context.single_thread_execution(),
                )
                .with_error_kind(rom_weaver_core::RomWeaverErrorKind::Io),
            ));
        }
        Ok(apply_output)
    }

    /// Verify the step input against its declared checks, then run the patch
    /// handler into `apply_output`.
    fn execute_chain_step(
        &self,
        inputs: &mut RunPatchApplyLoopInputs<'_>,
        state: &mut ChainLoopState,
        step: &ChainStep<'_>,
        apply_output: &Path,
    ) -> std::result::Result<(), Box<OperationReport>> {
        let context = inputs.context;
        let index = step.index;
        let patch_count = state.patch_count;
        let verification = step.verification();
        let step_is_base = step.lane_position > 0
            && verification.and_then(|step| step.basis) == Some(patch_plan::PatchInputBasis::Base);
        Self::verify_chain_step_input(context, state, step, step_is_base)?;

        let request = PatchApplyRequest {
            input: std::mem::take(&mut state.current_input),
            patches: vec![step.apply_step.patch.resolved.clone()],
            output: apply_output.to_path_buf(),
        };
        let progress_tracker = Arc::new(PatchApplyProgressTracker::default());
        let mut patch_context =
            context
                .clone()
                .with_progress_sink(Arc::new(PatchApplyProgressSink::new(
                    context.progress_sink(),
                    state.stage_index,
                    patch_count,
                    progress_tracker.clone(),
                )));
        if step_is_base {
            // Both the embedded source and target checks describe the
            // base ROM (verified before the chain), not the running
            // intermediate - nothing at this step is enforceable. The
            // patch file's own integrity checksum still is.
            patch_context = patch_context.with_patch_check_scopes(PatchCheckScopes {
                patch_integrity: context.strict_patch_checksums(),
                source: false,
                target: false,
            });
            self.emit_running(
                OperationLabel {
                    command: "patch-apply",
                    family: OperationFamily::Patch,
                    format: Some(step.format()),
                },
                "apply",
                format!(
                    "patch {}/{} input checks describe the base ROM (verified before the chain); embedded checks skipped for this step",
                    index + 1,
                    patch_count
                ),
                Some(step.patch_start_percent),
                None,
            );
        }
        if let Some(selection) = verification.and_then(|step| step.execution) {
            patch_context = patch_context.with_patch_endpoint_selection(selection);
        }
        if let Some(order) = inputs
            .n64_order
            .as_ref()
            .map(|order| order.from)
            .or_else(|| {
                verification
                    .and_then(|step| step.base_representation)
                    .and_then(|representation| representation.n64_byte_order)
            })
        {
            patch_context = patch_context.with_patch_input_n64_byte_order(match order {
                N64ByteOrder::BigEndian => PatchInputN64ByteOrder::BigEndian,
                N64ByteOrder::LittleEndian => PatchInputN64ByteOrder::LittleEndian,
                N64ByteOrder::ByteSwapped => PatchInputN64ByteOrder::ByteSwapped,
            });
        }
        let report = match step.handler.apply(&request, &patch_context) {
            Ok(report) => report,
            Err(RomWeaverError::Unsupported(op)) => OperationReport::unsupported(
                OperationFamily::Patch,
                Some(step.format().to_string()),
                "apply",
                op.to_string(),
                context.single_thread_execution(),
            ),
            Err(error) => OperationReport::failed_with_error(
                OperationFamily::Patch,
                Some(step.format().to_string()),
                "apply",
                error,
                context.single_thread_execution(),
            ),
        };
        if report.status != OperationStatus::Succeeded {
            let mut report = report;
            if patch_count > 1 {
                report.label = format!(
                    "patch {}/{} (`{}`): {}",
                    index + 1,
                    patch_count,
                    step.patch_path().display(),
                    report.label
                );
            }
            return Err(Box::new(report));
        }
        if report
            .details
            .as_ref()
            .and_then(|details| details.pointer("/patch/output_representation/n64_byte_order"))
            .and_then(Value::as_str)
            == Some("big-endian")
        {
            let original = inputs
                .n64_order
                .as_ref()
                .map_or(N64ByteOrder::BigEndian, |order| order.to);
            *inputs.n64_order = Some(N64ByteOrderTransform {
                from: N64ByteOrder::BigEndian,
                to: original,
            });
        }
        if !progress_tracker.saw_meaningful_running_progress() {
            self.emit_running(
                OperationLabel {
                    command: "patch-apply",
                    family: OperationFamily::Patch,
                    format: Some(step.format()),
                },
                "apply",
                if patch_count == 1 {
                    format!("applied patch using {}", step.format())
                } else {
                    format!(
                        "applied patch {}/{} using {} (`{}`)",
                        index + 1,
                        patch_count,
                        step.format(),
                        step.patch_path().display()
                    )
                },
                None,
                report.thread_execution.clone(),
            );
        }
        state.report = report;
        Ok(())
    }

    /// Verify the bytes a step reads against the patch's declared input
    /// checks, where those checks describe this intermediate.
    fn verify_chain_step_input(
        context: &OperationContext,
        state: &ChainLoopState,
        step: &ChainStep<'_>,
        step_is_base: bool,
    ) -> std::result::Result<(), Box<OperationReport>> {
        let verification = step.verification();
        let step_declares_base = step_is_base
            && verification.and_then(|step| step.basis_source)
                == Some(patch_plan::PatchBasisSource::Declared);
        // A ROM-member lane has no base gate of its own, so its first
        // step verifies the member bytes against the declared input here.
        // An authored declaration only describes the raw member when no
        // earlier lane entry was deselected; a database fill always does.
        let member_lane_start = step.lane_position == 0
            && matches!(
                step.target,
                Some(BundlePatchInput::Rom {
                    member: Some(_),
                    ..
                })
            )
            && verification.is_some_and(|step| step.is_chain_prefix || step.lane_source_input);
        // An unbased bundle input check still describes the real
        // intermediate even when embedded evidence independently infers
        // Base. Only an explicit Base declaration verifies once up front.
        if context.strict_patch_checksums()
            && !(step_declares_base && step.explicit_input.is_none())
            && (step.lane_position > 0 || step.explicit_input.is_some() || member_lane_start)
            && let Some(declared) = verification.and_then(|step| step.declared_input.as_ref())
            && let Err(error) =
                Self::verify_chain_step_state(&state.current_input, declared, context)
        {
            let mut coded = ValidationCodeError::new("patch.chain.input_mismatch")
                .with_message("chain step input does not match the patch's declared input checks")
                .with_field("patch_index", step.index as u64)
                .with_field("patch", step.patch_path().display().to_string())
                .with_field("detail", error.to_string());
            super::super::bundle_apply::describe_expected_state(
                &declared.checksums,
                declared.size,
                &mut coded,
            );
            return Err(Box::new(OperationReport::failed_with_error(
                OperationFamily::Patch,
                Some(step.format().to_string()),
                "validate",
                RomWeaverError::ValidationCode(coded),
                context.single_thread_execution(),
            )));
        }
        Ok(())
    }

    /// Verify the step output against its declared checks and record it as
    /// its lane's, producer's, and disc track's latest bytes.
    fn record_chain_step_output(
        &self,
        inputs: &mut RunPatchApplyLoopInputs<'_>,
        state: &mut ChainLoopState,
        step: &ChainStep<'_>,
        is_last: bool,
        apply_output: PathBuf,
    ) -> std::result::Result<(), Box<OperationReport>> {
        let context = inputs.context;
        // A declared target-lane endpoint describes this raw lane output,
        // even when another lane runs later and owns the command output.
        // The legacy final step retains its finalized-output gate.
        self.verify_declared_chain_output(
            context,
            step.target,
            is_last,
            step.verification(),
            step.explicit_input,
            &apply_output,
        )
        .map_err(|error| {
            let mut coded = ValidationCodeError::new("patch.chain.output_mismatch")
                .with_message("chain step output does not match the patch's declared output checks")
                .with_field("patch_index", step.index as u64)
                .with_field("patch", step.patch_path().display().to_string())
                .with_field("detail", error.to_string());
            if let Some(declared) = step
                .verification()
                .and_then(|step| step.declared_output.as_ref())
            {
                super::super::bundle_apply::describe_expected_state(
                    &declared.checksums,
                    declared.size,
                    &mut coded,
                );
            }
            Box::new(OperationReport::failed_with_error(
                OperationFamily::Patch,
                Some(step.format().to_string()),
                "validate",
                RomWeaverError::ValidationCode(coded),
                context.single_thread_execution(),
            ))
        })?;

        state.current_input = apply_output;
        let output_state = ProducedPatchOutput {
            path: state.current_input.clone(),
            header_state: inputs.header_state.clone(),
            n64_order: *inputs.n64_order,
        };
        if let Some(target) = step.target {
            state
                .target_outputs
                .insert(target.clone(), output_state.clone());
        } else {
            state.legacy_output = output_state.clone();
        }
        if let Some(disc) = inputs.disc
            && let Some(source_track) =
                self.disc_target_path(disc, step.target).map_err(|error| {
                    Box::new(OperationReport::failed_with_error(
                        OperationFamily::Patch,
                        None,
                        "prepare",
                        error,
                        context.single_thread_execution(),
                    ))
                })?
        {
            state
                .disc_track_replacements
                .insert(source_track, output_state.path.clone());
        }
        if let Some(id) = step.apply_step.metadata.id.as_ref() {
            state.producer_outputs.insert(id.clone(), output_state);
        }
        Ok(())
    }

    /// Bake the database cheats that run after every patch: all of them when
    /// the cheats carry no positions, else those positioned at the end.
    fn apply_trailing_cheat_stage(
        &self,
        inputs: &mut RunPatchApplyLoopInputs<'_>,
        state: &mut ChainLoopState,
    ) -> std::result::Result<(), Box<OperationReport>> {
        if !state.ordered_cheats && !inputs.cheat_records.is_empty() {
            state.report = self.apply_database_cheat_stage(ApplyDatabaseCheatStageInputs {
                input: &state.current_input,
                output: inputs.staged_output,
                records: inputs.cheat_records,
                allow_conflicts: inputs.allow_cheat_conflicts,
                stage_index: state.stage_index,
                stage_count: state.patch_count,
                context: inputs.context,
            })?;
            return Ok(());
        }
        let positioned_records = cheat_records_at_position(
            inputs.cheat_records,
            &state.cheat_positions,
            state.normal_patch_count,
        );
        if !positioned_records.is_empty() {
            let apply_output = database_cheat_stage_output(
                state.stage_index,
                state.patch_count,
                inputs.staged_output,
                inputs.context,
                inputs.temp_paths,
            );
            state.report = self.apply_database_cheat_stage(ApplyDatabaseCheatStageInputs {
                input: &state.current_input,
                output: &apply_output,
                records: &positioned_records,
                allow_conflicts: inputs.allow_cheat_conflicts,
                stage_index: state.stage_index,
                stage_count: state.patch_count,
                context: inputs.context,
            })?;
        }
        Ok(())
    }
}
