//! Unit coverage for the GameCube/Wii file system table (`src/nod/disc/fst.rs`):
//! node field packing, FST parsing and lookup, path iteration, and the
//! `FstBuilder` serializer.

use super::*;

/// Owns FST bytes in a 4-byte-aligned allocation. `Fst::new` casts the buffer
/// to `[Node]`, which is `repr(align(4))`, so a plain `Vec<u8>` MUST NOT be
/// used: an unaligned allocation makes the parse fail instead of the case
/// under test.
struct AlignedFst {
    words: Vec<u32>,
    len: usize,
}

impl AlignedFst {
    fn new(nodes: &[Node], string_table: &[u8]) -> Self {
        let node_bytes = nodes.as_bytes();
        let len = node_bytes.len() + string_table.len();
        let mut words = vec![0u32; len.div_ceil(4)];
        {
            let bytes = words.as_mut_bytes();
            bytes[..node_bytes.len()].copy_from_slice(node_bytes);
            bytes[node_bytes.len()..len].copy_from_slice(string_table);
        }
        Self { words, len }
    }

    fn as_slice(&self) -> &[u8] {
        &self.words.as_bytes()[..self.len]
    }
}

/// Three files across two nested directories plus one file at the root, added
/// in the sequential order `FstBuilder` requires.
fn sample_fst_bytes() -> Box<[u8]> {
    let mut builder = FstBuilder::new(false);
    builder.add_file("dir/a.txt", 0x1000, 4);
    builder.add_file("dir/sub/b.bin", 0x2000, 8);
    builder.add_file("root.txt", 0x3000, 16);
    builder.finalize()
}

#[test]
fn node_new_packs_kind_name_offset_and_sizes() {
    let file = Node::new(NodeKind::File, 0x0102_0304, 0x1000, 0x40, false);
    assert_eq!(file.kind(), NodeKind::File);
    assert!(file.is_file());
    assert!(!file.is_dir());
    // Only the low 24 bits of the name offset survive the u24 field.
    assert_eq!(file.name_offset(), 0x0002_0304);
    assert_eq!(file.offset(false), 0x1000);
    assert_eq!(file.length(), 0x40);

    let dir = Node::new(NodeKind::Directory, 7, 3, 9, false);
    assert_eq!(dir.kind(), NodeKind::Directory);
    assert!(dir.is_dir());
    assert!(!dir.is_file());
    assert_eq!(dir.offset(false), 3);

    let invalid = Node::new(NodeKind::Invalid, 0, 0, 0, false);
    assert_eq!(invalid.kind(), NodeKind::Invalid);
    assert!(!invalid.is_file());
    assert!(!invalid.is_dir());
}

#[test]
fn node_offsets_are_shifted_for_wii_files_only() {
    let file = Node::new(NodeKind::File, 0, 0x8000, 0x10, true);
    assert_eq!(file.offset(true), 0x8000);
    // The raw field stores offset / 4, so reading it as GameCube shows the shift.
    assert_eq!(file.offset(false), 0x2000);

    let dir = Node::new(NodeKind::Directory, 0, 12, 20, true);
    assert_eq!(dir.offset(true), 12);
    assert_eq!(dir.offset(false), 12);
}

#[test]
fn node_setters_round_trip_every_field() {
    let mut node = Node::new(NodeKind::File, 0, 0, 0, false);

    node.set_kind(NodeKind::Directory);
    assert_eq!(node.kind(), NodeKind::Directory);
    node.set_kind(NodeKind::Invalid);
    assert_eq!(node.kind(), NodeKind::Invalid);
    node.set_kind(NodeKind::File);
    assert_eq!(node.kind(), NodeKind::File);

    node.set_name_offset(0xAB_CDEF);
    assert_eq!(node.name_offset(), 0xAB_CDEF);

    node.set_offset(0x2_0000, true);
    assert_eq!(node.offset(true), 0x2_0000);
    node.set_offset(0x1234, false);
    assert_eq!(node.offset(false), 0x1234);

    node.set_length(0xDEAD);
    assert_eq!(node.length(), 0xDEAD);

    // A directory node ignores the Wii shift in both directions.
    node.set_kind(NodeKind::Directory);
    node.set_offset(9, true);
    assert_eq!(node.offset(true), 9);
}

#[test]
fn fst_new_rejects_a_buffer_shorter_than_the_root_node() {
    let buf = [0u8; 4];
    let Err(err) = Fst::new(&buf) else {
        panic!("expected a parse error");
    };
    assert_eq!(err, "FST root node not found");
}

#[test]
fn fst_new_rejects_a_string_table_past_the_end_of_the_buffer() {
    // Root claims 8 nodes (96 bytes of node table) but only one node is present.
    let root = Node::new(NodeKind::Directory, 0, 0, 8, false);
    let fst = AlignedFst::new(&[root], b"\0");
    let Err(err) = Fst::new(fst.as_slice()) else {
        panic!("expected a parse error");
    };
    assert_eq!(err, "FST string table out of bounds");
}

#[test]
fn fst_parses_nodes_and_string_table() {
    let data = sample_fst_bytes();
    let fst = Fst::new(&data).expect("parse FST");

    assert_eq!(fst.nodes.len(), 6);
    assert_eq!(fst.num_files(), 3);
    assert_eq!(fst.nodes[0].kind(), NodeKind::Directory);
    assert_eq!(fst.nodes[0].length(), 6);
    assert_eq!(fst.get_name(fst.nodes[0]).expect("root name"), "<root>");
    assert_eq!(fst.string_table.len(), data.len() - size_of_val(fst.nodes));
}

#[test]
fn fst_iter_yields_full_paths_for_every_node() {
    let data = sample_fst_bytes();
    let fst = Fst::new(&data).expect("parse FST");

    let entries = fst
        .iter()
        .map(|(idx, node, path)| (idx, node.is_dir(), path))
        .collect::<Vec<_>>();
    assert_eq!(
        entries,
        vec![
            (1, true, "dir".to_string()),
            (2, false, "dir/a.txt".to_string()),
            (3, true, "dir/sub".to_string()),
            (4, false, "dir/sub/b.bin".to_string()),
            (5, false, "root.txt".to_string()),
        ]
    );
}

#[test]
fn fst_iter_falls_back_to_a_placeholder_for_an_unreadable_name() {
    let root = Node::new(NodeKind::Directory, 0, 0, 2, false);
    // Name offset 1 points past the end of the string table.
    let file = Node::new(NodeKind::File, 1, 0, 0, false);
    let fst_bytes = AlignedFst::new(&[root, file], b"\0");
    let fst = Fst::new(fst_bytes.as_slice()).expect("parse FST");

    let (_, _, path) = fst.iter().next().expect("one node");
    assert_eq!(path, "<invalid>");
}

#[test]
fn fst_find_resolves_root_files_and_nested_paths() {
    let data = sample_fst_bytes();
    let fst = Fst::new(&data).expect("parse FST");

    let (root_idx, root) = fst.find("").expect("root node");
    assert_eq!(root_idx, 0);
    assert!(root.is_dir());
    assert_eq!(fst.find("/").expect("root via slash").0, 0);

    let (idx, node) = fst.find("/dir/a.txt").expect("nested file");
    assert_eq!(idx, 2);
    assert_eq!(node.offset(false), 0x1000);
    assert_eq!(node.length(), 4);

    let (idx, node) = fst.find("dir/sub/b.bin").expect("deeply nested file");
    assert_eq!(idx, 4);
    assert_eq!(node.length(), 8);

    let (idx, node) = fst.find("root.txt").expect("root file");
    assert_eq!(idx, 5);
    assert_eq!(node.offset(false), 0x3000);

    let (idx, node) = fst.find("/dir/sub").expect("directory");
    assert_eq!(idx, 3);
    assert!(node.is_dir());
}

#[test]
fn fst_find_ignores_case_and_empty_path_segments() {
    let data = sample_fst_bytes();
    let fst = Fst::new(&data).expect("parse FST");

    assert_eq!(fst.find("DIR/A.TXT").expect("case insensitive").0, 2);
    assert_eq!(fst.find("//dir///sub//b.bin//").expect("empty parts").0, 4);
}

#[test]
fn fst_find_returns_none_for_missing_entries() {
    let data = sample_fst_bytes();
    let fst = Fst::new(&data).expect("parse FST");

    assert!(fst.find("dir/missing.txt").is_none());
    assert!(fst.find("nope").is_none());
    // Descending into a file is not a valid path.
    assert!(fst.find("root.txt/child").is_none());
}

#[test]
fn fst_get_name_reports_an_out_of_bounds_name_offset() {
    let root = Node::new(NodeKind::Directory, 0, 0, 2, false);
    let file = Node::new(NodeKind::File, 64, 0, 0, false);
    let fst_bytes = AlignedFst::new(&[root, file], b"\0a.txt\0");
    let fst = Fst::new(fst_bytes.as_slice()).expect("parse FST");

    let err = fst.get_name(fst.nodes[1]).unwrap_err();
    assert!(
        err.contains("name offset 64 out of bounds"),
        "unexpected error: {err}"
    );
}

#[test]
fn fst_get_name_reports_a_name_that_is_not_null_terminated() {
    let root = Node::new(NodeKind::Directory, 0, 0, 2, false);
    let file = Node::new(NodeKind::File, 1, 0, 0, false);
    let fst_bytes = AlignedFst::new(&[root, file], b"\0abc");
    let fst = Fst::new(fst_bytes.as_slice()).expect("parse FST");

    let err = fst.get_name(fst.nodes[1]).unwrap_err();
    assert!(
        err.contains("not null-terminated"),
        "unexpected error: {err}"
    );
}

#[test]
fn fst_get_name_decodes_shift_jis() {
    let mut builder = FstBuilder::new(false);
    // U+3042 HIRAGANA LETTER A is 0x82 0xA0 in Shift-JIS, not valid UTF-8.
    builder.add_file("\u{3042}.txt", 0, 0);
    let data = builder.finalize();
    let fst = Fst::new(&data).expect("parse FST");

    assert_eq!(fst.get_name(fst.nodes[1]).expect("name"), "\u{3042}.txt");
    assert!(data.windows(2).any(|w| w == [0x82, 0xA0]));
}

#[test]
fn fst_builder_lays_out_directories_and_reuses_string_table_entries() {
    let mut builder = FstBuilder::new(false);
    builder.add_file("dir/a.txt", 0x1000, 4);
    builder.add_file("dir/sub/b.bin", 0x2000, 8);
    builder.add_file("root.txt", 0x3000, 16);
    let byte_size = builder.byte_size();
    let data = builder.finalize();
    assert_eq!(data.len(), byte_size);

    let fst = Fst::new(&data).expect("parse FST");
    // Directory length is the end index of its subtree.
    assert_eq!(fst.nodes[1].length(), 5);
    assert_eq!(fst.nodes[3].length(), 5);
    // A directory's offset is the index of its parent node.
    assert_eq!(fst.nodes[1].offset(false), 0);
    assert_eq!(fst.nodes[3].offset(false), 1);

    let mut with_duplicate = FstBuilder::new(false);
    with_duplicate.add_file("dir/name.bin", 0, 0);
    with_duplicate.add_file("dir2/name.bin", 0, 0);
    let dup = with_duplicate.finalize();
    let dup_fst = Fst::new(&dup).expect("parse FST");
    let name_nodes = dup_fst
        .nodes
        .iter()
        .filter(|n| n.is_file())
        .map(|n| n.name_offset())
        .collect::<Vec<_>>();
    assert_eq!(name_nodes.len(), 2);
    assert_eq!(name_nodes[0], name_nodes[1]);
}

#[test]
fn fst_builder_closes_a_directory_when_the_next_path_switches_away() {
    let mut builder = FstBuilder::new(false);
    builder.add_file("dirA/x", 0x1000, 1);
    builder.add_file("dirB/y", 0x2000, 2);
    let data = builder.finalize();
    let fst = Fst::new(&data).expect("parse FST");

    let paths = fst.iter().map(|(_, _, p)| p).collect::<Vec<_>>();
    assert_eq!(paths, vec!["dirA", "dirA/x", "dirB", "dirB/y"]);
    assert_eq!(fst.nodes[1].length(), 3);
    assert_eq!(fst.nodes[3].length(), 5);
}

#[test]
fn fst_builder_stores_wii_file_offsets_shifted() {
    let mut builder = FstBuilder::new(true);
    builder.add_file("a.bin", 0x8000, 0x20);
    let data = builder.finalize();
    let fst = Fst::new(&data).expect("parse FST");

    assert_eq!(fst.nodes[1].offset(true), 0x8000);
    assert_eq!(fst.nodes[1].offset(false), 0x2000);
}

#[test]
fn fst_builder_with_string_table_keeps_the_existing_ordering() {
    let original = sample_fst_bytes();
    let original_fst = Fst::new(&original).expect("parse FST");
    let string_table = Vec::from(original_fst.string_table);

    let mut builder =
        FstBuilder::new_with_string_table(false, string_table.clone()).expect("reuse string table");
    builder.add_file("dir/a.txt", 0x1000, 4);
    builder.add_file("dir/sub/b.bin", 0x2000, 8);
    builder.add_file("root.txt", 0x3000, 16);
    let rebuilt = builder.finalize();

    assert_eq!(rebuilt.as_ref(), original.as_ref());
    let rebuilt_fst = Fst::new(&rebuilt).expect("parse rebuilt FST");
    assert_eq!(rebuilt_fst.string_table, string_table.as_slice());
    assert_eq!(
        rebuilt_fst.get_name(rebuilt_fst.nodes[0]).expect("root"),
        "<root>"
    );
}

#[test]
fn fst_builder_with_string_table_appends_names_that_are_missing() {
    let mut builder =
        FstBuilder::new_with_string_table(false, b"<root>\0keep\0".to_vec()).expect("build");
    builder.add_file("new.bin", 0x40, 8);
    let data = builder.finalize();
    let fst = Fst::new(&data).expect("parse FST");

    assert_eq!(fst.string_table, b"<root>\0keep\0new.bin\0");
    assert_eq!(fst.get_name(fst.nodes[1]).expect("name"), "new.bin");
}

#[test]
fn fst_builder_with_string_table_rejects_a_missing_terminator() {
    let Err(err) = FstBuilder::new_with_string_table(false, b"abc".to_vec()) else {
        panic!("expected an unterminated string table to be rejected");
    };
    assert!(
        matches!(&err, Error::DiscFormat(msg) if msg.contains("must be null-terminated")),
        "unexpected error: {err}"
    );
}

#[test]
fn fst_builder_with_string_table_rejects_an_empty_table() {
    let Err(err) = FstBuilder::new_with_string_table(false, Vec::new()) else {
        panic!("expected an empty string table to be rejected");
    };
    assert!(
        matches!(&err, Error::DiscFormat(msg) if msg.contains("root name not null-terminated")),
        "unexpected error: {err}"
    );
}

#[test]
fn fst_builder_with_string_table_falls_back_when_the_root_name_is_not_utf8() {
    let builder =
        FstBuilder::new_with_string_table(false, vec![0xFF, 0x00]).expect("non-utf8 root name");
    let data = builder.finalize();
    let fst = Fst::new(&data).expect("parse FST");

    assert_eq!(
        fst.string_table,
        [0xFF, 0x00, b'<', b'r', b'o', b'o', b't', b'>', 0x00]
    );
    assert_eq!(fst.nodes[0].name_offset(), 2);
}
