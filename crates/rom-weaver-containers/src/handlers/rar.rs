
struct RarContainerHandler {
    descriptor: &'static FormatDescriptor,
}

impl RarContainerHandler {
    const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }

    fn open_archive(&self, source: &Path) -> Result<rars::Archive> {
        RarRsArchiveReader::read_path(source)
            .map_err(|error| RomWeaverError::Validation(format!("rar archive is invalid: {error}")))
    }
}

impl ContainerHandler for RarContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        let mut signature = [0u8; RAR5_SIGNATURE.len()];
        if let Ok(mut file) = File::open(source) {
            if let Ok(read) = file.read(&mut signature) {
                if read >= RAR4_SIGNATURE.len()
                    && signature[..RAR4_SIGNATURE.len()] == RAR4_SIGNATURE
                {
                    return ProbeConfidence::Signature;
                }
                if read >= RAR5_SIGNATURE.len() && signature == RAR5_SIGNATURE {
                    return ProbeConfidence::Signature;
                }
            }
        }
        ProbeConfidence::Extension
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        let archive = self.open_archive(&request.source)?;
        let mut files = 0usize;
        let mut directories = 0usize;
        let mut logical_bytes = 0u64;
        let mut entries_total = 0usize;

        for member in archive.members() {
            let entry_name =
                normalize_archive_name(&String::from_utf8_lossy(member.meta.name_bytes()));
            if entry_name.is_empty() {
                continue;
            }
            entries_total = entries_total.saturating_add(1);
            if member.meta.is_directory {
                directories = directories.saturating_add(1);
            } else {
                files = files.saturating_add(1);
                logical_bytes = logical_bytes.saturating_add(member.meta.unpacked_size);
            }
        }

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "inspect",
            format!(
                "rar: {} entries ({} files, {} directories), {} bytes uncompressed",
                entries_total, files, directories, logical_bytes
            ),
            Some(100.0),
            None,
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        let archive = self.open_archive(&request.source)?;
        let mut entries = Vec::new();
        for member in archive.members() {
            let entry_name =
                normalize_archive_name(&String::from_utf8_lossy(member.meta.name_bytes()));
            if !entry_name.is_empty() {
                entries.push(entry_name);
            }
        }
        Ok(entries)
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        extract_regular_archive_with_libarchive(request, context, self.descriptor.name, true)
    }

    fn create(
        &self,
        _request: &ContainerCreateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Err(RomWeaverError::Validation(
            "rar create is not supported".into(),
        ))
    }

    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            inspect: true,
            extract: true,
            create: false,
            extract_threads: ThreadCapability::parallel(None),
            create_threads: ThreadCapability::single_threaded(),
        }
    }
}
