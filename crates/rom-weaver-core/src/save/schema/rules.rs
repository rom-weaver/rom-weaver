use std::{fmt, sync::Arc};

use super::{Storage, check_nonempty_span, invalid};
use crate::{Result, RomWeaverError, ValidationCodeError};

#[derive(Clone, Debug)]
pub struct Scalar {
    pub offset: usize,
    pub storage: Storage,
    pub mask: Option<u32>,
}

impl Scalar {
    pub fn validate(&self, size: usize) -> Result<()> {
        let width = self.width()?;
        check_nonempty_span(self.offset, width, size, "scalar")?;
        if let Some(mask) = self.mask {
            let bits = width * 8;
            if mask == 0 || (bits < 32 && mask >> bits != 0) {
                return Err(invalid("a scalar mask must fit its storage"));
            }
        }
        Ok(())
    }

    pub fn width(&self) -> Result<usize> {
        match self.storage {
            Storage::U8 | Storage::I8 | Storage::Bool => Ok(1),
            Storage::U16Le | Storage::U16Be | Storage::I16Le | Storage::I16Be => Ok(2),
            Storage::U24Le | Storage::U24Be => Ok(3),
            Storage::U32Le | Storage::U32Be | Storage::I32Le | Storage::I32Be => Ok(4),
            _ => Err(invalid("rule scalars require binary integer storage")),
        }
    }

    pub fn read(&self, bytes: &[u8]) -> Result<i64> {
        self.validate(bytes.len())?;
        let width = self.width()?;
        let data = &bytes[self.offset..self.offset + width];
        let big_endian = matches!(
            self.storage,
            Storage::U16Be | Storage::U24Be | Storage::U32Be | Storage::I16Be | Storage::I32Be
        );
        let mut value = 0u32;
        for (index, byte) in data.iter().enumerate() {
            let shift = if big_endian { width - index - 1 } else { index } * 8;
            value |= u32::from(*byte) << shift;
        }
        if let Some(mask) = self.mask {
            return Ok(i64::from((value & mask) >> mask.trailing_zeros()));
        }
        Ok(match self.storage {
            Storage::I8 => i64::from(value as i8),
            Storage::I16Le | Storage::I16Be => i64::from(value as i16),
            Storage::I32Le | Storage::I32Be => i64::from(value as i32),
            _ => i64::from(value),
        })
    }

    pub fn write(&self, bytes: &mut [u8], value: i64) -> Result<()> {
        self.validate(bytes.len())?;
        let width = self.width()?;
        let signed = matches!(
            self.storage,
            Storage::I8 | Storage::I16Le | Storage::I16Be | Storage::I32Le | Storage::I32Be
        );
        let bits = width * 8;
        let (min, max) = if let Some(mask) = self.mask {
            (0, i64::from(mask >> mask.trailing_zeros()))
        } else if signed {
            (-(1i64 << (bits - 1)), (1i64 << (bits - 1)) - 1)
        } else {
            (0, (1i64 << bits) - 1)
        };
        if value < min || value > max {
            return Err(invalid("a rule result does not fit its destination"));
        }
        let value = if let Some(mask) = self.mask {
            let raw = Scalar {
                mask: None,
                ..self.clone()
            }
            .read(bytes)? as u32;
            (raw & !mask) | (((value as u32) << mask.trailing_zeros()) & mask)
        } else {
            value as u32
        };
        let big_endian = matches!(
            self.storage,
            Storage::U16Be | Storage::U24Be | Storage::U32Be | Storage::I16Be | Storage::I32Be
        );
        for index in 0..width {
            let shift = if big_endian { width - index - 1 } else { index } * 8;
            bytes[self.offset + index] = (value >> shift) as u8;
        }
        Ok(())
    }
}

type ReadCallback = dyn Fn(&[u8]) -> Result<i64> + Send + Sync;
type ConditionCallback = dyn Fn(&[u8]) -> Result<bool> + Send + Sync;

#[derive(Clone)]
pub struct ReadValue(Arc<ReadCallback>);

impl ReadValue {
    pub fn new(read: impl Fn(&[u8]) -> Result<i64> + Send + Sync + 'static) -> Self {
        Self(Arc::new(read))
    }
    pub fn eval(&self, bytes: &[u8]) -> Result<i64> {
        (self.0)(bytes)
    }
}

impl fmt::Debug for ReadValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ReadValue(..)")
    }
}

#[derive(Clone)]
pub struct Condition(Arc<ConditionCallback>);

impl Condition {
    pub fn new(test: impl Fn(&[u8]) -> Result<bool> + Send + Sync + 'static) -> Self {
        Self(Arc::new(test))
    }
    pub fn test(&self, bytes: &[u8]) -> Result<bool> {
        (self.0)(bytes)
    }
}

impl fmt::Debug for Condition {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Condition(..)")
    }
}

#[derive(Clone, Debug)]
pub struct Check {
    pub when: Option<Condition>,
    pub assert: Condition,
    pub code: String,
    pub message: String,
    pub section_id: Option<u8>,
    pub warning: Option<String>,
}

impl Check {
    pub fn validate(&self, _size: usize) -> Result<()> {
        super::bounded_text(&self.code, "check code")?;
        super::bounded_text(&self.message, "check message")
    }
    pub fn run(&self, bytes: &[u8]) -> Result<()> {
        if self
            .when
            .as_ref()
            .map(|when| when.test(bytes))
            .transpose()?
            .unwrap_or(true)
            && !self.assert.test(bytes)?
        {
            return Err(RomWeaverError::ValidationCode(
                ValidationCodeError::new(self.code.clone()).with_message(self.message.clone()),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct Store {
    pub when: Option<Condition>,
    pub destination: Scalar,
    pub value: ReadValue,
}

impl Store {
    pub fn validate(&self, size: usize) -> Result<()> {
        self.destination.validate(size)
    }
    pub fn apply(&self, bytes: &mut [u8]) -> Result<()> {
        if self
            .when
            .as_ref()
            .map(|when| when.test(bytes))
            .transpose()?
            .unwrap_or(true)
        {
            let value = self.value.eval(bytes)?;
            self.destination.write(bytes, value)?;
        }
        Ok(())
    }
}
