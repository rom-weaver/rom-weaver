use super::shared::*;

#[test]
fn plan_extract_batch_groups_small_jobs_into_one_wave() {
    let json = run_single_json_event(
        &[
            "plan-extract-batch",
            "--job-size",
            "1048576",
            "--job-size",
            "1048576",
            "--threads",
            "8",
            "--total-memory-bytes",
            "1073741824",
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "plan-extract-batch");
    assert_eq!(json["family"], "container");
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("planned 2 job(s)")
    );

    let waves = json["details"]["extract_batch_plan"]["waves"]
        .as_array()
        .expect("waves array");
    assert_eq!(waves.len(), 1, "two small jobs should share one wave");
    let jobs = waves[0]["jobs"].as_array().expect("jobs array");
    assert_eq!(jobs.len(), 2);
    assert!(waves[0]["threads_per_job"].as_u64().expect("threads") >= 1);
}

#[test]
fn plan_extract_batch_splits_jobs_across_waves_under_a_tight_memory_ceiling() {
    let json = run_single_json_event(
        &[
            "plan-extract-batch",
            "--job-size",
            "104857600",
            "--job-size",
            "104857600",
            "--threads",
            "8",
            "--memory-ceiling-bytes",
            "314572800",
            "--json",
        ],
        0,
    );
    assert_eq!(json["status"], "succeeded");

    let waves = json["details"]["extract_batch_plan"]["waves"]
        .as_array()
        .expect("waves array");
    assert_eq!(
        waves.len(),
        2,
        "a tight memory ceiling should force the two 100MB jobs into separate waves"
    );
}

#[test]
fn plan_extract_batch_accepts_zero_jobs() {
    let json = run_single_json_event(&["plan-extract-batch", "--json"], 0);
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("planned 0 job(s)")
    );
    let waves = json["details"]["extract_batch_plan"]["waves"]
        .as_array()
        .expect("waves array");
    assert!(waves.is_empty());
}

#[test]
fn plan_extract_batch_rejects_an_invalid_threads_value() {
    command_stdout(
        &[
            "plan-extract-batch",
            "--job-size",
            "1024",
            "--threads",
            "not-a-number",
            "--json",
        ],
        2,
    );
}

#[test]
fn plan_extract_batch_rejects_a_zero_threads_value() {
    command_stdout(
        &[
            "plan-extract-batch",
            "--job-size",
            "1024",
            "--threads",
            "0",
            "--json",
        ],
        2,
    );
}
