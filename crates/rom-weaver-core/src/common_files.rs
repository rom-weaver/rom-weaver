const COMMON_CONTAINER_FILE_EXTENSIONS: &[&str] = &[
    ".txt", ".nfo", ".diz", ".rtf", ".doc", ".docx", ".xls", ".xlsx", ".htm", ".html", ".pdf",
    ".jpg", ".jpeg", ".gif", ".png", ".bmp", ".webp", ".sfv", ".md5", ".sha1", ".sha256",
    ".sha512", ".crc", ".log", ".json",
];

pub fn should_ignore_common_container_file(candidate_name: &str) -> bool {
    let normalized = candidate_name.replace('\\', "/");
    let lower = normalized.to_ascii_lowercase();
    if lower.contains("maxcso") {
        return true;
    }
    if lower.split('/').any(|component| component == "__macosx") {
        return true;
    }
    if let Some(file_name) = lower.rsplit('/').next() {
        if file_name.starts_with("._") {
            return true;
        }
        if matches!(file_name, ".ds_store" | "thumbs.db" | "desktop.ini") {
            return true;
        }
    }
    COMMON_CONTAINER_FILE_EXTENSIONS
        .iter()
        .any(|extension| lower.ends_with(extension))
}
