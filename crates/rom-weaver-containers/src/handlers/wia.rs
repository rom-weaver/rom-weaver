use super::nod_shared::nod_extract_only_handler;
use super::*;

nod_extract_only_handler!(WIA_NOD_CORE, WiaContainerHandler, &WIA, NodFormat::Wia);
