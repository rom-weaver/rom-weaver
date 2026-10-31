//! Memory- and thread-aware concurrent extraction of several independent inputs in one process.
//!
//! Uses the shared batch planner to group jobs by memory and split the thread
//! budget evenly across each concurrent wave. Native runs those waves on scoped
//! threads; the browser drives the same plan through its worker pool.

use super::*;
use crate::extract_batch_plan::plan_extract_batch;

/// Stack size for each per-job thread. The single-extract path runs on the process main thread
/// (≈8 MiB) or rayon workers (also sized up) in the normal CLI; a default ≈2 MiB spawned-thread
/// stack overflows it (libarchive setup + nested-extract recursion), so size job threads to match
/// with margin.
const JOB_THREAD_STACK_BYTES: usize = 16 * 1024 * 1024;

/// Tuning for a batch extraction run.
pub struct ExtractBatchOptions {
    pub emit_progress_events: bool,
    pub interactive_selection_enabled: bool,
    /// Total worker-thread budget shared across concurrent jobs.
    pub threads: ThreadBudget,
    /// Force one-job-at-a-time execution (concurrency cap 1). The A/B baseline for measuring the
    /// concurrent path against today's serial behaviour.
    pub sequential: bool,
}

/// Result of a batch extraction: each job's outcome in input order, plus the concurrent waves the
/// planner chose (job indices), so a caller can report how the work was actually split.
pub struct ExtractBatchReport {
    pub outcomes: Vec<AppRunOutcome>,
    pub waves: Vec<Vec<usize>>,
}

/// Build the app and run a batch of extractions with memory- and thread-aware
/// concurrency. This native-only module schedules concurrent OS threads; the
/// browser applies the same plan to its command worker pool.
pub fn run_extract_batch(
    jobs: Vec<ExtractCommand>,
    options: ExtractBatchOptions,
    reporter: Arc<dyn ProgressSink>,
    prompter: Arc<dyn SelectionPrompter>,
) -> ExtractBatchReport {
    let app = CliApp::new(
        reporter,
        prompter,
        options.emit_progress_events,
        options.interactive_selection_enabled,
        false,
    );
    app.run_extract_batch(jobs, options.threads, options.sequential)
}

impl CliApp {
    pub(super) fn run_extract_batch(
        &self,
        jobs: Vec<ExtractCommand>,
        threads: ThreadBudget,
        sequential: bool,
    ) -> ExtractBatchReport {
        let job_count = jobs.len();
        let budget_threads = threads.requested_threads().max(1);
        // A lone extract gets the whole budget; otherwise jobs pack up to the budget and the memory
        // ceiling decides how many large ones may coexist. Native reads each source's real size and
        // delegates to the shared planner (also driven by the wasm `plan-extract-batch` command).
        let max_concurrency = if sequential { 1 } else { budget_threads };
        let job_sizes: Vec<u64> = jobs
            .iter()
            .map(|job| {
                std::fs::metadata(&job.input)
                    .map(|meta| meta.len())
                    .unwrap_or(0)
            })
            .collect();
        let plan = plan_extract_batch(&job_sizes, budget_threads, max_concurrency, None, None);
        trace!(
            job_count,
            budget_threads,
            sequential,
            wave_count = plan.waves.len(),
            "planned extract batch"
        );

        // Take each job out of `pending` exactly once as its wave is scheduled; results land in
        // input order via the index carried alongside each command.
        // Concurrent jobs may share a missing parent directory. Create those parents once here so
        // a failing job's cleanup only ever removes its own output directory, then drop any that
        // are still empty once every job has finished.
        let mut shared_parents: Vec<PathBuf> = Vec::new();
        if job_count > 1 {
            for job in &jobs {
                let Some(parent) = job.output.parent() else {
                    continue;
                };
                // Record before creating, so a partially failed create is still cleaned up.
                shared_parents.extend(crate::extract_command::missing_dirs_to_create(parent));
                if let Err(error) = std::fs::create_dir_all(parent) {
                    debug!(path = %parent.display(), %error, "could not pre-create shared extract parent");
                }
            }
            // A job's own output directory is that job's to keep or clean up.
            shared_parents.retain(|dir| jobs.iter().all(|job| job.output != *dir));
        }
        let mut pending: Vec<Option<ExtractCommand>> = jobs.into_iter().map(Some).collect();
        let mut outcomes: Vec<Option<AppRunOutcome>> = (0..job_count).map(|_| None).collect();

        for (wave_index, wave) in plan.waves.iter().enumerate() {
            let per_job_threads = wave.threads_per_job;
            trace!(
                wave = wave_index,
                jobs = wave.jobs.len(),
                per_job_threads,
                "running extract wave"
            );
            let wave_jobs: Vec<(usize, ExtractCommand)> = wave
                .jobs
                .iter()
                .map(|&index| {
                    let mut command = pending[index].take().expect("each job is scheduled once");
                    // The plan already split the budget evenly across this wave so the pools sum to
                    // the budget instead of each grabbing all of it.
                    command.threads = ThreadBudget::Fixed(per_job_threads);
                    (index, command)
                })
                .collect();

            // Each job MUST own its warnings while sharing the batch's output sink.
            let wave_results: Vec<(usize, AppRunOutcome)> = std::thread::scope(|scope| {
                let handles: Vec<_> = wave_jobs
                    .into_iter()
                    .map(|(index, command)| {
                        let app = Self::new_with_dry_run(
                            self.reporter.clone(),
                            self.prompter.clone(),
                            self.emit_progress_events,
                            self.interactive_selection_enabled,
                            self.assume_yes,
                            self.dry_run,
                        );
                        std::thread::Builder::new()
                            .name(format!("extract-job-{index}"))
                            .stack_size(JOB_THREAD_STACK_BYTES)
                            .spawn_scoped(scope, move || (index, app.run_extract(command)))
                            .expect("spawn extract job thread")
                    })
                    .collect();
                handles
                    .into_iter()
                    .map(|handle| handle.join().expect("extract job thread panicked"))
                    .collect()
            });
            for (index, outcome) in wave_results {
                outcomes[index] = Some(outcome);
            }
        }

        // Deepest first, so a nested parent goes before its own parent.
        shared_parents.sort();
        shared_parents.dedup();
        shared_parents.sort_by_key(|dir| std::cmp::Reverse(dir.components().count()));
        crate::extract_command::remove_created_empty_dirs(&shared_parents);

        ExtractBatchReport {
            outcomes: outcomes
                .into_iter()
                .map(|outcome| {
                    outcome.unwrap_or(AppRunOutcome {
                        status: OperationStatus::Failed,
                        exit_code: 1,
                    })
                })
                .collect(),
            waves: plan.waves.iter().map(|wave| wave.jobs.clone()).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ExtractBatchOptions, run_extract_batch};
    use crate::{
        AppRunOptions, Commands, CompressCommand, CompressionLevelProfile, ExtractCommand,
        RomWeaverApp,
    };
    use rom_weaver_core::{
        NoninteractivePrompter, NoopProgressSink, OperationStatus, ProgressSink, SelectionPrompter,
        ThreadBudget,
    };
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::Arc,
    };

    fn silent() -> (Arc<dyn ProgressSink>, Arc<dyn SelectionPrompter>) {
        (Arc::new(NoopProgressSink), Arc::new(NoninteractivePrompter))
    }

    // No tempfile dev-dep in this crate; derive a unique dir from pid + an atomic counter so parallel
    // test runs never collide. The guard removes it on success, failed assertion, and panic.
    struct WorkDir(PathBuf);

    impl std::ops::Deref for WorkDir {
        type Target = Path;

        fn deref(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for WorkDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn unique_work_dir() -> WorkDir {
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("rw-extract-batch-{}-{unique}", std::process::id()));
        fs::create_dir_all(&dir).expect("create work dir");
        WorkDir(dir)
    }

    // Build a real zip containing `<stem>.bin` via the app's own compress command.
    fn make_zip(work: &Path, stem: &str, content: &[u8]) -> PathBuf {
        let input = work.join(format!("{stem}.bin"));
        fs::write(&input, content).expect("write fixture input");
        let archive = work.join(format!("{stem}.zip"));
        let (reporter, prompter) = silent();
        let outcome = RomWeaverApp::run(
            Commands::Compress(CompressCommand {
                rvz_block_size: None,
                input: vec![input],
                entry_names: Vec::new(),
                format: Some("zip".to_string()),
                output: archive.clone(),
                codec: Vec::new(),
                level: CompressionLevelProfile::default(),
                force: false,
                dry_run: false,
                threads: ThreadBudget::Fixed(1),
            }),
            AppRunOptions {
                assume_yes: false,
                emit_progress_events: false,
                interactive_selection_enabled: false,
                dry_run: false,
            },
            reporter,
            prompter,
        );
        assert_eq!(
            outcome.status,
            OperationStatus::Succeeded,
            "compress fixture `{stem}` should succeed"
        );
        archive
    }

    fn extract_jobs(archives: &[PathBuf], stems: &[&str], out: &Path) -> Vec<ExtractCommand> {
        archives
            .iter()
            .zip(stems.iter().copied())
            .map(|(archive, stem)| ExtractCommand {
                input: archive.clone(),
                select: Vec::new(),
                filter: Vec::new(),
                output: out.join(stem),
                split_bin: false,
                no_ignore: false,
                no_nested_extract: false,
                // Batch waves write into per-job output dirs; keep the old
                // overwrite-allowed behavior the pre-`--force` default had.
                force: true,
                checksum: Vec::new(),
                checksum_rom: Vec::new(),
                probe: false,
                threads: ThreadBudget::Auto,
            })
            .collect()
    }

    #[test]
    fn failed_concurrent_jobs_leave_no_shared_parent_and_successes_keep_it() {
        let work = unique_work_dir();
        let broken: Vec<PathBuf> = ["one", "two", "three"]
            .iter()
            .map(|stem| {
                let path = work.join(format!("{stem}.xyz"));
                fs::write(&path, b"not an archive").expect("fixture");
                path
            })
            .collect();
        let run = |archives: &[PathBuf], out: &Path| {
            let (reporter, prompter) = silent();
            run_extract_batch(
                extract_jobs(archives, &["one", "two", "three"], out),
                ExtractBatchOptions {
                    emit_progress_events: false,
                    interactive_selection_enabled: false,
                    threads: ThreadBudget::Fixed(4),
                    sequential: false,
                },
                reporter,
                prompter,
            )
        };

        let all_failed = work.join("missing-parent").join("out");
        let report = run(&broken, &all_failed);
        assert!(
            report
                .outcomes
                .iter()
                .all(|outcome| outcome.status != OperationStatus::Succeeded)
        );
        assert!(
            !work.join("missing-parent").exists(),
            "failed batch must not leave shared parents"
        );

        let mixed_parent = work.join("mixed-parent").join("out");
        let good = make_zip(&work, "good", b"good payload");
        let mixed = vec![good, broken[1].clone(), broken[2].clone()];
        let report = run(&mixed, &mixed_parent);
        assert_eq!(report.outcomes[0].status, OperationStatus::Succeeded);
        assert!(mixed_parent.join("one").exists(), "successful output stays");
        assert!(!mixed_parent.join("two").exists() && !mixed_parent.join("three").exists());
    }

    #[test]
    fn concurrent_batch_matches_sequential_and_originals() {
        let work = unique_work_dir();
        let fixtures: [(&str, Vec<u8>); 3] = [
            ("alpha", b"alpha payload ".repeat(4096)),
            ("bravo", b"bravo distinct bytes ".repeat(2048)),
            ("charlie", (0u8..=255).cycle().take(300_000).collect()),
        ];
        let stems: Vec<&str> = fixtures.iter().map(|(stem, _)| *stem).collect();
        let archives: Vec<PathBuf> = fixtures
            .iter()
            .map(|(stem, bytes)| make_zip(&work, stem, bytes))
            .collect();

        let run = |sequential: bool, tag: &str| {
            let out = work.join(tag);
            let (reporter, prompter) = silent();
            let report = run_extract_batch(
                extract_jobs(&archives, &stems, &out),
                ExtractBatchOptions {
                    emit_progress_events: false,
                    interactive_selection_enabled: false,
                    threads: ThreadBudget::Fixed(4),
                    sequential,
                },
                reporter,
                prompter,
            );
            (out, report)
        };

        let (concurrent_out, concurrent) = run(false, "out-concurrent");
        let (sequential_out, sequential) = run(true, "out-sequential");

        assert!(
            concurrent
                .outcomes
                .iter()
                .all(|outcome| outcome.status == OperationStatus::Succeeded),
            "every concurrent job should succeed"
        );
        assert!(
            sequential
                .outcomes
                .iter()
                .all(|outcome| outcome.status == OperationStatus::Succeeded),
            "every sequential job should succeed"
        );
        // Sequential isolates each job (one wave apiece); concurrent overlaps the light jobs.
        assert_eq!(sequential.waves.len(), fixtures.len());
        assert!(
            concurrent.waves.len() < sequential.waves.len(),
            "concurrent should overlap jobs into fewer waves: {:?}",
            concurrent.waves
        );

        for (stem, original) in &fixtures {
            let concurrent_bytes = fs::read(concurrent_out.join(*stem).join(format!("{stem}.bin")))
                .expect("concurrent output present");
            let sequential_bytes = fs::read(sequential_out.join(*stem).join(format!("{stem}.bin")))
                .expect("sequential output present");
            assert_eq!(
                &concurrent_bytes, original,
                "`{stem}` concurrent extract must match the original bytes"
            );
            assert_eq!(
                concurrent_bytes, sequential_bytes,
                "`{stem}` concurrent extract must match the sequential extract"
            );
        }
    }
}
