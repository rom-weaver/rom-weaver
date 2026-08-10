use super::*;

fn state(pairs: &[(&str, &str)], size: Option<u64>) -> patch_plan::PlanState {
    patch_plan::PlanState {
        checksums: pairs
            .iter()
            .map(|(algorithm, hex)| ((*algorithm).to_string(), (*hex).to_string()))
            .collect(),
        size,
    }
}

#[test]
fn hashable_algorithms_collects_every_algorithm_a_candidate_pins() {
    // RUP pins md5, PMSR crc32. Hashing has to follow whatever the patch
    // offers, which is the whole point of not hardcoding crc32.
    let required = vec![
        state(&[("md5", "0".repeat(32).as_str())], Some(64)),
        state(&[("crc32", "deadbeef"), ("sha1", &"1".repeat(40))], None),
    ];

    assert_eq!(
        hashable_algorithms(&required),
        vec!["md5".to_string(), "crc32".to_string(), "sha1".to_string()]
    );
}

#[test]
fn hashable_algorithms_drops_an_algorithm_the_engine_cannot_compute() {
    // A format could name a check the checksum engine has no implementation
    // for. Asking for it would fail the whole comparison, so it is dropped and
    // the rest still decides.
    let required = vec![state(
        &[("crc32", "deadbeef"), ("fletcher16", "1234")],
        None,
    )];

    assert_eq!(hashable_algorithms(&required), vec!["crc32".to_string()]);
}

#[test]
fn a_size_only_candidate_never_proves_a_basis() {
    // APS GBA and DPS pin an exact source size and nothing else. Two ROMs of
    // one length are not one ROM, so a size on its own must not decide which
    // bytes a patch was authored against.
    let required = vec![state(&[], Some(65536))];
    let headerless = state(&[("crc32", "deadbeef")], Some(65536));

    assert!(first_matching_state(&required, &headerless).is_none());
}

#[test]
fn a_matching_checksum_proves_the_candidate_it_matches() {
    let required = vec![state(&[("md5", &"ab".repeat(16))], Some(65536))];
    let raw = state(&[("md5", &"cd".repeat(16))], Some(66048));
    let headerless = state(&[("md5", &"ab".repeat(16))], Some(65536));

    assert!(first_matching_state(&required, &raw).is_none());
    assert!(first_matching_state(&required, &headerless).is_some());
}

#[test]
fn a_disagreeing_size_blocks_a_checksum_match() {
    // PMSR pins one exact whole-file size beside its CRC32. A candidate of a
    // different length is a different file whatever the checksum column says.
    let required = vec![state(&[("crc32", "deadbeef")], Some(41_943_040))];
    let candidate = state(&[("crc32", "deadbeef")], Some(65536));

    assert!(first_matching_state(&required, &candidate).is_none());
}
