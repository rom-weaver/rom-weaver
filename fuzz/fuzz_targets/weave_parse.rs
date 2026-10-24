#![no_main]
use libfuzzer_sys::fuzz_target;
use rom_weaver_app::{WeaveChecks, WeavePatchInput, RomWeaverWeave, parse_weave_for_fuzzing};
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn assert_checks(checks: &WeaveChecks) {
    for (algorithm, hex) in &checks.checksums {
        assert_eq!(algorithm, &algorithm.trim().to_ascii_lowercase());
        assert!(!hex.is_empty() && hex.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(hex, &hex.to_ascii_lowercase());
        assert!(!hex.starts_with("0x"));
        if algorithm == "crc32" {
            assert_eq!(hex.len(), 8);
        }
    }
}

fn assert_weave(weave: &RomWeaverWeave) {
    assert!(matches!(weave.version, 1 | 2));
    assert!(!weave.patches.is_empty() || !weave.cheats.is_empty());
    let states: BTreeSet<_> = weave
        .check_states
        .iter()
        .map(|state| state.id.as_str())
        .collect();
    assert_eq!(states.len(), weave.check_states.len());
    for state in &weave.check_states {
        assert_checks(&state.checks);
    }
    let mut prior = BTreeSet::new();
    for patch in &weave.patches {
        assert!(
            patch.url.as_ref().is_some_and(|url| !url.trim().is_empty())
                ^ patch
                    .path
                    .as_ref()
                    .is_some_and(|path| !path.trim().is_empty())
        );
        if let Some(path) = &patch.path {
            let path = path.trim();
            if !path.is_empty() {
                assert!(!path.starts_with(['/', '\\']) && !path.contains(':'));
                assert!(!path.split(['/', '\\']).any(|part| part == ".."));
            }
        }
        for (checks, reference) in [
            (&patch.input_checks, &patch.input_checks_ref),
            (&patch.output_checks, &patch.output_checks_ref),
        ] {
            if let Some(checks) = checks {
                assert_checks(checks);
            }
            if let Some(reference) = reference {
                assert!(checks.is_none() && states.contains(reference.trim()));
            }
        }
        for selector in [&patch.input, &patch.target].into_iter().flatten() {
            let member = match selector {
                WeavePatchInput::Rom { rom, member } => {
                    assert!(*rom);
                    member
                }
                WeavePatchInput::Patch { patch, member } => {
                    assert!(prior.contains(patch.as_str()));
                    member
                }
            };
            if let Some(member) = member {
                assert!(!member.is_empty() && !member.starts_with('/') && !member.contains('\0'));
                assert!(!member.contains('\\'));
                assert!(
                    member
                        .split('/')
                        .all(|part| !part.is_empty() && part != "." && part != "..")
                );
            }
        }
        if let Some(id) = &patch.id {
            prior.insert(id.trim());
        }
    }
}

fn parse(value: &Value) -> rom_weaver_core::Result<RomWeaverWeave> {
    parse_weave_for_fuzzing(&serde_json::to_vec(value).unwrap())
}

fuzz_target!(|data: &[u8]| {
    if data.len() < 2 || data.len() > 4096 {
        return;
    }
    let count = usize::from(data[1] % 4 + 1);
    let crc = u32::from_le_bytes([
        data[0],
        data[1],
        *data.get(2).unwrap_or(&0),
        *data.get(3).unwrap_or(&0),
    ]);
    let mut patches = Vec::new();
    for index in 0..count {
        let input = if index == 0 {
            json!({"rom":true,"member":" ./roms\\base.bin "})
        } else {
            json!({"patch":format!("p{}",index-1),"member":"out.bin"})
        };
        patches.push(json!({"id":format!("p{index}"),"path":format!("patches/p{index}.ips"),"input":input,"inputChecksRef":"base","outputChecks":{"checksums":{"CRC32":format!("0X{crc:08X}")}}}));
    }
    let valid = json!({"version":2,"patchBasis":"auto","checkStates":[{"id":" base ","checks":{"checksums":{"CRC32":format!("0x{crc:08X}")}}}],"patches":patches});
    let parsed = parse(&valid).expect("generated valid weave reaches production validation");
    assert_weave(&parsed);
    assert_eq!(parsed.patches.len(), count);
    assert_eq!(parsed.check_states[0].id, "base");
    assert_eq!(
        parsed.check_states[0].checks.checksums["crc32"],
        format!("{crc:08x}")
    );
    assert_eq!(
        parsed.patches[0].input,
        Some(WeavePatchInput::Rom {
            rom: true,
            member: Some("roms/base.bin".into())
        })
    );
    let rendered = serde_json::to_vec(&parsed).unwrap();
    assert_eq!(parse_weave_for_fuzzing(&rendered).unwrap(), parsed);
    let mut malformed = valid.clone();
    match data[0] % 10 {
        0 => malformed["patches"][0]["path"] = json!("../outside.ips"),
        1 => malformed["patches"][0]["url"] = json!("https://example.invalid/x.ips"),
        2 => malformed["patches"][0]["input"]["member"] = json!("safe/../../outside.bin"),
        3 => malformed["patches"][0]["inputChecksRef"] = json!("missing"),
        4 => malformed["version"] = json!(3),
        5 => malformed["patches"][0]["input"] = json!({"patch":"p0"}),
        6 => malformed["checkStates"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"base","checks":{"size":0}})),
        7 => malformed["checkStates"][0]["checks"]["checksums"]["CRC32"] = json!("0x123"),
        8 => {
            malformed.as_object_mut().unwrap().remove("patchBasis");
        }
        _ => malformed["patches"] = json!([]),
    }
    assert!(
        parse(&malformed).is_err(),
        "invalid graph/source/path/checksum must be rejected"
    );
    let mut bytes = serde_json::to_vec(&valid).unwrap();
    for mutation in data[2..].chunks(3) {
        if mutation.len() == 3 {
            let offset = usize::from(u16::from_le_bytes([mutation[0], mutation[1]])) % bytes.len();
            bytes[offset] ^= mutation[2];
        }
    }
    if let Ok(weave) = parse_weave_for_fuzzing(&bytes) {
        assert_weave(&weave);
    }
    let truncation = usize::from(data[0]) % rendered.len();
    assert!(parse_weave_for_fuzzing(&rendered[..truncation]).is_err());
});
