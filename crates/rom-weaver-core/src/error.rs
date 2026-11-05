use std::{
    borrow::Cow,
    fmt, io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;
#[cfg(feature = "typescript-types")]
use ts_rs::TS;

use crate::error_codes::{ERROR_CODE_IO_STORAGE_FULL, ERROR_CODE_RESOURCE_OUT_OF_MEMORY};

/// Fields recovered from a rendered `(key=value, ...)` tag.
type DisplayFields = Map<String, Value>;

pub type Result<T> = std::result::Result<T, RomWeaverError>;

/// Stable [`RomWeaverError`] classification generated into TypeScript for the
/// worker-error layer. Snake-case variant names are part of the JS contract; see
/// `packages/rom-weaver-webapp/src/wasm/workers/worker-error-utils.ts`.
///
/// Kinds are coarse (both validation variants map to `Validation`). Contract
/// tests lock the message-prefix and kind mappings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum RomWeaverErrorKind {
    Validation,
    UnknownFormat,
    Unsupported,
    Cancelled,
    Io,
    ThreadPoolBuild,
}

impl RomWeaverErrorKind {
    /// The canonical [`RomWeaverError`] display prefix of each kind. Typegen
    /// emits this table for the worker-error fallback that classifies errors
    /// arriving in JS without a typed kind.
    pub const MESSAGE_PREFIXES: &'static [(&'static str, RomWeaverErrorKind)] = &[
        ("validation failed:", RomWeaverErrorKind::Validation),
        ("unknown format for path", RomWeaverErrorKind::UnknownFormat),
        ("unsupported operation:", RomWeaverErrorKind::Unsupported),
        ("operation cancelled", RomWeaverErrorKind::Cancelled),
        ("i/o error:", RomWeaverErrorKind::Io),
        (
            "thread pool build failed:",
            RomWeaverErrorKind::ThreadPoolBuild,
        ),
    ];

    /// Classify a bare [`RomWeaverError`] display string by its canonical prefix.
    /// This populates typed progress-event errors. Contract tests lock the
    /// display/classifier/[`RomWeaverError::kind`] round trip.
    pub fn classify_message(message: &str) -> Option<Self> {
        Self::MESSAGE_PREFIXES
            .iter()
            .find(|(prefix, _)| message.starts_with(prefix))
            .map(|(_, kind)| *kind)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationCodeError {
    code: Cow<'static, str>,
    message: Option<Cow<'static, str>>,
    fields: Vec<ValidationField>,
}

impl ValidationCodeError {
    pub fn new(code: impl Into<Cow<'static, str>>) -> Self {
        Self {
            code: code.into(),
            message: None,
            fields: Vec::new(),
        }
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn fields(&self) -> &[ValidationField] {
        &self.fields
    }

    pub fn message(&self) -> Option<&str> {
        self.message.as_deref()
    }

    /// The fields as a JSON object for the `error_fields` of a failed event;
    /// `None` when there are none.
    pub fn fields_json(&self) -> Option<Map<String, Value>> {
        (!self.fields.is_empty()).then(|| {
            self.fields
                .iter()
                .map(|field| (field.key.to_owned(), field.value.to_json()))
                .collect()
        })
    }

    /// Recover the code and fields that `Display` rendered at the end of
    /// `text` as `[code]` or `[code] (key=value, ...)`. Failure reports whose
    /// label wraps a coded error in context text use this to keep the code.
    /// A code without a message renders bare and is not recoverable, and a
    /// text field value containing `, ` splits into extra fields.
    pub fn parse_display_tag(text: &str) -> Option<(String, Option<DisplayFields>)> {
        Self::split_display_tag(text).map(|(_, code, fields)| (code, fields))
    }

    /// [`Self::parse_display_tag`] that also returns the text before the tag.
    /// The tag is the last bracket group holding a dotted code that ends the
    /// text, so a path such as `Hack [v1.1] (USA).zip` earlier in the label is
    /// not mistaken for one.
    pub fn split_display_tag(text: &str) -> Option<(&str, String, Option<DisplayFields>)> {
        let text = text.trim_end();
        // A field value may contain `, ` or read like a tag. A candidate whose fields do not all
        // parse as `key=value` pairs is kept as a fallback, unless a candidate further left parses.
        let mut lenient = None;
        for (open, _) in text.rmatch_indices('[') {
            let before = &text[..open];
            if !(before.is_empty() || before.ends_with(' ')) {
                continue;
            }
            let Some((code, tail)) = text[open + 1..].split_once(']') else {
                continue;
            };
            if !is_display_code(code) {
                continue;
            }
            let fields = match tail {
                "" => None,
                _ => match tail
                    .strip_prefix(" (")
                    .and_then(|rest| rest.strip_suffix(')'))
                {
                    Some(fields) => Some(fields),
                    None => continue,
                },
            };
            let parsed = fields.map(parse_display_fields);
            if parsed.as_ref().is_some_and(Option::is_none) {
                if fields.is_some_and(starts_with_display_field) {
                    lenient.get_or_insert((before, code));
                }
                continue;
            }
            return Some((before.trim_end(), code.to_owned(), parsed.flatten()));
        }
        lenient.map(|(before, code)| (before.trim_end(), code.to_owned(), None))
    }

    pub fn with_message(mut self, message: impl Into<Cow<'static, str>>) -> Self {
        self.message = Some(message.into());
        self
    }

    pub fn with_field(mut self, key: &'static str, value: impl Into<ValidationFieldValue>) -> Self {
        self.push_field(key, value);
        self
    }

    pub fn push_field(&mut self, key: &'static str, value: impl Into<ValidationFieldValue>) {
        self.fields.push(ValidationField {
            key,
            value: value.into(),
        });
    }
}

/// An engine code: dotted lowercase segments such as `patch.checksum_mismatch`.
fn is_display_code(code: &str) -> bool {
    let mut segments = 0;
    for segment in code.split('.') {
        let valid = !segment.is_empty()
            && segment
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
        if !valid {
            return false;
        }
        segments += 1;
    }
    segments > 1
}

fn is_display_field_key(key: &str) -> bool {
    !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn starts_with_display_field(fields: &str) -> bool {
    fields
        .split_once('=')
        .is_some_and(|(key, _)| is_display_field_key(key))
}

fn parse_display_fields(text: &str) -> Option<Map<String, Value>> {
    text.split(", ")
        .map(|pair| {
            let (key, value) = pair.split_once('=')?;
            is_display_field_key(key).then(|| (key.to_owned(), parse_display_field_value(value)))
        })
        .collect()
}

fn parse_display_field_value(value: &str) -> Value {
    if let Ok(flag) = value.parse::<bool>() {
        return Value::Bool(flag);
    }
    if let Ok(number) = value.parse::<u64>() {
        return Value::from(number);
    }
    if let Ok(number) = value.parse::<i64>() {
        return Value::from(number);
    }
    Value::String(value.to_owned())
}

impl fmt::Display for ValidationCodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(message) = &self.message {
            write!(f, "{} [{}]", message, self.code)?;
        } else {
            write!(f, "{}", self.code)?;
        }
        if self.fields.is_empty() {
            return Ok(());
        }

        write!(f, " (")?;
        for (index, field) in self.fields.iter().enumerate() {
            if index > 0 {
                write!(f, ", ")?;
            }
            write!(f, "{}={}", field.key, field.value)?;
        }
        write!(f, ")")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationField {
    pub key: &'static str,
    pub value: ValidationFieldValue,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationFieldValue {
    Bool(bool),
    I64(i64),
    U64(u64),
    Usize(usize),
    Text(String),
}

impl fmt::Display for ValidationFieldValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Bool(value) => write!(f, "{value}"),
            Self::I64(value) => write!(f, "{value}"),
            Self::U64(value) => write!(f, "{value}"),
            Self::Usize(value) => write!(f, "{value}"),
            Self::Text(value) => write!(f, "{value}"),
        }
    }
}

impl ValidationFieldValue {
    pub fn to_json(&self) -> Value {
        match self {
            Self::Bool(value) => Value::Bool(*value),
            Self::I64(value) => Value::from(*value),
            Self::U64(value) => Value::from(*value),
            Self::Usize(value) => Value::from(*value),
            Self::Text(value) => Value::String(value.clone()),
        }
    }
}

impl From<bool> for ValidationFieldValue {
    fn from(value: bool) -> Self {
        Self::Bool(value)
    }
}

macro_rules! impl_from_signed {
    ($($type:ty),* $(,)?) => {
        $(
            impl From<$type> for ValidationFieldValue {
                fn from(value: $type) -> Self {
                    Self::I64(value as i64)
                }
            }
        )*
    };
}

macro_rules! impl_from_unsigned {
    ($($type:ty),* $(,)?) => {
        $(
            impl From<$type> for ValidationFieldValue {
                fn from(value: $type) -> Self {
                    Self::U64(value as u64)
                }
            }
        )*
    };
}

impl_from_signed!(i8, i16, i32, i64);
impl_from_unsigned!(u8, u16, u32, u64);

impl From<usize> for ValidationFieldValue {
    fn from(value: usize) -> Self {
        Self::Usize(value)
    }
}

impl From<String> for ValidationFieldValue {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}

impl From<&str> for ValidationFieldValue {
    fn from(value: &str) -> Self {
        Self::Text(value.to_owned())
    }
}

#[derive(Debug, Error)]
pub enum RomWeaverError {
    #[error("validation failed: {0}")]
    Validation(String),
    #[error("validation failed: {0}")]
    ValidationCode(ValidationCodeError),
    #[error("unknown format for path `{path}`")]
    UnknownFormat { path: PathBuf },
    #[error("unsupported operation: {0}")]
    Unsupported(UnsupportedOp),
    #[error("operation cancelled")]
    Cancelled,
    #[error("i/o error: {0}{tag}", tag = io_code_tag(.0))]
    Io(#[from] io::Error),
    /// An i/o failure that knows which path and operation produced it. Prefer
    /// this over the bare [`RomWeaverError::Io`] anywhere a user-supplied path
    /// is opened, created, or removed: `Permission denied (os error 13)` on its
    /// own tells nobody which file to fix.
    #[error(
        "i/o error: cannot {op} `{}`: {source}{}{}",
        path.display(),
        advice_suffix(advice.as_deref()),
        io_code_tag(source)
    )]
    IoPath {
        op: IoOp,
        path: PathBuf,
        /// Actionable, platform-specific guidance captured when the error was
        /// built (see [`crate::access_advice`]). Held as text so `Display` stays
        /// syscall-free.
        advice: Option<String>,
        source: io::Error,
    },
    #[error("thread pool build failed: {0}")]
    ThreadPoolBuild(String),
}

/// The stable code of an i/o failure the webapp distinguishes by its kind.
fn io_code(source: &io::Error) -> Option<&'static str> {
    match source.kind() {
        io::ErrorKind::StorageFull => Some(ERROR_CODE_IO_STORAGE_FULL),
        io::ErrorKind::OutOfMemory => Some(ERROR_CODE_RESOURCE_OUT_OF_MEMORY),
        _ => None,
    }
}

/// Tags a storage-full or out-of-memory failure with its code, so a report
/// whose label wraps the error in context text still carries it (see
/// [`ValidationCodeError::parse_display_tag`]).
fn io_code_tag(source: &io::Error) -> String {
    io_code(source).map_or_else(String::new, |code| format!(" [{code}]"))
}

fn advice_suffix(advice: Option<&str>) -> String {
    advice
        .map(|advice| format!(" ({advice})"))
        .unwrap_or_default()
}

/// The filesystem operation an [`RomWeaverError::IoPath`] failed during. The
/// `Display` verb is spliced straight into the message, so it reads as
/// "cannot open `/roms/game.iso`".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IoOp {
    Open,
    Create,
    Write,
    CreateDir,
    ReadDir,
    Inspect,
}

impl fmt::Display for IoOp {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let verb = match self {
            Self::Open => "open",
            Self::Create => "create",
            Self::Write => "write to",
            Self::CreateDir => "create directory",
            Self::ReadDir => "list directory",
            Self::Inspect => "inspect",
        };
        formatter.write_str(verb)
    }
}

/// Attaches the failing operation and path to a bare [`io::Error`], turning it
/// into a [`RomWeaverError::IoPath`]. The path is only cloned - and the advice
/// only gathered - on the error branch.
pub trait IoResultExt<T> {
    fn io_op(self, op: IoOp, path: impl AsRef<Path>) -> Result<T>;
}

impl<T> IoResultExt<T> for std::result::Result<T, io::Error> {
    fn io_op(self, op: IoOp, path: impl AsRef<Path>) -> Result<T> {
        self.map_err(|source| RomWeaverError::io_path(op, path.as_ref(), source))
    }
}

impl RomWeaverError {
    /// Build an [`RomWeaverError::IoPath`], gathering permission advice when the
    /// failure is an access denial. Callers usually reach this through
    /// [`IoResultExt::io_op`].
    pub fn io_path(op: IoOp, path: impl AsRef<Path>, source: io::Error) -> Self {
        let path = path.as_ref();
        let advice = (source.kind() == io::ErrorKind::PermissionDenied)
            .then(|| crate::access_advice(path))
            .flatten();
        Self::IoPath {
            op,
            path: path.to_path_buf(),
            advice,
            source,
        }
    }

    /// The path this error blames for an access denial, when it is one. Lets
    /// callers react to permission problems without matching on message text.
    pub fn permission_denied_path(&self) -> Option<&Path> {
        match self {
            Self::IoPath { path, source, .. }
                if source.kind() == io::ErrorKind::PermissionDenied =>
            {
                Some(path)
            }
            _ => None,
        }
    }

    /// A validation error with a stable code and a message.
    pub fn coded(code: &'static str, message: impl Into<Cow<'static, str>>) -> Self {
        Self::ValidationCode(ValidationCodeError::new(code).with_message(message))
    }

    /// No entry of `source` passed the `--filter` kind filter `filter`.
    /// `detail` is appended to the message (such as the candidate list).
    pub fn no_matching_extract_entries(source: &Path, filter: &str, detail: &str) -> Self {
        Self::ValidationCode(
            ValidationCodeError::new(crate::error_codes::ERROR_CODE_EXTRACT_NO_MATCHING_ENTRIES)
                .with_message(format!(
                    "no extract entries from `{}` matched {filter}{detail}",
                    source.display()
                ))
                .with_field("path", source.display().to_string())
                .with_field("filter", filter.to_string()),
        )
    }

    /// The stable code the webapp classifies this error by, if it has one.
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::ValidationCode(coded) => Some(coded.code()),
            Self::Io(source) | Self::IoPath { source, .. } => io_code(source),
            _ => None,
        }
    }

    /// The coded error's fields as a JSON object; `None` when there are none.
    pub fn fields_json(&self) -> Option<Map<String, Value>> {
        match self {
            Self::ValidationCode(coded) => coded.fields_json(),
            _ => None,
        }
    }

    /// Prefix the message with `context`. A [`ValidationCodeError`] keeps its
    /// code and fields; another error becomes a validation error, coded with
    /// `fallback_code` when one is given.
    pub fn with_context(
        self,
        context: impl fmt::Display,
        fallback_code: Option<&'static str>,
    ) -> Self {
        match self {
            Self::ValidationCode(mut coded) => {
                let message = format!("{context}: {}", coded.message().unwrap_or(coded.code()));
                coded.message = Some(message.into());
                Self::ValidationCode(coded)
            }
            other => {
                // An i/o code (storage full, out of memory) outranks the fallback: the
                // failure is about the device, not the data.
                let io_code = match &other {
                    Self::Io(source) | Self::IoPath { source, .. } => io_code(source),
                    _ => None,
                };
                let text = other.to_string();
                let text = io_code
                    .and_then(|code| text.strip_suffix(&format!(" [{code}]")))
                    .unwrap_or(&text);
                let message = format!("{context}: {text}");
                match io_code.or(fallback_code) {
                    Some(code) => {
                        Self::ValidationCode(ValidationCodeError::new(code).with_message(message))
                    }
                    None => Self::Validation(message),
                }
            }
        }
    }

    /// The canonical [`RomWeaverErrorKind`] for this error. The mapping (and
    /// each variant's `Display` prefix) is locked by the contract test in this
    /// module so the JS worker-error classifier cannot silently drift.
    pub fn kind(&self) -> RomWeaverErrorKind {
        match self {
            Self::Validation(_) | Self::ValidationCode(_) => RomWeaverErrorKind::Validation,
            Self::UnknownFormat { .. } => RomWeaverErrorKind::UnknownFormat,
            Self::Unsupported(_) => RomWeaverErrorKind::Unsupported,
            Self::Cancelled => RomWeaverErrorKind::Cancelled,
            Self::Io(_) | Self::IoPath { .. } => RomWeaverErrorKind::Io,
            Self::ThreadPoolBuild(_) => RomWeaverErrorKind::ThreadPoolBuild,
        }
    }
}

/// A specific reason an operation could not be carried out. Each variant is a
/// distinct, matchable case carrying typed fields rather than a free-form
/// string; the `Display` impl renders the user-facing message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnsupportedOp {
    /// A container handler does not implement a registry-level operation.
    FormatOperation {
        format: String,
        operation: FormatOperationKind,
    },
    /// A handler required for a feature is not registered.
    HandlerNotRegistered {
        handler: &'static str,
        feature: &'static str,
    },
    /// A format supports extraction but not creation.
    ExtractOnlyCreate {
        format: String,
        supported_create_formats: String,
    },
    /// A libarchive backend does not support the requested codec.
    LibarchiveCodec { format: String, codec: String },
    /// The rust CHD compressed-create encoder does not support a codec for the
    /// given media scope.
    ChdCodecForMedia { codec: String, scope: ChdMediaScope },
    /// A CHD codec is not valid for a named media kind.
    ChdCodecInvalidForMedia { codec: String, media: String },
    /// The CHD codec list as a whole is invalid for a named media kind.
    ChdCodecListInvalid { media: String },
    /// Patch creation is not implemented for a format.
    PatchCreateNotImplemented {
        format: &'static str,
        alternative: &'static str,
    },
    /// RUP patches with named file entries cannot be applied by single-file apply.
    RupNamedFileEntries,
    /// HDiffPatch directory (HDIFF19) patches cannot be applied by patch-apply.
    HdiffDirectoryPatch,
    /// The BSP patch asks the user to pick from an interactive menu, which apply cannot answer.
    BspInteractiveMenu,
    /// The rust CHD encoder only supports `avhuff` for `chav` frame inputs.
    ChdAvhuffRequiresChavFrames,
    /// The rust CHD create path only supports `store` mode for this input.
    ChdStoreModeOnly,
    /// CHD create against a parent needs at least one compressed codec.
    ChdParentRequiresCompression,
    /// avhuff encode exceeds the per-channel audio sample limit.
    ChdAvhuffSampleLimit { max_samples_per_channel: u32 },
}

/// Registry-level container operation that a handler may not implement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormatOperationKind {
    ListEntries,
    CreateDryRunSize,
}

impl FormatOperationKind {
    fn phrase(self) -> &'static str {
        match self {
            Self::ListEntries => "listing entries",
            Self::CreateDryRunSize => "create dry-run size measurement",
        }
    }
}

/// Media scope a CHD codec was rejected for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChdMediaScope {
    /// The current compressed-create media mode (no specific media label).
    CompressedMediaMode,
    /// Disc media.
    Disc,
}

impl ChdMediaScope {
    fn phrase(self) -> &'static str {
        match self {
            Self::CompressedMediaMode => "this media mode",
            Self::Disc => "disc media",
        }
    }
}

impl fmt::Display for UnsupportedOp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FormatOperation { format, operation } => {
                write!(f, "{format} does not support {}", operation.phrase())
            }
            Self::HandlerNotRegistered { handler, feature } => {
                write!(
                    f,
                    "{handler} handler is not registered; {feature} is unavailable"
                )
            }
            Self::ExtractOnlyCreate {
                format,
                supported_create_formats,
            } => write!(
                f,
                "{format} is extract-only; supported create formats are {supported_create_formats}"
            ),
            Self::LibarchiveCodec { format, codec } => {
                write!(f, "libarchive does not support {format} codec `{codec}`")
            }
            Self::ChdCodecForMedia { codec, scope } => write!(
                f,
                "rust chd compressed create does not support codec `{codec}` for {}",
                scope.phrase()
            ),
            Self::ChdCodecInvalidForMedia { codec, media } => {
                write!(f, "chd codec `{codec}` is not valid for {media} media")
            }
            Self::ChdCodecListInvalid { media } => {
                write!(f, "chd codec list is invalid for {media} media")
            }
            Self::PatchCreateNotImplemented {
                format,
                alternative,
            } => write!(
                f,
                "{format} patch creation is not implemented; use {alternative}"
            ),
            Self::RupNamedFileEntries => write!(
                f,
                "RUP patches with named file entries are not supported by single-file patch-apply"
            ),
            Self::HdiffDirectoryPatch => write!(
                f,
                "HDiffPatch directory patches (HDIFF19) are not supported for patch-apply; expected single-file patch (.hdiff/.hpatchz)"
            ),
            Self::BspInteractiveMenu => write!(
                f,
                "interactive BSP menus are not supported; use a BSP patcher that supports menu choices"
            ),
            Self::ChdAvhuffRequiresChavFrames => write!(
                f,
                "rust chd compressed create supports `avhuff` only for `chav` frame inputs"
            ),
            Self::ChdStoreModeOnly => write!(
                f,
                "rust chd create currently supports only raw/dvd/hd/disc `store` mode"
            ),
            Self::ChdParentRequiresCompression => write!(
                f,
                "chd create with parent requires at least one compressed codec; `store` mode cannot reference parent hunks"
            ),
            Self::ChdAvhuffSampleLimit {
                max_samples_per_channel,
            } => write!(
                f,
                "avhuff encode currently supports up to {max_samples_per_channel} audio samples per channel"
            ),
        }
    }
}

#[cfg(test)]
#[path = "../tests/unit/error.rs"]
mod tests;
