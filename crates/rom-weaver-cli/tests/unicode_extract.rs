use assert_cmd::Command;
use std::{fs, io::Write};

#[test]
fn extract_zip_preserves_unicode_member_names_and_bytes() {
    assert_unicode_extraction("zip", ZIP);
}

#[test]
fn extract_7z_preserves_unicode_member_names_and_bytes() {
    assert_unicode_extraction("7z", SEVEN_Z);
}

#[test]
fn extract_stream_preserves_unicode_source_basename() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let input = temp.path().join("café.bin.gz");
    let output = temp.path().join("stream");
    let payload = b"unicode stream payload";
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(payload).expect("gzip payload");
    fs::write(&input, encoder.finish().expect("gzip fixture")).expect("stream fixture");
    cli(&temp)
        .args(["extract", "--input"])
        .arg(input)
        .arg("--output")
        .arg(&output)
        .assert()
        .success();
    assert_eq!(
        fs::read(output.join("café.bin")).expect("extracted stream"),
        payload
    );
}

#[test]
fn create_unicode_archive_names_round_trip() {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let payload = b"unicode payload\x00\xff";
    for format in ["zip", "7z"] {
        for (index, name) in ["ゲーム.bin", "café.bin", "cafe\u{301}.bin", "game.bin"]
            .iter()
            .enumerate()
        {
            let source = temp.path().join(name);
            fs::write(&source, payload).expect("source payload");
            let archive = temp.path().join(format!("créé-{index}.{format}"));
            cli(&temp)
                .args(["compress", "--threads", "1", "--input"])
                .arg(source)
                .args(["--format", format, "--output"])
                .arg(&archive)
                .assert()
                .success();
            if format == "zip" {
                let bytes = fs::read(&archive).expect("ZIP bytes");
                let flags = u16::from_le_bytes([bytes[6], bytes[7]]);
                assert_eq!(
                    flags & 0x800 != 0,
                    !name.is_ascii(),
                    "ZIP UTF-8 flag for {name}"
                );
                let name_length = usize::from(u16::from_le_bytes([bytes[26], bytes[27]]));
                assert_eq!(
                    &bytes[30..30 + name_length],
                    name.as_bytes(),
                    "ZIP name bytes"
                );
            }
            let output = temp.path().join(format!("created-output-{format}-{index}"));
            cli(&temp)
                .args(["extract", "--input"])
                .arg(archive)
                .arg("--output")
                .arg(&output)
                .assert()
                .success();
            assert_eq!(
                fs::read(output.join(name)).expect("Unicode roundtrip output"),
                payload
            );
            assert_eq!(fs::read_dir(output).expect("output entries").count(), 1);
        }
    }
}

fn cli(temp: &assert_fs::TempDir) -> Command {
    let mut command = Command::cargo_bin("rom-weaver").expect("CLI");
    command
        .env("LC_ALL", "C")
        .env("HOME", temp.path())
        .env("XDG_CONFIG_HOME", temp.path().join("config"))
        .env("XDG_CACHE_HOME", temp.path().join("cache"))
        .env("XDG_STATE_HOME", temp.path().join("state"));
    command
}

fn assert_unicode_extraction(format: &str, fixture: &[u8]) {
    let temp = assert_fs::TempDir::new().expect("temporary directory");
    let payload = b"unicode payload\x00\xff";
    let input = temp.path().join(format!("unicode.{format}"));
    let output = temp.path().join(format!("output-{format}"));
    fs::write(&input, fixture).expect("archive fixture");
    let result = cli(&temp)
        .args(["extract", "--input"])
        .arg(&input)
        .arg("--output")
        .arg(&output)
        .arg("--json")
        .output()
        .expect("extract command");
    assert!(
        result.status.success(),
        "Unicode extraction must succeed for {format}: stdout={} stderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let mut names = fs::read_dir(&output)
        .expect("output directory")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .into_string()
                .expect("UTF-8 name")
        })
        .collect::<Vec<_>>();
    names.sort();
    let mut expected = vec!["ゲーム.bin", "café.bin", "game.bin"];
    expected.sort();
    assert_eq!(names, expected, "exact output names for {format}");
    for name in expected {
        assert_eq!(
            fs::read(output.join(name)).expect("extracted bytes"),
            payload,
            "payload for {format}/{name}"
        );
    }
}

// Python zipfile STORE entries carry the UTF-8 filename flag.
const ZIP: &[u8] = b"\x50\x4b\x03\x04\x14\x00\x00\x00\x00\x00\xe7\x09\x55\x5d\x04\xf4\xcf\xf8\x11\x00\x00\x00\x11\x00\x00\x00\x08\x00\x00\x00\x67\x61\x6d\x65\x2e\x62\x69\x6e\x75\x6e\x69\x63\x6f\x64\x65\x20\x70\x61\x79\x6c\x6f\x61\x64\x00\xff\x50\x4b\x03\x04\x14\x00\x00\x08\x00\x00\xe7\x09\x55\x5d\x04\xf4\xcf\xf8\x11\x00\x00\x00\x11\x00\x00\x00\x09\x00\x00\x00\x63\x61\x66\xc3\xa9\x2e\x62\x69\x6e\x75\x6e\x69\x63\x6f\x64\x65\x20\x70\x61\x79\x6c\x6f\x61\x64\x00\xff\x50\x4b\x03\x04\x14\x00\x00\x08\x00\x00\xe7\x09\x55\x5d\x04\xf4\xcf\xf8\x11\x00\x00\x00\x11\x00\x00\x00\x0d\x00\x00\x00\xe3\x82\xb2\xe3\x83\xbc\xe3\x83\xa0\x2e\x62\x69\x6e\x75\x6e\x69\x63\x6f\x64\x65\x20\x70\x61\x79\x6c\x6f\x61\x64\x00\xff\x50\x4b\x01\x02\x14\x03\x14\x00\x00\x00\x00\x00\xe7\x09\x55\x5d\x04\xf4\xcf\xf8\x11\x00\x00\x00\x11\x00\x00\x00\x08\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x80\x01\x00\x00\x00\x00\x67\x61\x6d\x65\x2e\x62\x69\x6e\x50\x4b\x01\x02\x14\x03\x14\x00\x00\x08\x00\x00\xe7\x09\x55\x5d\x04\xf4\xcf\xf8\x11\x00\x00\x00\x11\x00\x00\x00\x09\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x80\x01\x37\x00\x00\x00\x63\x61\x66\xc3\xa9\x2e\x62\x69\x6e\x50\x4b\x01\x02\x14\x03\x14\x00\x00\x08\x00\x00\xe7\x09\x55\x5d\x04\xf4\xcf\xf8\x11\x00\x00\x00\x11\x00\x00\x00\x0d\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x80\x01\x6f\x00\x00\x00\xe3\x82\xb2\xe3\x83\xbc\xe3\x83\xa0\x2e\x62\x69\x6e\x50\x4b\x05\x06\x00\x00\x00\x00\x03\x00\x03\x00\xa8\x00\x00\x00\xab\x00\x00\x00\x00\x00";
// bsdtar --format 7zip encodes the same names in the 7z UTF-16LE name table.
const SEVEN_Z: &[u8] = b"\x37\x7a\xbc\xaf\x27\x1c\x00\x03\x00\xd5\xd5\xd6\x96\x00\x00\x00\x00\x00\x00\x00\x21\x00\x00\x00\x00\x00\x00\x00\xf4\xc4\x42\x4d\x00\x3a\x9b\x89\x60\xc5\x43\x06\x49\x89\x4d\x2e\xfd\x1a\x57\xcb\x2d\x9b\xb4\xe8\xd6\x3d\x06\xd8\xff\xff\xfd\x8c\x70\x00\x00\x00\x81\x33\x07\xae\x0f\xcf\xeb\x30\x14\x0f\xeb\xea\x9e\x01\x0d\x62\x03\x8d\xd3\x4c\x42\x3f\x0e\xa3\xa4\x59\xf9\xb8\x8a\xde\x48\xc8\x14\x95\x28\x0b\xfb\xa1\x56\xc8\xd2\x3c\x44\x04\x99\xfa\xf7\xd1\xc6\x9e\x03\x84\x8e\x50\x4f\x98\x7b\xc6\x94\xeb\x0e\x09\x43\x4f\xb4\xa2\x5c\xe7\x82\x4a\xb3\xf8\xb8\x2c\x49\xb6\x93\x5a\x12\x50\xdf\x99\x1d\x7d\xcd\xea\x55\x77\x43\x36\xae\xa7\x4e\x3c\x7f\x79\x1e\x37\xb4\xe2\x23\xb6\xa6\x6b\x94\xe6\x28\x67\xed\x21\x53\xa5\x5f\xff\x75\x24\x00\x00\x17\x06\x1e\x01\x09\x78\x00\x07\x0b\x01\x00\x01\x23\x03\x01\x01\x05\x5d\x00\x00\x80\x00\x0c\x80\xcf\x0a\x01\xcc\xb3\x40\xd5\x00\x00";
