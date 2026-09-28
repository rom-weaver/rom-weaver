use serde::{Deserialize, Serialize};

use super::{Storage, check_nonempty_span, invalid};
use crate::{Result, RomWeaverError, ValidationCodeError};

const MAX_DEPTH: usize = 16;
const MAX_NODES: usize = 4096;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Scalar {
    pub offset: usize,
    #[serde(default)]
    pub relative: bool,
    #[serde(rename = "type")]
    pub storage: Storage,
    pub mask: Option<u32>,
}

impl Scalar {
    pub fn shift(&mut self, base: usize, bits: usize, bit_stride: bool) -> Result<()> {
        if !self.relative {
            return Ok(());
        }
        let bit = if bit_stride {
            let mask = self
                .mask
                .ok_or_else(|| invalid("bit-strided rule scalars require a single-bit mask"))?;
            if !mask.is_power_of_two() {
                return Err(invalid(
                    "bit-strided rule scalars require a single-bit mask",
                ));
            }
            mask.trailing_zeros() as usize
        } else {
            0
        };
        let displacement = bits
            .checked_add(bit)
            .ok_or_else(|| invalid("record rule bit offset overflows"))?;
        self.offset = self
            .offset
            .checked_add(base)
            .and_then(|offset| offset.checked_add(displacement / 8))
            .ok_or_else(|| invalid("record rule offset overflows"))?;
        if bit_stride {
            self.mask = Some(1 << (displacement % 8));
        }
        self.relative = false;
        Ok(())
    }
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub(super) enum Expr {
    Constant(i64),
    Operation(Operation),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Operation {
    Read(Scalar),
    Add(Vec<Expr>),
    Sub([Box<Expr>; 2]),
    Mul([Box<Expr>; 2]),
    Div([Box<Expr>; 2]),
    Mod([Box<Expr>; 2]),
    BitAnd([Box<Expr>; 2]),
    BitOr([Box<Expr>; 2]),
    Xor([Box<Expr>; 2]),
    If {
        condition: Box<Predicate>,
        then: Box<Expr>,
        otherwise: Box<Expr>,
    },
    At {
        offset: Box<Expr>,
        #[serde(rename = "type")]
        storage: Storage,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Predicate {
    All(Vec<Predicate>),
    Any(Vec<Predicate>),
    Not(Box<Predicate>),
    Eq([Expr; 2]),
    Ne([Expr; 2]),
    Lt([Expr; 2]),
    Le([Expr; 2]),
    Uniform {
        offset: usize,
        length: usize,
        values: Vec<u8>,
    },
    Equal {
        left: usize,
        right: usize,
        length: usize,
    },
}

impl Expr {
    pub fn work_bytes(&self) -> Result<usize> {
        match self {
            Self::Constant(_) => Ok(8),
            Self::Operation(op) => match op {
                Operation::Read(scalar) => scalar.width(),
                Operation::Add(terms) => sum_work(terms.iter().map(Self::work_bytes)),
                Operation::Sub(pair)
                | Operation::Mul(pair)
                | Operation::Div(pair)
                | Operation::Mod(pair)
                | Operation::BitAnd(pair)
                | Operation::BitOr(pair)
                | Operation::Xor(pair) => sum_work(pair.iter().map(|term| term.work_bytes())),
                Operation::If {
                    condition,
                    then,
                    otherwise,
                } => sum_work([
                    condition.work_bytes(),
                    then.work_bytes(),
                    otherwise.work_bytes(),
                ]),
                Operation::At { offset, .. } => sum_work([Ok(4), offset.work_bytes()]),
            },
        }
    }
    pub fn shift(&mut self, base: usize, bits: usize, bit_stride: bool) -> Result<()> {
        let Self::Operation(op) = self else {
            return Ok(());
        };
        match op {
            Operation::Read(scalar) => scalar.shift(base, bits, bit_stride),
            Operation::Add(terms) => {
                for term in terms {
                    term.shift(base, bits, bit_stride)?;
                }
                Ok(())
            }
            Operation::Sub(terms)
            | Operation::Mul(terms)
            | Operation::Div(terms)
            | Operation::Mod(terms)
            | Operation::BitAnd(terms)
            | Operation::BitOr(terms)
            | Operation::Xor(terms) => {
                for term in terms {
                    term.shift(base, bits, bit_stride)?;
                }
                Ok(())
            }
            Operation::If {
                condition,
                then,
                otherwise,
            } => {
                condition.shift(base, bits, bit_stride)?;
                then.shift(base, bits, bit_stride)?;
                otherwise.shift(base, bits, bit_stride)
            }
            Operation::At { offset, .. } => offset.shift(base, bits, bit_stride),
        }
    }
    pub fn validate(&self, size: usize) -> Result<()> {
        {
            let mut budget = MAX_NODES;
            self.check(size, 0, &mut budget)
        }
    }

    fn check(&self, size: usize, depth: usize, budget: &mut usize) -> Result<()> {
        consume(depth, budget)?;
        let Self::Operation(op) = self else {
            return Ok(());
        };
        match op {
            Operation::Read(scalar) => scalar.validate(size),
            Operation::Add(terms) => {
                for term in terms {
                    term.check(size, depth + 1, budget)?;
                }
                Ok(())
            }
            Operation::Sub(pair)
            | Operation::Mul(pair)
            | Operation::Div(pair)
            | Operation::Mod(pair)
            | Operation::BitAnd(pair)
            | Operation::BitOr(pair)
            | Operation::Xor(pair) => {
                for term in pair {
                    term.check(size, depth + 1, budget)?;
                }
                Ok(())
            }
            Operation::If {
                condition,
                then,
                otherwise,
            } => {
                condition.check(size, depth + 1, budget)?;
                then.check(size, depth + 1, budget)?;
                otherwise.check(size, depth + 1, budget)
            }
            Operation::At { offset, storage } => {
                Scalar {
                    offset: 0,
                    relative: false,
                    storage: *storage,
                    mask: None,
                }
                .validate(size)?;
                offset.check(size, depth + 1, budget)
            }
        }
    }

    pub fn eval(&self, bytes: &[u8]) -> Result<i64> {
        let Self::Operation(op) = self else {
            let Self::Constant(value) = self else {
                unreachable!()
            };
            return Ok(*value);
        };
        let overflow = || invalid("save schema arithmetic is out of range");
        match op {
            Operation::Read(scalar) => scalar.read(bytes),
            Operation::Add(terms) => terms.iter().try_fold(0i64, |value, term| {
                value.checked_add(term.eval(bytes)?).ok_or_else(overflow)
            }),
            Operation::If {
                condition,
                then,
                otherwise,
            } => {
                if condition.test(bytes)? {
                    then.eval(bytes)
                } else {
                    otherwise.eval(bytes)
                }
            }
            Operation::At { offset, storage } => Scalar {
                offset: usize::try_from(offset.eval(bytes)?).map_err(|_| overflow())?,
                relative: false,
                storage: *storage,
                mask: None,
            }
            .read(bytes),
            Operation::Sub(pair)
            | Operation::Mul(pair)
            | Operation::Div(pair)
            | Operation::Mod(pair)
            | Operation::BitAnd(pair)
            | Operation::BitOr(pair)
            | Operation::Xor(pair) => {
                let a = pair[0].eval(bytes)?;
                let b = pair[1].eval(bytes)?;
                match op {
                    Operation::Sub(_) => a.checked_sub(b),
                    Operation::Mul(_) => a.checked_mul(b),
                    Operation::Div(_) => a.checked_div(b),
                    Operation::Mod(_) => a.checked_rem(b),
                    Operation::BitAnd(_) => Some(a & b),
                    Operation::BitOr(_) => Some(a | b),
                    Operation::Xor(_) => Some(a ^ b),
                    _ => unreachable!(),
                }
                .ok_or_else(overflow)
            }
        }
    }
}

impl Predicate {
    pub fn work_bytes(&self) -> Result<usize> {
        match self {
            Self::All(terms) | Self::Any(terms) => sum_work(terms.iter().map(Self::work_bytes)),
            Self::Not(term) => term.work_bytes(),
            Self::Eq(pair) | Self::Ne(pair) | Self::Lt(pair) | Self::Le(pair) => {
                sum_work(pair.iter().map(Expr::work_bytes))
            }
            Self::Uniform { length, .. } => Ok(*length),
            Self::Equal { length, .. } => length
                .checked_mul(2)
                .ok_or_else(|| invalid("schema work exceeds its budget")),
        }
    }
    pub fn shift(&mut self, base: usize, bits: usize, bit_stride: bool) -> Result<()> {
        match self {
            Self::All(terms) | Self::Any(terms) => {
                for term in terms {
                    term.shift(base, bits, bit_stride)?;
                }
                Ok(())
            }
            Self::Not(term) => term.shift(base, bits, bit_stride),
            Self::Eq(terms) | Self::Ne(terms) | Self::Lt(terms) | Self::Le(terms) => {
                for term in terms {
                    term.shift(base, bits, bit_stride)?;
                }
                Ok(())
            }
            Self::Uniform { .. } | Self::Equal { .. } => Ok(()),
        }
    }
    pub fn validate(&self, size: usize) -> Result<()> {
        {
            let mut budget = MAX_NODES;
            self.check(size, 0, &mut budget)
        }
    }

    fn check(&self, size: usize, depth: usize, budget: &mut usize) -> Result<()> {
        consume(depth, budget)?;
        match self {
            Self::All(terms) | Self::Any(terms) => {
                for term in terms {
                    term.check(size, depth + 1, budget)?;
                }
                Ok(())
            }
            Self::Not(term) => term.check(size, depth + 1, budget),
            Self::Eq(pair) | Self::Ne(pair) | Self::Lt(pair) | Self::Le(pair) => {
                for term in pair {
                    term.check(size, depth + 1, budget)?;
                }
                Ok(())
            }
            Self::Uniform {
                offset,
                length,
                values,
            } => {
                if values.is_empty() || values.len() > 256 {
                    return Err(invalid("uniform checks require 1 to 256 byte values"));
                }
                check_nonempty_span(*offset, *length, size, "uniform check")
            }
            Self::Equal {
                left,
                right,
                length,
            } => {
                check_nonempty_span(*left, *length, size, "equality check")?;
                check_nonempty_span(*right, *length, size, "equality check")
            }
        }
    }

    pub fn test(&self, bytes: &[u8]) -> Result<bool> {
        match self {
            Self::All(terms) => {
                for term in terms {
                    if !term.test(bytes)? {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
            Self::Any(terms) => {
                for term in terms {
                    if term.test(bytes)? {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            Self::Not(term) => Ok(!term.test(bytes)?),
            Self::Eq(pair) | Self::Ne(pair) | Self::Lt(pair) | Self::Le(pair) => {
                let a = pair[0].eval(bytes)?;
                let b = pair[1].eval(bytes)?;
                Ok(match self {
                    Self::Eq(_) => a == b,
                    Self::Ne(_) => a != b,
                    Self::Lt(_) => a < b,
                    Self::Le(_) => a <= b,
                    _ => unreachable!(),
                })
            }
            Self::Uniform {
                offset,
                length,
                values,
            } => {
                check_nonempty_span(*offset, *length, bytes.len(), "uniform check")?;
                let data = &bytes[*offset..*offset + *length];
                Ok(values.contains(&data[0]) && data.iter().all(|byte| *byte == data[0]))
            }
            Self::Equal {
                left,
                right,
                length,
            } => {
                check_nonempty_span(*left, *length, bytes.len(), "equality check")?;
                check_nonempty_span(*right, *length, bytes.len(), "equality check")?;
                Ok(bytes[*left..*left + *length] == bytes[*right..*right + *length])
            }
        }
    }
}

fn consume(depth: usize, budget: &mut usize) -> Result<()> {
    if depth > MAX_DEPTH || *budget == 0 {
        return Err(invalid(
            "schema expressions exceed their depth or work limit",
        ));
    }
    *budget -= 1;
    Ok(())
}

pub(super) fn sum_work(work: impl IntoIterator<Item = Result<usize>>) -> Result<usize> {
    work.into_iter().try_fold(0usize, |total, next| {
        total
            .checked_add(next?)
            .filter(|total| *total <= super::MAX_INTEGRITY_BYTES)
            .ok_or_else(|| invalid("schema work exceeds 64 MiB"))
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Check {
    pub when: Option<Predicate>,
    pub assert: Predicate,
    pub code: String,
    pub message: String,
    pub section_id: Option<u8>,
    pub warning: Option<String>,
}

impl Check {
    pub fn work_bytes(&self) -> Result<usize> {
        sum_work(
            self.when
                .iter()
                .map(Predicate::work_bytes)
                .chain(std::iter::once(self.assert.work_bytes())),
        )
    }
    pub fn validate(&self, size: usize) -> Result<()> {
        super::bounded_text(&self.code, "check code")?;
        super::bounded_text(&self.message, "check message")?;
        if let Some(when) = &self.when {
            when.validate(size)?;
        }
        self.assert.validate(size)
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Store {
    pub when: Option<Predicate>,
    pub destination: Scalar,
    pub value: Expr,
}

impl Store {
    pub fn work_bytes(&self) -> Result<usize> {
        sum_work(
            self.when
                .iter()
                .map(Predicate::work_bytes)
                .chain([self.destination.width(), self.value.work_bytes()]),
        )
    }
    pub fn validate(&self, size: usize) -> Result<()> {
        if let Some(when) = &self.when {
            when.validate(size)?;
        }
        self.destination.validate(size)?;
        self.value.validate(size)
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
