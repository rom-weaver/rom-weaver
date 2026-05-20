mod chd_handler {
    use super::*;

    include!("chd/types_and_read_session.rs");
    include!("chd/core.rs");
    include!("chd/disc_extract.rs");
    include!("chd/create_pipeline.rs");
    include!("chd/create_encoding.rs");
    include!("chd/infer.rs");
    include!("chd/handler_trait.rs");
}

use chd_handler::ChdContainerHandler;
