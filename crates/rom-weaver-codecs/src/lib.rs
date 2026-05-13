use std::sync::Arc;

use rom_weaver_core::{
    CodecBackend, CodecCapabilities, CodecDescriptor, CodecOperationRequest, FormatDescriptor,
    OperationContext, OperationFamily, OperationReport, Result, ThreadCapability,
};

const STORE: CodecDescriptor = FormatDescriptor {
    family: OperationFamily::Codec,
    name: "store",
    aliases: &[],
    extensions: &[],
};
const DEFLATE: CodecDescriptor = FormatDescriptor {
    family: OperationFamily::Codec,
    name: "deflate",
    aliases: &["zlib"],
    extensions: &[],
};
const ZSTD: CodecDescriptor = FormatDescriptor {
    family: OperationFamily::Codec,
    name: "zstd",
    aliases: &[],
    extensions: &[],
};
const LZMA2: CodecDescriptor = FormatDescriptor {
    family: OperationFamily::Codec,
    name: "lzma2",
    aliases: &["xz"],
    extensions: &[],
};
const BZIP2: CodecDescriptor = FormatDescriptor {
    family: OperationFamily::Codec,
    name: "bzip2",
    aliases: &["bz2"],
    extensions: &[],
};

pub struct CodecRegistry {
    backends: Vec<Arc<dyn CodecBackend>>,
}

impl Default for CodecRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl CodecRegistry {
    pub fn new() -> Self {
        Self {
            backends: vec![
                Arc::new(StaticCodecBackend::new(&STORE)),
                Arc::new(StaticCodecBackend::new(&DEFLATE)),
                Arc::new(StaticCodecBackend::new(&ZSTD)),
                Arc::new(StaticCodecBackend::new(&LZMA2)),
                Arc::new(StaticCodecBackend::new(&BZIP2)),
            ],
        }
    }

    pub fn backends(&self) -> &[Arc<dyn CodecBackend>] {
        &self.backends
    }

    pub fn find_by_name(&self, name: &str) -> Option<Arc<dyn CodecBackend>> {
        self.backends
            .iter()
            .find(|backend| backend.descriptor().matches_name(name))
            .cloned()
    }
}

struct StaticCodecBackend {
    descriptor: &'static CodecDescriptor,
}

impl StaticCodecBackend {
    const fn new(descriptor: &'static CodecDescriptor) -> Self {
        Self { descriptor }
    }

    fn unsupported_label(&self, operation: &str) -> String {
        format!(
            "{operation} is not implemented yet for {}",
            self.descriptor.name
        )
    }
}

impl CodecBackend for StaticCodecBackend {
    fn descriptor(&self) -> &'static CodecDescriptor {
        self.descriptor
    }

    fn encode(
        &self,
        _request: &CodecOperationRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        Ok(OperationReport::unsupported(
            OperationFamily::Codec,
            Some(self.descriptor.name.to_string()),
            "encode",
            self.unsupported_label("encode"),
            Some(execution),
        ))
    }

    fn decode(
        &self,
        _request: &CodecOperationRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        Ok(OperationReport::unsupported(
            OperationFamily::Codec,
            Some(self.descriptor.name.to_string()),
            "decode",
            self.unsupported_label("decode"),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> CodecCapabilities {
        CodecCapabilities {
            encode: false,
            decode: false,
            threads: ThreadCapability::single_threaded(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::CodecRegistry;

    #[test]
    fn registry_contains_planned_backends() {
        let registry = CodecRegistry::new();
        let names = registry
            .backends()
            .iter()
            .map(|backend| backend.descriptor().name)
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["store", "deflate", "zstd", "lzma2", "bzip2"]);
    }
}
