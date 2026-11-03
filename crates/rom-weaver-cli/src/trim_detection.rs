use super::selection_resolution::SelectionExtract;
use super::*;

/// The members trim extracts from an archive, chosen from its listing before anything is written.
struct TrimArchiveMembers {
    /// Members that are or may be trim-eligible, plus nested archives when descending.
    extract: Vec<String>,
    /// GameCube/Wii discs recognized by name or header; trim never extracts them.
    gamecube_wii_discs: usize,
}

/// How trim treats an archive member, judged by its name alone.
enum TrimMemberName {
    Extract,
    /// An `.iso` or `.ciso` whose header decides whether it is a GameCube/Wii disc.
    ReadHeader,
    GamecubeWiiDisc,
    Skip,
}

fn classify_trim_member_name(name: &str, include_nested: bool) -> TrimMemberName {
    let path = Path::new(name);
    if TrimInputKind::from_path(path).is_some() {
        return TrimMemberName::Extract;
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if TRIM_CONTENT_SNIFFED_EXTENSIONS.contains(&extension.as_str()) || extension == "ciso" {
        return TrimMemberName::ReadHeader;
    }
    if GAMECUBE_WII_DISC_EXTENSIONS.contains(&extension.as_str()) {
        return TrimMemberName::GamecubeWiiDisc;
    }
    // Unnamed members may be archives that only their content identifies.
    let may_hold_rom = !TRIM_NON_ARCHIVE_DISC_EXTENSIONS.contains(&extension.as_str())
        && (is_container_filter_passthrough_candidate_name(name)
            || rom_weaver_core::payload_name_needs_content_classification(name));
    if include_nested && may_hold_rom {
        return TrimMemberName::Extract;
    }
    TrimMemberName::Skip
}

impl CliApp {
    /// Choose the members of `archive` trim must extract from the archive's listing, reading only
    /// a short header for `.iso` and `.ciso` members. `include_nested` keeps nested archives.
    /// Returns `None` when the container cannot list its entries, so the caller extracts them all.
    fn plan_trim_archive_members(
        handler: &dyn ContainerHandler,
        archive: &Path,
        include_nested: bool,
        context: &OperationContext,
    ) -> Option<TrimArchiveMembers> {
        let request = ContainerProbeRequest {
            source: archive.to_path_buf(),
            split_bin: false,
        };
        let entries = match handler.list_entry_records(&request, context) {
            Ok(entries) => entries,
            Err(error) => {
                debug!(
                    archive = %archive.display(),
                    format = handler.descriptor().name,
                    %error,
                    "trim could not list archive members; extracting all of them"
                );
                return None;
            }
        };
        let mut members = TrimArchiveMembers {
            extract: Vec::new(),
            gamecube_wii_discs: 0,
        };
        let mut header_names = Vec::new();
        for entry in &entries {
            // A selected folder would extract everything under it, discs included; its members are
            // listed on their own.
            if entry.path.ends_with('/') {
                continue;
            }
            let name = normalize_archive_name(&entry.path);
            if name.is_empty() || should_ignore_common_container_file(&name) {
                continue;
            }
            match classify_trim_member_name(&name, include_nested) {
                TrimMemberName::Extract => members.extract.push(name),
                TrimMemberName::ReadHeader => header_names.push(name),
                TrimMemberName::GamecubeWiiDisc => {
                    trace!(archive = %archive.display(), member = %name, "trim skipped a GameCube/Wii disc by name");
                    members.gamecube_wii_discs += 1;
                }
                TrimMemberName::Skip => {
                    trace!(archive = %archive.display(), member = %name, "trim skipped an ineligible archive member");
                }
            }
        }
        if !header_names.is_empty() {
            let headers = handler
                .read_entry_prefixes(
                    &request,
                    &header_names,
                    GAMECUBE_WII_DISC_HEADER_LEN,
                    context,
                )
                .unwrap_or_else(|error| {
                    debug!(
                        archive = %archive.display(),
                        %error,
                        "trim could not read archive member headers; extracting those members"
                    );
                    BTreeMap::new()
                });
            for name in header_names {
                let is_ciso = name.to_ascii_lowercase().ends_with(".ciso");
                match headers.get(&name) {
                    Some(header) if is_gamecube_wii_disc_header(header) => {
                        trace!(archive = %archive.display(), member = %name, "trim skipped a GameCube/Wii disc by header");
                        members.gamecube_wii_discs += 1;
                    }
                    // A PSP CSO never holds a trim-eligible ROM.
                    Some(_) if is_ciso => {}
                    // An `.iso` that is not a GameCube/Wii disc may be an Xbox XISO.
                    Some(_) => members.extract.push(name),
                    None if is_ciso && !include_nested => {}
                    None => members.extract.push(name),
                }
            }
        }
        debug!(
            archive = %archive.display(),
            entries = entries.len(),
            extract = members.extract.len(),
            gamecube_wii_discs = members.gamecube_wii_discs,
            "planned trim archive members"
        );
        Some(members)
    }

    pub(super) fn trim_eligible_kind_for_path(&self, path: &Path) -> Option<TrimInputKind> {
        if let Some(kind) = TrimInputKind::from_path(path) {
            return Some(kind);
        }

        if path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| {
                TRIM_CONTENT_SNIFFED_EXTENSIONS
                    .iter()
                    .any(|sniffed| extension.eq_ignore_ascii_case(sniffed))
            })
            && let Ok(source_file) = File::options().read(true).open(path)
        {
            let source_reader = BufReader::new(source_file);
            if XdvdfsOffsetWrapper::new(source_reader).is_ok() {
                return Some(TrimInputKind::Xiso);
            }
        }

        None
    }

    /// Whether `path` is a GameCube/Wii disc image. Detected by content, so any supported disc
    /// container counts (`.iso`, `.gcm`, `.rvz`, `.wbfs`, `.wia`, `.gcz`, `.ciso`, `.tgc`,
    /// `.nfs`); other non-XISO `.iso` files (PS2, ...) are not discs. Trim does not handle
    /// these; `compress` writes them as RVZ.
    pub(super) fn is_gamecube_wii_disc(&self, path: &Path) -> bool {
        let recommendation = self.containers.recommend_compress_format(path);
        recommendation.format_name.eq_ignore_ascii_case("rvz")
    }

    fn gamecube_wii_disc_trim_error(path: &Path) -> RomWeaverError {
        RomWeaverError::Validation(format!(
            "`{}` is a GameCube/Wii disc, which trim does not support; use `rom-weaver compress` to convert it to RVZ",
            path.display()
        ))
    }

    /// The rejection for a lone archive input that holds GameCube/Wii discs and no trim-eligible payload.
    fn gamecube_wii_archive_trim_error(archive: &Path, disc_count: usize) -> RomWeaverError {
        let (subject, pronoun) = if disc_count == 1 {
            ("a GameCube/Wii disc", "it")
        } else {
            ("GameCube/Wii discs", "them")
        };
        RomWeaverError::Validation(format!(
            "`{}` holds {subject}, which trim does not support; use `rom-weaver compress` to convert {pronoun} to RVZ",
            archive.display()
        ))
    }

    pub(super) fn collect_trim_input_files(
        &self,
        sources: &[PathBuf],
        options: TrimCollectOptions<'_>,
        cleanup_paths: &mut Vec<PathBuf>,
        skips: &mut TrimSkips,
    ) -> Result<Vec<TrimSource>> {
        let mut files = Vec::new();
        for source in sources {
            let metadata = fs::metadata(source).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "input path is not accessible: `{}` ({error})",
                    source.display()
                ))
            })?;
            if metadata.is_file() {
                // A lone file the user named (a disc, or an archive holding only discs) is rejected
                // with an explanation; in a larger batch or a folder a GameCube/Wii disc is
                // counted as skipped like any other unsupported file.
                let reject_gamecube_wii = sources.len() == 1;
                self.collect_trim_file(
                    source,
                    options,
                    reject_gamecube_wii,
                    &mut files,
                    cleanup_paths,
                    skips,
                )?;
                continue;
            }
            if metadata.is_dir() {
                self.collect_trim_directory_files(
                    source,
                    options,
                    &mut files,
                    cleanup_paths,
                    skips,
                )?;
                continue;
            }

            skips.skip_unsupported();
        }

        files.sort_by(|left, right| left.path.cmp(&right.path));
        files.dedup_by(|left, right| left.path == right.path);
        Ok(files)
    }

    /// Resolve a single file input into trim sources: a directly trim-eligible file becomes one
    /// source, otherwise an extractable archive is unpacked and its trim-eligible payloads are
    /// added. Anything else increments the unsupported counter; a GameCube/Wii disc (or an
    /// archive holding only discs) is an error instead when `reject_gamecube_wii` is set.
    pub(super) fn collect_trim_file(
        &self,
        path: &Path,
        options: TrimCollectOptions<'_>,
        reject_gamecube_wii: bool,
        files: &mut Vec<TrimSource>,
        cleanup_paths: &mut Vec<PathBuf>,
        skips: &mut TrimSkips,
    ) -> Result<()> {
        if let Some(kind) = self.trim_eligible_kind_for_path(path) {
            files.push(TrimSource {
                path: path.to_path_buf(),
                kind,
                archive_origin: None,
                repack_root: None,
            });
            return Ok(());
        }

        if self.is_gamecube_wii_disc(path) {
            debug!(path = %path.display(), reject_gamecube_wii, "trim skipped a GameCube/Wii disc");
            if reject_gamecube_wii {
                return Err(Self::gamecube_wii_disc_trim_error(path));
            }
            skips.skip_gamecube_wii();
            return Ok(());
        }

        if options.no_extract {
            skips.skip_unsupported();
            return Ok(());
        }

        let discs_before = skips.gamecube_wii;
        let extracted = if options.in_place {
            self.extract_trim_repack_payload(path, options, cleanup_paths, skips)?
        } else {
            self.extract_trim_payloads(path, options, cleanup_paths, skips)?
        };
        let discs_in_archive = skips.gamecube_wii.saturating_sub(discs_before);
        if !extracted.is_empty() {
            files.extend(extracted);
        } else if discs_in_archive > 0 {
            // The discs were already counted individually; the archive holds nothing else.
            debug!(
                path = %path.display(),
                discs_in_archive,
                reject_gamecube_wii,
                "trim archive holds only GameCube/Wii discs"
            );
            if reject_gamecube_wii {
                return Err(Self::gamecube_wii_archive_trim_error(
                    path,
                    discs_in_archive,
                ));
            }
        } else {
            skips.skip_unsupported();
        }
        Ok(())
    }

    pub(super) fn collect_trim_directory_files(
        &self,
        root: &Path,
        options: TrimCollectOptions<'_>,
        files: &mut Vec<TrimSource>,
        cleanup_paths: &mut Vec<PathBuf>,
        skips: &mut TrimSkips,
    ) -> Result<()> {
        let mut directories = vec![root.to_path_buf()];
        while let Some(directory) = directories.pop() {
            let mut entries =
                fs::read_dir(&directory)?.collect::<std::result::Result<Vec<_>, _>>()?;
            entries.sort_by_key(|entry| entry.path());

            for entry in entries {
                let path = entry.path();
                let file_type = entry.file_type()?;
                if file_type.is_dir() {
                    if options.recursive {
                        directories.push(path);
                    }
                    continue;
                }
                if !file_type.is_file() {
                    skips.skip_unsupported();
                    continue;
                }
                self.collect_trim_file(&path, options, false, files, cleanup_paths, skips)?;
            }
        }
        Ok(())
    }

    /// Extract an archive (recursively, bounded) into temporary directories and return only the
    /// payloads whose type trim actually supports. Only members that may matter are extracted
    /// (see [`Self::plan_trim_archive_members`]); GameCube/Wii discs found inside are counted in
    /// `skips` and never extracted or decoded. Temp directories are
    /// recorded in `cleanup_paths` so the caller can remove them after trimming completes.
    pub(super) fn extract_trim_payloads(
        &self,
        archive: &Path,
        options: TrimCollectOptions<'_>,
        cleanup_paths: &mut Vec<PathBuf>,
        skips: &mut TrimSkips,
    ) -> Result<Vec<TrimSource>> {
        let kind_filter = ArchiveEntryKindFilter::new(options.rom_filter, false);
        let mut found = Vec::new();
        let mut queue = VecDeque::new();
        queue.push_back((archive.to_path_buf(), 1usize));
        let mut extracted_archives = 0usize;

        while let Some((current, depth)) = queue.pop_front() {
            if depth > MAX_NESTED_EXTRACT_DEPTH {
                return Err(RomWeaverError::Validation(format!(
                    "trim extract exceeded max depth of {MAX_NESTED_EXTRACT_DEPTH} at `{}`",
                    current.display()
                )));
            }
            if extracted_archives >= MAX_NESTED_EXTRACT_ARCHIVES {
                return Err(RomWeaverError::Validation(format!(
                    "trim extract exceeded max archive count of {MAX_NESTED_EXTRACT_ARCHIVES}"
                )));
            }

            let Some(handler) = self.containers.probe(&current) else {
                continue;
            };
            if handler.descriptor().matches_name("xiso") || !handler.capabilities().extract {
                continue;
            }
            // Only extract sources that genuinely probe as a container, so extension-only matches
            // on non-container payloads do not abort the batch.
            let probe_request = ContainerProbeRequest {
                source: current.clone(),
                split_bin: false,
            };
            if handler
                .probe_details(&probe_request, options.context)
                .is_err()
            {
                continue;
            }
            let selections = match Self::plan_trim_archive_members(
                handler.as_ref(),
                &current,
                true,
                options.context,
            ) {
                Some(members) => {
                    for _ in 0..members.gamecube_wii_discs {
                        skips.skip_gamecube_wii();
                    }
                    if members.extract.is_empty() {
                        continue;
                    }
                    members.extract
                }
                None => Vec::new(),
            };

            let out_dir = options.context.temp_paths().next_path("trim-extract", None);
            fs::create_dir_all(&out_dir)?;
            cleanup_paths.push(out_dir.clone());
            trace!(
                archive = %archive.display(),
                source = %current.display(),
                format = handler.descriptor().name,
                out_dir = %out_dir.display(),
                depth,
                rom_filter = options.rom_filter,
                selections = selections.len(),
                "extracting archive for trim"
            );
            self.extract_with_selection_fallback(
                handler.as_ref(),
                &current,
                SelectionExtract {
                    out_dir: &out_dir,
                    selections: &selections,
                    kind_filter,
                    split_bin: false,
                    ignore_common_files: true,
                    overwrite: true,
                    source_label: "trim",
                    allow_multi_select: false,
                },
                options.context,
            )
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "trim payload extraction failed for `{}` ({}): {error}",
                    current.display(),
                    handler.descriptor().name
                ))
            })?;
            extracted_archives = extracted_archives.saturating_add(1);

            for candidate in self.collect_checksum_extract_candidates(&out_dir)? {
                if candidate.ignored {
                    continue;
                }
                if let Some(kind) = self.trim_eligible_kind_for_path(&candidate.source) {
                    trace!(
                        archive = %archive.display(),
                        payload = %candidate.source.display(),
                        kind = kind.mode_label(),
                        "found trim-eligible payload in archive"
                    );
                    found.push(TrimSource {
                        path: candidate.source,
                        kind,
                        archive_origin: Some(archive.to_path_buf()),
                        repack_root: None,
                    });
                } else if self.is_gamecube_wii_disc(&candidate.source) {
                    // A disc matches an extract-capable handler (rvz, wbfs, iso, ...), but trim
                    // never handles it, so decoding it would only spend temp space to skip it.
                    debug!(
                        archive = %archive.display(),
                        payload = %candidate.source.display(),
                        "trim skipped a GameCube/Wii disc inside an archive"
                    );
                    skips.skip_gamecube_wii();
                } else if self.containers.probe(&candidate.source).is_some() {
                    queue.push_back((candidate.source, depth + 1));
                }
            }
        }

        Ok(found)
    }

    /// Extract an archive's full contents (all non-junk files preserved) into a temp directory so
    /// `--in-place` can trim the ROM and recompress the directory back over the original archive.
    /// Only a single top-level trim-eligible ROM is supported; deeper or multiple ROMs are
    /// rejected so the repack stays unambiguous.
    pub(super) fn extract_trim_repack_payload(
        &self,
        archive: &Path,
        options: TrimCollectOptions<'_>,
        cleanup_paths: &mut Vec<PathBuf>,
        skips: &mut TrimSkips,
    ) -> Result<Vec<TrimSource>> {
        let Some(handler) = self.containers.probe(archive) else {
            return Ok(Vec::new());
        };
        if handler.descriptor().matches_name("xiso") || !handler.capabilities().extract {
            return Ok(Vec::new());
        }
        let probe_request = ContainerProbeRequest {
            source: archive.to_path_buf(),
            split_bin: false,
        };
        if handler
            .probe_details(&probe_request, options.context)
            .is_err()
        {
            return Ok(Vec::new());
        }
        if !handler.capabilities().create {
            return Err(RomWeaverError::Validation(format!(
                "--in-place is not supported for `{}`: the `{}` format cannot be recreated; omit --in-place to write the trimmed ROM beside the archive",
                archive.display(),
                handler.descriptor().name
            )));
        }
        // The repack keeps every member, so the plan only decides whether to extract at all. Discs
        // are counted here only when nothing is extracted; otherwise the loop below counts them.
        if let Some(members) =
            Self::plan_trim_archive_members(handler.as_ref(), archive, false, options.context)
            && members.extract.is_empty()
        {
            for _ in 0..members.gamecube_wii_discs {
                skips.skip_gamecube_wii();
            }
            return Ok(Vec::new());
        }

        let out_dir = options.context.temp_paths().next_path("trim-repack", None);
        fs::create_dir_all(&out_dir)?;
        cleanup_paths.push(out_dir.clone());
        trace!(
            archive = %archive.display(),
            format = handler.descriptor().name,
            out_dir = %out_dir.display(),
            "extracting full archive contents for in-place trim repack"
        );
        // Preserve every file faithfully: disable both the ROM kind filter and common-file ignores
        // so nothing is dropped from the rebuilt archive. The presence of non-ROM files is what
        // gates an in-place repack behind confirmation.
        self.extract_with_selection_fallback(
            handler.as_ref(),
            archive,
            SelectionExtract {
                out_dir: &out_dir,
                selections: &[],
                kind_filter: ArchiveEntryKindFilter::new(false, false),
                split_bin: false,
                ignore_common_files: false,
                overwrite: true,
                source_label: "trim",
                allow_multi_select: false,
            },
            options.context,
        )
        .map_err(|error| {
            RomWeaverError::Validation(format!(
                "trim repack extraction failed for `{}` ({}): {error}",
                archive.display(),
                handler.descriptor().name
            ))
        })?;

        let mut roms = Vec::new();
        for candidate in self.collect_checksum_extract_candidates(&out_dir)? {
            if candidate.ignored {
                continue;
            }
            if let Some(kind) = self.trim_eligible_kind_for_path(&candidate.source) {
                roms.push((candidate.source, kind));
            } else if self.is_gamecube_wii_disc(&candidate.source) {
                debug!(
                    archive = %archive.display(),
                    payload = %candidate.source.display(),
                    "trim repack skipped a GameCube/Wii disc inside an archive"
                );
                skips.skip_gamecube_wii();
            }
        }

        if roms.len() > 1 {
            return Err(RomWeaverError::Validation(format!(
                "--in-place repack found {} trim-eligible ROMs in `{}`; in-place repacking supports a single ROM per archive",
                roms.len(),
                archive.display()
            )));
        }

        Ok(roms
            .into_iter()
            .map(|(path, kind)| TrimSource {
                path,
                kind,
                archive_origin: Some(archive.to_path_buf()),
                repack_root: Some(out_dir.clone()),
            })
            .collect())
    }

    pub(super) fn default_trim_output_path(source: &TrimSource, extension: &str) -> PathBuf {
        let source_extension = trim_source_extension(source);
        let extension = extension.replace("{ext}", source_extension);
        let mut output = source.path.to_path_buf();
        output.set_extension(extension);
        output
    }

    /// Side-by-side output for an archive-extracted payload: places the trimmed ROM next to the
    /// original archive using the payload's base name and resolved extension.
    pub(super) fn archive_sidecar_trim_output_path(
        archive: &Path,
        source: &TrimSource,
        extension: &str,
    ) -> PathBuf {
        let source_extension = trim_source_extension(source);
        let extension = extension.replace("{ext}", source_extension);
        let directory = archive
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let stem = source
            .path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("trimmed");
        directory.join(format!("{stem}.{extension}"))
    }
}

/// The `{ext}` substitution for a trim source: the source's own extension (`bin` when it has
/// none).
fn trim_source_extension(source: &TrimSource) -> &str {
    source
        .path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("bin")
}
