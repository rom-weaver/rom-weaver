//! Native-only downloads for rom-weaver-bundle.json bundle `url` entries. The wasm build
//! never compiles this module - the browser prefetches URLs with JS `fetch`
//! and hands the CLI core plain paths.

use std::time::Duration;

use rom_weaver_core::ValidationCodeError;

use super::*;

const DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_MAX_REDIRECTS: u32 = 5;
/// Ceiling on one downloaded file - a sanity guard against endless streams,
/// far above any real ROM.
const DOWNLOAD_MAX_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const DOWNLOAD_READ_CHUNK: usize = 64 * 1024;
/// Emit a progress event at most every this many downloaded bytes.
const DOWNLOAD_PROGRESS_STRIDE: u64 = 4 * 1024 * 1024;

impl CliApp {
    /// Download one bundle-referenced URL into the run's temp namespace.
    /// The URL's tail file name is preserved (compound extensions like
    /// `.tar.gz` drive container probing, and `[crc32:..]` tokens drive
    /// file-name requirement parsing downstream).
    pub(super) fn download_bundle_url(
        &self,
        url: &str,
        entry_label: &str,
        context: &OperationContext,
    ) -> Result<PathBuf> {
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(RomWeaverError::ValidationCode(
                ValidationCodeError::new("bundle.url.unsupported")
                    .with_message("bundle url entries must use http or https")
                    .with_field("entry", entry_label.to_owned())
                    .with_field("url", url.to_owned()),
            ));
        }
        let file_name =
            url_tail_file_name(url).unwrap_or_else(|| "bundle-download.bin".to_string());
        let dir = context.temp_paths().next_path("bundle-download", None);
        fs::create_dir_all(&dir)?;
        let target = dir.join(&file_name);
        trace!(
            url,
            entry = entry_label,
            target = %target.display(),
            "downloading bundle url entry"
        );

        let config = ureq::Agent::config_builder()
            .timeout_connect(Some(DOWNLOAD_CONNECT_TIMEOUT))
            .max_redirects(DOWNLOAD_MAX_REDIRECTS)
            .build();
        let agent = ureq::Agent::new_with_config(config);
        // Non-2xx statuses surface as Err from call() (ureq's default).
        let mut response = agent.get(url).call().map_err(|error| {
            RomWeaverError::Validation(format!("bundle download failed for `{url}`: {error}"))
        })?;
        let total_bytes = response.body().content_length();
        let mut reader = response
            .body_mut()
            .with_config()
            .limit(DOWNLOAD_MAX_BYTES)
            .reader();

        let mut file = File::create(&target)?;
        let mut buffer = vec![0u8; DOWNLOAD_READ_CHUNK];
        let mut downloaded: u64 = 0;
        let mut last_emitted: u64 = 0;
        loop {
            let read = reader.read(&mut buffer).map_err(|error| {
                RomWeaverError::Validation(format!("bundle download failed for `{url}`: {error}"))
            })?;
            if read == 0 {
                break;
            }
            file.write_all(&buffer[..read])?;
            downloaded += read as u64;
            if downloaded - last_emitted >= DOWNLOAD_PROGRESS_STRIDE {
                last_emitted = downloaded;
                let percent = total_bytes
                    .filter(|total| *total > 0)
                    .map(|total| (((downloaded as f64 / total as f64) * 100.0).min(99.0)) as f32);
                self.emit_running(
                    OperationLabel {
                        command: "patch-apply",
                        family: OperationFamily::Patch,
                        format: None,
                    },
                    "download",
                    match total_bytes {
                        Some(total) => {
                            format!("downloading `{file_name}` ({downloaded} / {total} bytes)")
                        }
                        None => format!("downloading `{file_name}` ({downloaded} bytes)"),
                    },
                    percent,
                    context.single_thread_execution(),
                );
            }
        }
        file.flush()?;
        trace!(url, bytes = downloaded, "bundle url entry downloaded");
        Ok(target)
    }
}

/// Base of a URL for resolving relative bundle entry references: everything
/// up to (not including) the last path segment. Falls back to the URL itself
/// when there is no path beyond the authority.
pub(super) fn bundle_url_base(url: &str) -> String {
    let trimmed = url.split(['?', '#']).next().unwrap_or(url);
    let path_start = trimmed
        .find("://")
        .map(|index| index + 3)
        .unwrap_or_default();
    match trimmed[path_start..].rfind('/') {
        Some(offset) => trimmed[..path_start + offset].to_string(),
        None => trimmed.to_string(),
    }
}

/// Resolve a bundle entry URL: absolute http(s) URLs pass through; a plain
/// relative reference joins onto the bundle's own URL base.
pub(super) fn resolve_bundle_entry_url(
    url: &str,
    bundle_base_url: Option<&str>,
    entry_label: &str,
) -> Result<String> {
    if url.starts_with("http://") || url.starts_with("https://") {
        return Ok(url.to_string());
    }
    if url.starts_with('/') || url.starts_with('\\') {
        return Err(RomWeaverError::ValidationCode(
            ValidationCodeError::new("bundle.url.unsupported")
                .with_message(
                    "relative bundle urls must not start with a slash; use a full http(s) url or a plain relative reference",
                )
                .with_field("entry", entry_label.to_owned())
                .with_field("url", url.to_owned()),
        ));
    }
    let Some(base) = bundle_base_url else {
        return Err(RomWeaverError::ValidationCode(
            ValidationCodeError::new("bundle.url.unsupported")
                .with_message(
                    "relative bundle urls only resolve when the bundle itself was fetched from a url",
                )
                .with_field("entry", entry_label.to_owned())
                .with_field("url", url.to_owned()),
        ));
    };
    Ok(format!("{base}/{url}"))
}

fn url_tail_file_name(url: &str) -> Option<String> {
    let without_query = url.split(['?', '#']).next().unwrap_or(url);
    let path_start = without_query.find("://").map(|index| index + 3)?;
    let path = &without_query[path_start..];
    if !path.contains('/') {
        // Authority only - no path segment to name the download after.
        return None;
    }
    let tail = path.trim_end_matches('/').rsplit('/').next()?;
    if tail.is_empty() {
        return None;
    }
    // Keep `:` - `[crc32:..]` file-name requirement tokens depend on it.
    let sanitized: String = tail
        .chars()
        .map(|value| if value == '\\' { '-' } else { value })
        .collect();
    Some(sanitized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_base_strips_last_segment_only() {
        assert_eq!(
            bundle_url_base("https://example.test/packs/rom-weaver-bundle.json"),
            "https://example.test/packs"
        );
        assert_eq!(
            bundle_url_base("https://example.test/rom-weaver-bundle.json?token=1"),
            "https://example.test"
        );
        assert_eq!(
            bundle_url_base("https://example.test"),
            "https://example.test"
        );
    }

    #[test]
    fn relative_urls_join_onto_bundle_base() {
        let resolved = resolve_bundle_entry_url(
            "patches/main.ips",
            Some("https://example.test/packs"),
            "patches[0]",
        )
        .expect("relative url resolves");
        assert_eq!(resolved, "https://example.test/packs/patches/main.ips");
    }

    #[test]
    fn relative_urls_without_base_or_with_leading_slash_fail() {
        assert!(resolve_bundle_entry_url("main.ips", None, "patches[0]").is_err());
        assert!(
            resolve_bundle_entry_url("/main.ips", Some("https://example.test"), "patches[0]")
                .is_err()
        );
    }

    #[test]
    fn url_tail_preserves_compound_extensions() {
        assert_eq!(
            url_tail_file_name("https://example.test/bundle.tar.gz?dl=1").as_deref(),
            Some("bundle.tar.gz")
        );
        assert_eq!(
            url_tail_file_name("https://example.test/Main%20Hack%20[crc32:1a2b3c4d].ips")
                .as_deref(),
            Some("Main%20Hack%20[crc32:1a2b3c4d].ips")
        );
        assert_eq!(url_tail_file_name("https://example.test"), None);
    }
}
