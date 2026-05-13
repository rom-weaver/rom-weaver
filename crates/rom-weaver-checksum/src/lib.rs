use rom_weaver_core::{
    ChecksumCapabilities, ChecksumEngine, ChecksumRequest, OperationContext, OperationFamily,
    OperationReport, Result, ThreadCapability,
};

const SUPPORTED_ALGORITHMS: &[&str] = &["crc32", "md5", "sha1", "crc16", "adler32"];

pub struct NativeChecksumEngine;

impl Default for NativeChecksumEngine {
    fn default() -> Self {
        Self
    }
}

impl ChecksumEngine for NativeChecksumEngine {
    fn name(&self) -> &'static str {
        "native"
    }

    fn supported_algorithms(&self) -> &'static [&'static str] {
        SUPPORTED_ALGORITHMS
    }

    fn checksum_file(
        &self,
        _request: &ChecksumRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        Ok(OperationReport::unsupported(
            OperationFamily::Checksum,
            Some(self.name().to_string()),
            "checksum",
            "checksum is not implemented yet for the native engine",
            Some(execution),
        ))
    }

    fn checksum_range(
        &self,
        _request: &ChecksumRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        Ok(OperationReport::unsupported(
            OperationFamily::Checksum,
            Some(self.name().to_string()),
            "checksum-range",
            "checksum range support is not implemented yet for the native engine",
            Some(execution),
        ))
    }

    fn capabilities(&self) -> ChecksumCapabilities {
        ChecksumCapabilities {
            checksum_file: false,
            checksum_range: false,
            threaded_fanout: false,
        }
    }
}

pub fn supported_algorithms() -> &'static [&'static str] {
    SUPPORTED_ALGORITHMS
}

#[cfg(test)]
mod tests {
    use super::supported_algorithms;

    #[test]
    fn registry_contains_planned_algorithms() {
        assert_eq!(
            supported_algorithms(),
            &["crc32", "md5", "sha1", "crc16", "adler32"]
        );
    }
}
