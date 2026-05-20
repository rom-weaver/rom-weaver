use std::{fmt, io, path::PathBuf};

use thiserror::Error;

pub type Result<T> = std::result::Result<T, RomWeaverError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationCodeError {
    code: &'static str,
    message: Option<&'static str>,
    fields: Vec<ValidationField>,
}

impl ValidationCodeError {
    pub fn new(code: &'static str) -> Self {
        Self {
            code,
            message: None,
            fields: Vec::new(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn fields(&self) -> &[ValidationField] {
        &self.fields
    }

    pub fn with_message(mut self, message: &'static str) -> Self {
        self.message = Some(message);
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

impl fmt::Display for ValidationCodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(message) = self.message {
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
    Unsupported(String),
    #[error("operation cancelled")]
    Cancelled,
    #[error("i/o error: {0}")]
    Io(#[from] io::Error),
    #[error("thread pool build failed: {0}")]
    ThreadPoolBuild(String),
}
