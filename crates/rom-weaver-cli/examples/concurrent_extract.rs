//! Measurement harness for memory-/thread-aware concurrent extraction.
//!
//! Compare the concurrent batch executor against the serial baseline on real inputs:
//!
//! ```text
//! cargo run --release --example concurrent_extract -- --out-dir /tmp/out a.zip b.7z c.chd
//! cargo run --release --example concurrent_extract -- --sequential --out-dir /tmp/out a.zip b.7z c.chd
//! ```
//!
//! Each input extracts into its own `<out-dir>/<stem>/` subdir, so the jobs never collide. The
//! harness prints the planner's chosen waves and the total wall-clock, so the two modes can be
//! compared directly on your own large ROMs.

use std::{path::PathBuf, sync::Arc, time::Instant};

use rom_weaver_app::{ExtractBatchOptions, ExtractCommand, run_extract_batch};
use rom_weaver_core::{
    NoninteractivePrompter, NoopProgressSink, OperationStatus, ProgressSink, SelectionPrompter,
    ThreadBudget,
};

fn main() {
    let mut sources: Vec<PathBuf> = Vec::new();
    let mut out_dir = PathBuf::from("rom-weaver-batch-out");
    let mut threads = ThreadBudget::Auto;
    let mut sequential = false;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--out-dir" => out_dir = PathBuf::from(args.next().expect("--out-dir needs a path")),
            "--threads" => {
                let value = args.next().expect("--threads needs a value");
                threads = if value == "auto" {
                    ThreadBudget::Auto
                } else {
                    ThreadBudget::Fixed(
                        value
                            .parse()
                            .expect("--threads must be `auto` or a positive integer"),
                    )
                };
            }
            "--sequential" => sequential = true,
            other => sources.push(PathBuf::from(other)),
        }
    }

    if sources.is_empty() {
        eprintln!(
            "usage: concurrent_extract [--out-dir DIR] [--threads auto|N] [--sequential] <source>..."
        );
        std::process::exit(2);
    }

    let jobs: Vec<ExtractCommand> = sources
        .iter()
        .map(|source| {
            let stem = source
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("input");
            ExtractCommand {
                source: source.clone(),
                select: Vec::new(),
                rom_filter: false,
                patch_filter: false,
                out_dir: out_dir.join(stem),
                split_bin: false,
                no_ignore: false,
                no_nested_extract: false,
                no_overwrite: false,
                checksum: Vec::new(),
                // Overwritten per job by the executor's fair thread allotment.
                threads,
            }
        })
        .collect();

    let reporter: Arc<dyn ProgressSink> = Arc::new(NoopProgressSink);
    let prompter: Arc<dyn SelectionPrompter> = Arc::new(NoninteractivePrompter);

    println!(
        "extracting {} input(s) — mode={} threads={threads}",
        jobs.len(),
        if sequential {
            "sequential"
        } else {
            "concurrent"
        },
    );

    let started = Instant::now();
    let report = run_extract_batch(
        jobs,
        ExtractBatchOptions {
            emit_progress_events: false,
            interactive_selection_enabled: false,
            threads,
            sequential,
        },
        reporter,
        prompter,
    );
    let elapsed = started.elapsed();

    println!("planner waves (job indices): {:?}", report.waves);
    for (index, outcome) in report.outcomes.iter().enumerate() {
        let label = sources[index]
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("?");
        let status = if outcome.status == OperationStatus::Succeeded {
            "ok"
        } else {
            "FAILED"
        };
        println!("  [{index}] {label}: {status}");
    }

    let failures = report
        .outcomes
        .iter()
        .filter(|outcome| outcome.status != OperationStatus::Succeeded)
        .count();
    println!(
        "total wall-clock: {:.2}s ({failures} failed)",
        elapsed.as_secs_f64()
    );
    if failures > 0 {
        std::process::exit(1);
    }
}
