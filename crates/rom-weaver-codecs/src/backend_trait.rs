use super::*;
impl CodecBackend for NativeCodecBackend {
    fn descriptor(&self) -> &'static CodecDescriptor {
        self.descriptor
    }

    fn encode(
        &self,
        request: &CodecOperationRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        self.run_encode(request, context)
    }

    fn decode(
        &self,
        request: &CodecOperationRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        self.run_decode(request, context)
    }

    fn capabilities(&self) -> CodecCapabilities {
        CodecCapabilities {
            encode: true,
            decode: true,
            encode_threads: self.encode_thread_capability(),
            decode_threads: self.decode_thread_capability(),
        }
    }
}
