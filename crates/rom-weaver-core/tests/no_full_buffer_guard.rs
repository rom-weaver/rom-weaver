use std::{fs, path::PathBuf};

#[derive(Clone, Copy)]
struct GuardTarget {
    relative_path: &'static str,
    forbidden: &'static [&'static str],
    allowlist_fragments: &'static [&'static str],
}

#[test]
fn migrated_payload_paths_avoid_full_buffer_reads() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("resolve repo root");

    let targets = [
        GuardTarget {
            relative_path: "crates/rom-weaver-codecs/src/backend.rs",
            forbidden: &["fs::read(", "read_to_end("],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-containers/src/handlers/sevenz.rs",
            forbidden: &["fs::read(", "read_to_end("],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-containers/src/handlers/rvz.rs",
            forbidden: &["fs::read(", "read_to_end("],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-app/src/header_detection_and_finalize.rs",
            forbidden: &["fs::read(", "read_to_end("],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-app/src/header_repair.rs",
            forbidden: &["fs::read(", "read_to_end(", "let mut bytes = Vec::new();"],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-app/src/trim_and_probe_details.rs",
            forbidden: &["fs::read("],
            allowlist_fragments: &["let mut bytes = fs::read(source)?;"],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/pat.rs",
            forbidden: &["fs::read(", "read_to_end("],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/pat.rs",
            forbidden: &[
                "map_file_read_only(original_path)",
                "map_file_read_only(modified_path)",
            ],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/gdiff.rs",
            forbidden: &["map_file_read_only(modified_path)"],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/apsgba.rs",
            forbidden: &[
                "map_file_read_only(&request.input)",
                "map_file_read_only(source_path)",
                "map_file_read_only(target_path)",
            ],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/apsgba.rs",
            forbidden: &["map_file_read_only(path)"],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/aps_n64.rs",
            forbidden: &[
                "map_file_read_only(&request.original)",
                "map_file_read_only(&request.modified)",
            ],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/aps_n64.rs",
            forbidden: &["map_file_read_only(path)"],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/bdf.rs",
            forbidden: &[
                "map_file_read_only(patch_path)",
                "map_file_read_only(&request.input)",
                "map_file_read_only(&request.original)",
                "map_file_read_only(&request.modified)",
            ],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/dldi.rs",
            forbidden: &["map_file_read_only(&request.input)"],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/dldi.rs",
            forbidden: &["map_file_read_only(patch_path)"],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/dps.rs",
            forbidden: &["map_file_read_only(patch_path)"],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/ppf.rs",
            forbidden: &["map_file_read_only(patch_path)"],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/pmsr.rs",
            forbidden: &["map_file_read_only(path)"],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/rup.rs",
            forbidden: &["map_file_read_only(path)"],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/hdiffpatch.rs",
            forbidden: &[
                "map_file_read_only(patch_path)",
                "map_file_read_only(&request.input)",
            ],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/solid.rs",
            forbidden: &["map_file_read_only(&request.input)"],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/solid.rs",
            forbidden: &["map_file_read_only(patch_path)"],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/solid.rs",
            forbidden: &[
                "map_file_read_only(&request.original)",
                "map_file_read_only(&request.modified)",
            ],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-xdelta/src/vcdiff/core.rs",
            forbidden: &["fs::read(", "read_to_end("],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/ips.rs",
            forbidden: &["map_file_read_only(path)"],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/ups.rs",
            forbidden: &["map_file_read_only(path)"],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/bps.rs",
            forbidden: &["map_file_read_only(path)"],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/bsp.rs",
            forbidden: &[
                "fs::read(",
                "read_to_end(",
                "map_file_read_only(patch_path)",
                "map_file_read_only(&request.input)",
            ],
            allowlist_fragments: &["Ok(fs::read(&temp_path)?)"],
        },
        GuardTarget {
            relative_path: "crates/rom-weaver-patches/src/lib.rs",
            forbidden: &[
                "fs::read(",
                "read_to_end(",
                "map_file_read_only(",
                "ReadOnlyFile",
            ],
            allowlist_fragments: &[],
        },
        GuardTarget {
            relative_path: "packages/rom-weaver-react/src/wasm/browser-opfs-mounts.ts",
            forbidden: &["new wasiShim.File(new Uint8Array())"],
            allowlist_fragments: &[],
        },
    ];

    for target in targets {
        let path = repo_root.join(target.relative_path);
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));

        for (line_index, line) in source.lines().enumerate() {
            let is_allowlisted = target
                .allowlist_fragments
                .iter()
                .any(|fragment| line.contains(fragment));
            if is_allowlisted {
                continue;
            }

            for forbidden in target.forbidden {
                assert!(
                    !line.contains(forbidden),
                    "forbidden pattern `{forbidden}` found in {}:{}\n{}",
                    target.relative_path,
                    line_index + 1,
                    line.trim()
                );
            }
        }
    }
}
