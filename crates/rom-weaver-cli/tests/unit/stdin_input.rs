use std::{
    fs::OpenOptions,
    io::{self, Read},
    path::PathBuf,
};

use super::native::spool_reader_to_file;

struct PartialFailingReader {
    sent_bytes: bool,
}

impl Read for PartialFailingReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.sent_bytes {
            return Err(io::Error::other("simulated stdin read failure"));
        }
        self.sent_bytes = true;
        buffer[..7].copy_from_slice(b"partial");
        Ok(7)
    }
}

#[test]
fn failed_stdin_spool_removes_the_partial_file() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let path = temp.path().join("stdin-spool.tmp");
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .expect("reserve spool file");
    let mut input = PathBuf::from("-");
    let mut reader = PartialFailingReader { sent_bytes: false };

    let error = match spool_reader_to_file(&mut input, &mut reader, path.clone(), file) {
        Err(error) => error,
        Ok(_) => panic!("the injected reader must fail"),
    };

    assert!(
        error.to_string().contains("simulated stdin read failure"),
        "the original read error must be reported: {error}"
    );
    assert!(!path.exists(), "partial stdin spool must be removed");
    assert_eq!(input, PathBuf::from("-"));
}
