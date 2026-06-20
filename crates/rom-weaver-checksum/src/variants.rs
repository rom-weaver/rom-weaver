//! Streaming checksum-variant engine shared by the `checksum` command and the
//! extract write path.
//!
//! ROM dumps frequently differ from their canonical No-Intro/Redump entry only
//! by a removable copier header, an incorrect internal header checksum, or an
//! N64 byte order. Rather than force the user to guess which transform a tool
//! expects, the engine folds every applicable transform into the same forward
//! pass over the bytes and emits one checksum per *variant*.
//!
//! It is push-based and streaming-only (no random access), so the exact same
//! code can hash a file on disk (the `checksum` command) or hash decoded output
//! chunks as they are written during extraction. Feed bytes in order with
//! [`StreamingVariantChecksums::update`] and collect the rows with
//! [`StreamingVariantChecksums::finalize`].
//!
//! The one transform whose corrected bytes can sit *before* the data they are
//! derived from (`fix-header`: Genesis sums to EOF, N64 over a 1 MiB boot range)
//! is handled with a bounded prefix buffer — see [`FixHeader`]. When that buffer
//! would exceed [`FIX_HEADER_PREFIX_CAP`] the variant is returned *deferred*
//! (patches only, no digest) so the caller can compute it with a single extra
//! read; see [`overlay_checksums`].

use std::collections::BTreeMap;
use std::io::Read;

use rom_weaver_core::{Result, RomWeaverError};
use serde_json::{Value, json};
use tracing::{trace, warn};

use crate::rom_headers::{
    GBA_HEADER_MAGIC, KnownRomHeader, KnownRomHeaderMatch, N64_BIG_ENDIAN_MAGIC,
    N64_BYTE_SWAPPED_MAGIC, N64_LITTLE_ENDIAN_MAGIC, PCE_COPIER_HEADER_MODULUS, ROM_HEADER_BYTES,
    ROM_HEADER_SCAN_BYTES, SNES_COPIER_HEADER_MODULUS,
};
use crate::{StreamingChecksum, StreamingChecksumTiming};

/// Largest prefix the `fix-header` variant will buffer in memory to keep the
/// hash single-pass. Beyond this the variant is deferred to the caller. Sized
/// well above the largest real Genesis cart (~10 MiB) and the N64 boot window
/// (~1 MiB) so the deferral path is a safety valve, not a routine case.
pub const FIX_HEADER_PREFIX_CAP: u64 = 64 * 1024 * 1024;

const PLAN_SCAN_BYTES: u64 = ROM_HEADER_SCAN_BYTES as u64;

/// One emitted variant: a transform applied to the source plus its digests.
#[derive(Clone, Debug)]
pub struct VariantRow {
    pub id: String,
    pub label: String,
    pub checksums: BTreeMap<String, String>,
    pub apply_compatibility: Value,
    pub transforms: Value,
}

impl VariantRow {
    /// JSON shape shared by the `checksum` command's `checksum_variants` details and the extract
    /// `emitted_files[].checksum_variants` entries, so both surfaces emit byte-identical rows
    /// (asserted by the `extract_checksum_variants_match_checksum_command` parity test).
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "label": self.label,
            "checksums": self.checksums,
            "applyCompatibility": self.apply_compatibility,
            "transforms": self.transforms,
        })
    }
}

/// A `fix-header` variant that exceeded [`FIX_HEADER_PREFIX_CAP`]: its repair
/// patches are known, but the caller must apply them in a separate read to
/// produce the digest (e.g. via [`overlay_checksums`]).
#[derive(Clone, Debug)]
pub struct DeferredFixHeader {
    pub id: String,
    pub label: String,
    pub apply_compatibility: Value,
    pub transforms: Value,
    pub patches: BTreeMap<u64, Vec<u8>>,
}

/// Result of finalizing the engine: the in-pass variant rows plus an optional
/// deferred `fix-header` the caller still needs to compute.
#[derive(Clone, Debug)]
pub struct VariantOutput {
    pub rows: Vec<VariantRow>,
    pub deferred_fix_header: Option<DeferredFixHeader>,
    /// Hashing timing for the `raw` variant (the file's primary checksum), so an
    /// inline-extract caller can report how much of the checksum overlapped decode.
    /// Default (not threaded) when the raw variant ran the synchronous fan-out.
    pub raw_timing: StreamingChecksumTiming,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum N64Order {
    BigEndian,
    LittleEndian,
    ByteSwapped,
}

impl N64Order {
    const ALL: [Self; 3] = [Self::BigEndian, Self::LittleEndian, Self::ByteSwapped];

    fn id(self) -> &'static str {
        match self {
            Self::BigEndian => "big-endian",
            Self::LittleEndian => "little-endian",
            Self::ByteSwapped => "byte-swapped",
        }
    }

    fn detect(prefix: &[u8]) -> Option<Self> {
        if prefix.len() < 4 {
            return None;
        }
        match &prefix[..4] {
            magic if magic == N64_BIG_ENDIAN_MAGIC => Some(Self::BigEndian),
            magic if magic == N64_LITTLE_ENDIAN_MAGIC => Some(Self::LittleEndian),
            magic if magic == N64_BYTE_SWAPPED_MAGIC => Some(Self::ByteSwapped),
            _ => None,
        }
    }

    fn transform(self, bytes: &mut [u8; 4]) {
        match self {
            Self::BigEndian => {}
            Self::LittleEndian => bytes.reverse(),
            Self::ByteSwapped => {
                bytes.swap(0, 1);
                bytes.swap(2, 3);
            }
        }
    }

    /// Read a 4-byte word stored in `bytes` (original on-disk order) as a
    /// big-endian value after normalizing for this byte order.
    fn word_normalized(self, bytes: [u8; 4]) -> u32 {
        let mut bytes = bytes;
        self.transform(&mut bytes);
        u32::from_be_bytes(bytes)
    }

    /// Re-encode a big-endian value into this byte order's on-disk layout.
    fn word_original_order(self, value: u32) -> [u8; 4] {
        let mut bytes = value.to_be_bytes();
        self.transform(&mut bytes);
        bytes
    }
}

/// Per-variant transform applied to each chunk before hashing.
enum Transform {
    Raw,
    RemoveHeader {
        stripped: u64,
    },
    N64ByteOrder {
        source: N64Order,
        target: N64Order,
        carry: Vec<u8>,
    },
}

struct VariantHasher {
    id: String,
    label: String,
    apply_compatibility: Value,
    transforms: Value,
    transform: Transform,
    checksum: StreamingChecksum,
}

impl VariantHasher {
    fn update(&mut self, offset: u64, chunk: &[u8]) -> Result<()> {
        match &mut self.transform {
            Transform::Raw => self.checksum.update(chunk),
            Transform::RemoveHeader { stripped } => {
                let chunk_end = offset.saturating_add(chunk.len() as u64);
                if chunk_end <= *stripped {
                    return Ok(());
                }
                let start = stripped.saturating_sub(offset).min(chunk.len() as u64) as usize;
                self.checksum.update(&chunk[start..])
            }
            Transform::N64ByteOrder {
                source,
                target,
                carry,
            } => {
                if source == target {
                    return self.checksum.update(chunk);
                }
                let mut buffer = std::mem::take(carry);
                buffer.extend_from_slice(chunk);
                let full = buffer.len() - (buffer.len() % 4);
                let mut transformed = Vec::with_capacity(full);
                for word in buffer[..full].chunks_exact(4) {
                    let mut bytes = [word[0], word[1], word[2], word[3]];
                    source.transform(&mut bytes);
                    target.transform(&mut bytes);
                    transformed.extend_from_slice(&bytes);
                }
                *carry = buffer[full..].to_vec();
                self.checksum.update_owned(transformed)
            }
        }
    }

    fn finalize(self) -> Result<VariantRow> {
        Ok(self.finalize_timed()?.0)
    }

    fn finalize_timed(self) -> Result<(VariantRow, StreamingChecksumTiming)> {
        let (checksums, timing) = self.checksum.finalize_timed()?;
        Ok((
            VariantRow {
                id: self.id,
                label: self.label,
                checksums,
                apply_compatibility: self.apply_compatibility,
                transforms: self.transforms,
            },
            timing,
        ))
    }
}

/// Running accumulator for the Genesis 16-bit big-endian word sum over a range.
struct SegaAccumulator {
    start: u64,
    end: u64,
    sum: u32,
    pending_high: Option<u8>,
}

impl SegaAccumulator {
    fn feed(&mut self, offset: u64, chunk: &[u8]) {
        for (index, value) in chunk.iter().enumerate() {
            let absolute = offset.saturating_add(index as u64);
            if absolute < self.start || absolute >= self.end {
                continue;
            }
            if let Some(high) = self.pending_high.take() {
                let word = u16::from_be_bytes([high, *value]);
                self.sum = self.sum.wrapping_add(u32::from(word));
            } else {
                self.pending_high = Some(*value);
            }
        }
    }
}

/// Running accumulator for the N64 boot-code CRC pair over `[start, end)`.
struct N64Accumulator {
    order: N64Order,
    start: u64,
    end: u64,
    word: Vec<u8>,
    t1: u32,
    t2: u32,
    t3: u32,
    t4: u32,
    t5: u32,
    t6: u32,
}

impl N64Accumulator {
    fn new(order: N64Order, start: u64, end: u64) -> Self {
        let seed = 0xF8CA_4DDCu32;
        Self {
            order,
            start,
            end,
            word: Vec::with_capacity(4),
            t1: seed,
            t2: seed,
            t3: seed,
            t4: seed,
            t5: seed,
            t6: seed,
        }
    }

    fn feed(&mut self, offset: u64, chunk: &[u8]) {
        for (index, value) in chunk.iter().enumerate() {
            let absolute = offset.saturating_add(index as u64);
            if absolute < self.start || absolute >= self.end {
                continue;
            }
            self.word.push(*value);
            if self.word.len() == 4 {
                let raw = [self.word[0], self.word[1], self.word[2], self.word[3]];
                self.word.clear();
                self.consume_word(self.order.word_normalized(raw));
            }
        }
    }

    fn consume_word(&mut self, d: u32) {
        if self.t6.wrapping_add(d) < self.t6 {
            self.t4 = self.t4.wrapping_add(1);
        }
        self.t6 = self.t6.wrapping_add(d);
        self.t3 ^= d;
        let shift = d & 0x1F;
        let rotated = if shift == 0 { d } else { d.rotate_left(shift) };
        self.t5 = self.t5.wrapping_add(rotated);
        if self.t2 > d {
            self.t2 ^= rotated;
        } else {
            self.t2 ^= self.t6 ^ d;
        }
        self.t1 = self.t1.wrapping_add(self.t5 ^ d);
    }

    fn crc_pair(&self) -> (u32, u32) {
        (self.t6 ^ self.t4 ^ self.t3, self.t5 ^ self.t2 ^ self.t1)
    }
}

/// GBA repair patch, fully computable from the header prefix.
struct GbaRepair {
    offset: u64,
    corrected: u8,
}

/// Genesis repair patch: known offset, corrected value pending the streamed sum.
struct SegaRepair {
    offset: u64,
    old_checksum: u16,
    accumulator: SegaAccumulator,
}

/// N64 repair patch pair: known offsets, corrected values pending the streamed CRC.
struct N64Repair {
    crc1_offset: u64,
    crc2_offset: u64,
    old_crc1: u32,
    old_crc2: u32,
    accumulator: N64Accumulator,
}

/// The `fix-header` variant: corrects internal header checksums, buffering the
/// prefix up to `flush_offset` so the bytes can be patched in their original
/// order before hashing.
struct FixHeader {
    checksum: Option<StreamingChecksum>,
    flush_offset: u64,
    cap_exceeded: bool,
    flushed: bool,
    prefix: Vec<u8>,
    gba: Option<GbaRepair>,
    sega: Option<SegaRepair>,
    n64: Option<N64Repair>,
}

impl FixHeader {
    fn feed(&mut self, offset: u64, chunk: &[u8]) -> Result<()> {
        if let Some(sega) = self.sega.as_mut() {
            sega.accumulator.feed(offset, chunk);
        }
        if let Some(n64) = self.n64.as_mut() {
            n64.accumulator.feed(offset, chunk);
        }

        if self.cap_exceeded {
            return Ok(());
        }

        if self.flushed {
            if let Some(checksum) = self.checksum.as_mut() {
                checksum.update(chunk)?;
            }
            return Ok(());
        }

        let chunk_end = offset.saturating_add(chunk.len() as u64);
        if chunk_end <= self.flush_offset {
            self.prefix.extend_from_slice(chunk);
            if chunk_end == self.flush_offset {
                self.flush()?;
            }
            return Ok(());
        }

        // This chunk crosses the flush boundary: buffer the prefix portion,
        // flush, then hash the remainder live.
        let split = (self.flush_offset - offset) as usize;
        self.prefix.extend_from_slice(&chunk[..split]);
        self.flush()?;
        if let Some(checksum) = self.checksum.as_mut() {
            checksum.update(&chunk[split..])?;
        }
        Ok(())
    }

    /// Resolve every pending repair, patch the buffered prefix, and fold it into
    /// the hash. Leaves `flushed = true`.
    fn flush(&mut self) -> Result<()> {
        let patches = self.resolve_patches();
        if patches.is_empty() {
            // Nothing to repair: the variant collapses to `raw` and is dropped.
            self.checksum = None;
            self.flushed = true;
            self.prefix = Vec::new();
            return Ok(());
        }
        for (offset, bytes) in &patches {
            let start = *offset as usize;
            let end = start + bytes.len();
            if end <= self.prefix.len() {
                self.prefix[start..end].copy_from_slice(bytes);
            }
        }
        if let Some(checksum) = self.checksum.as_mut() {
            checksum.update(&self.prefix)?;
        }
        self.flushed = true;
        self.prefix = Vec::new();
        Ok(())
    }

    fn resolve_patches(&self) -> BTreeMap<u64, Vec<u8>> {
        let mut patches = BTreeMap::new();
        if let Some(gba) = self.gba.as_ref() {
            patches.insert(gba.offset, vec![gba.corrected]);
        }
        if let Some(sega) = self.sega.as_ref() {
            let new_checksum = (sega.accumulator.sum & 0xFFFF) as u16;
            if sega.old_checksum != new_checksum {
                patches.insert(sega.offset, new_checksum.to_be_bytes().to_vec());
            }
        }
        if let Some(n64) = self.n64.as_ref() {
            let (new_crc1, new_crc2) = n64.accumulator.crc_pair();
            if n64.old_crc1 != new_crc1 {
                patches.insert(
                    n64.crc1_offset,
                    n64.accumulator.order.word_original_order(new_crc1).to_vec(),
                );
            }
            if n64.old_crc2 != new_crc2 {
                patches.insert(
                    n64.crc2_offset,
                    n64.accumulator.order.word_original_order(new_crc2).to_vec(),
                );
            }
        }
        patches
    }

    fn repaired_profiles(&self, patches: &BTreeMap<u64, Vec<u8>>) -> Vec<&'static str> {
        let mut profiles = Vec::new();
        if self.gba.is_some() {
            profiles.push("gba");
        }
        if let Some(sega) = self.sega.as_ref()
            && patches.contains_key(&sega.offset)
        {
            profiles.push("sega-genesis");
        }
        if let Some(n64) = self.n64.as_ref()
            && (patches.contains_key(&n64.crc1_offset) || patches.contains_key(&n64.crc2_offset))
        {
            profiles.push("n64");
        }
        profiles
    }

    fn into_output(mut self) -> Result<FixHeaderOutcome> {
        // Ensure accumulators are finalized even if the stream ended before the
        // flush boundary (should not happen for valid inputs).
        let patches = self.resolve_patches();
        if patches.is_empty() {
            return Ok(FixHeaderOutcome::None);
        }
        let repaired = self.repaired_profiles(&patches);
        let apply_compatibility = json!({
            "fixChecksum": true,
            "repair_checksum": true,
        });
        let transforms = json!({
            "fixChecksum": {
                "repairedProfiles": repaired,
            }
        });
        if self.cap_exceeded {
            warn!(
                flush_offset = self.flush_offset,
                cap = FIX_HEADER_PREFIX_CAP,
                "fix-header variant deferred: repair dependency exceeds in-memory prefix cap"
            );
            return Ok(FixHeaderOutcome::Deferred(DeferredFixHeader {
                id: "fix-header".to_string(),
                label: "Fix header".to_string(),
                apply_compatibility,
                transforms,
                patches,
            }));
        }
        if !self.flushed {
            self.flush()?;
        }
        let Some(checksum) = self.checksum.take() else {
            return Ok(FixHeaderOutcome::None);
        };
        Ok(FixHeaderOutcome::Row(VariantRow {
            id: "fix-header".to_string(),
            label: "Fix header".to_string(),
            checksums: checksum.finalize()?,
            apply_compatibility,
            transforms,
        }))
    }
}

enum FixHeaderOutcome {
    None,
    Row(VariantRow),
    Deferred(DeferredFixHeader),
}

struct Planned {
    raw: VariantHasher,
    remove_header: Option<VariantHasher>,
    fix: Option<FixHeader>,
    n64_orders: Vec<VariantHasher>,
}

enum State {
    Buffering,
    Planned(Box<Planned>),
    Empty,
}

/// Push-based engine that computes all applicable checksum variants in one pass.
pub struct StreamingVariantChecksums {
    algorithms: Vec<String>,
    total_len: u64,
    extension: Option<String>,
    consumed: u64,
    header_buf: Vec<u8>,
    state: State,
    /// Total worker-thread budget split across the active variants' hashers so their
    /// crc32/md5/sha1 run in parallel and overlap the producer. 1 (or non-threaded wasm)
    /// → every variant hashes synchronously.
    hash_thread_budget: usize,
}

impl StreamingVariantChecksums {
    /// Create an engine for `algorithms` over a stream of exactly `total_len`
    /// bytes. `total_len` is authoritative for header/size-rule detection.
    ///
    /// `name_hint` is the source's file name (or path); its extension drives
    /// extension-ordered header candidate selection and the SNES/PCE copier
    /// size rules, matching the file-based detection used elsewhere.
    pub fn new(
        algorithms: &[String],
        total_len: u64,
        name_hint: Option<&str>,
        hash_thread_budget: usize,
    ) -> Result<Self> {
        let extension = name_hint
            .and_then(extension_with_dot)
            .map(|value| value.to_ascii_lowercase());
        Ok(Self {
            algorithms: algorithms.to_vec(),
            total_len,
            extension,
            consumed: 0,
            header_buf: Vec::new(),
            state: State::Buffering,
            hash_thread_budget: hash_thread_budget.max(1),
        })
    }

    /// Feed the next ordered slice of source bytes.
    pub fn update(&mut self, bytes: &[u8]) -> Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        match &mut self.state {
            State::Empty => {
                self.consumed = self.consumed.saturating_add(bytes.len() as u64);
                Ok(())
            }
            State::Buffering => {
                let offset = self.consumed;
                self.header_buf.extend_from_slice(bytes);
                self.consumed = self.consumed.saturating_add(bytes.len() as u64);
                let scan_target = PLAN_SCAN_BYTES.min(self.total_len);
                if self.header_buf.len() as u64 >= scan_target || self.consumed >= self.total_len {
                    self.plan(offset)?;
                }
                Ok(())
            }
            State::Planned(_) => {
                let offset = self.consumed;
                self.feed_planned(offset, bytes)?;
                self.consumed = self.consumed.saturating_add(bytes.len() as u64);
                Ok(())
            }
        }
    }

    /// Finalize and return the variant rows plus any deferred `fix-header`.
    pub fn finalize(mut self) -> Result<VariantOutput> {
        if matches!(self.state, State::Buffering) {
            // Stream shorter than the scan window: plan now from what we have.
            self.plan(0)?;
        }
        let State::Planned(planned) = self.state else {
            return Ok(VariantOutput {
                rows: Vec::new(),
                deferred_fix_header: None,
                raw_timing: StreamingChecksumTiming::default(),
            });
        };
        let Planned {
            raw,
            remove_header,
            fix,
            n64_orders,
        } = *planned;

        let mut rows = Vec::new();
        let (raw_row, raw_timing) = raw.finalize_timed()?;
        rows.push(raw_row);
        if let Some(remove_header) = remove_header {
            rows.push(remove_header.finalize()?);
        }
        let mut deferred_fix_header = None;
        if let Some(fix) = fix {
            match fix.into_output()? {
                FixHeaderOutcome::None => {}
                FixHeaderOutcome::Row(row) => rows.push(row),
                FixHeaderOutcome::Deferred(deferred) => deferred_fix_header = Some(deferred),
            }
        }
        for variant in n64_orders {
            rows.push(variant.finalize()?);
        }
        Ok(VariantOutput {
            rows,
            deferred_fix_header,
            raw_timing,
        })
    }

    fn feed_planned(&mut self, offset: u64, bytes: &[u8]) -> Result<()> {
        let State::Planned(planned) = &mut self.state else {
            return Ok(());
        };
        planned.raw.update(offset, bytes)?;
        if let Some(remove_header) = planned.remove_header.as_mut() {
            remove_header.update(offset, bytes)?;
        }
        if let Some(fix) = planned.fix.as_mut() {
            fix.feed(offset, bytes)?;
        }
        for variant in &mut planned.n64_orders {
            variant.update(offset, bytes)?;
        }
        Ok(())
    }

    /// Build the active variant set from the buffered header + total length,
    /// then replay the buffered bytes through it.
    fn plan(&mut self, _offset: u64) -> Result<()> {
        let header = std::mem::take(&mut self.header_buf);
        // Build every applicable variant with a synchronous hasher first so the active count is
        // known, then split the worker budget across them and upgrade each to a parallel hasher.
        // Each variant only differs from `raw` by its transform and is fed the same bytes (one
        // read), but the hashing is independent — giving each its own workers lets them overlap the
        // producer instead of serializing on the decode thread.
        let Some(raw_checksum) = StreamingChecksum::new(&self.algorithms)? else {
            self.state = State::Empty;
            return Ok(());
        };
        let mut raw = VariantHasher {
            id: "raw".to_string(),
            label: "Raw".to_string(),
            apply_compatibility: json!({}),
            transforms: json!({}),
            transform: Transform::Raw,
            checksum: raw_checksum,
        };

        let mut remove_header = self.plan_remove_header(&header)?;
        let mut fix = self.plan_fix_header(&header)?;
        let mut n64_orders = self.plan_n64_orders(&header)?;

        // Split the budget evenly across the active variants. `raw` is always active; a `fix-header`
        // only counts when it hashes in-pass (it carries no hasher when deferred over the prefix
        // cap). `new_parallel` internally caps each variant at its algorithm count, so a share
        // larger than the algorithm count is harmless. A share of 1 leaves the synchronous hasher
        // in place, so an over-subscribed case (many variants, small budget) degrades to the prior
        // fully-inline behavior rather than spawning more workers than the op budgeted.
        let active = 1
            + usize::from(remove_header.is_some())
            + usize::from(fix.as_ref().is_some_and(|fix| fix.checksum.is_some()))
            + n64_orders.len();
        let per_variant = (self.hash_thread_budget / active).max(1);
        Self::upgrade_variant_checksum(&mut raw.checksum, &self.algorithms, per_variant)?;
        if let Some(remove_header) = remove_header.as_mut() {
            Self::upgrade_variant_checksum(
                &mut remove_header.checksum,
                &self.algorithms,
                per_variant,
            )?;
        }
        for variant in &mut n64_orders {
            Self::upgrade_variant_checksum(&mut variant.checksum, &self.algorithms, per_variant)?;
        }
        if let Some(fix) = fix.as_mut()
            && let Some(checksum) = fix.checksum.as_mut()
        {
            Self::upgrade_variant_checksum(checksum, &self.algorithms, per_variant)?;
        }

        self.state = State::Planned(Box::new(Planned {
            raw,
            remove_header,
            fix,
            n64_orders,
        }));

        // Replay the buffered header bytes (offset 0..header.len()).
        let header_len = header.len() as u64;
        self.feed_planned(0, &header)?;
        // `consumed` already counted the header bytes during buffering.
        let _ = header_len;
        Ok(())
    }

    /// Replace a freshly-built synchronous variant hasher with a parallel one when the variant's
    /// thread share allows it. No bytes have been fed yet, so swapping the hasher is safe; a share
    /// of 1 (or the non-threaded wasm build) leaves the synchronous hasher untouched.
    fn upgrade_variant_checksum(
        checksum: &mut StreamingChecksum,
        algorithms: &[String],
        per_variant: usize,
    ) -> Result<()> {
        if per_variant <= 1 {
            return Ok(());
        }
        if let Some(parallel) = StreamingChecksum::new_parallel(algorithms, per_variant)? {
            *checksum = parallel;
        }
        Ok(())
    }

    fn plan_remove_header(&self, header: &[u8]) -> Result<Option<VariantHasher>> {
        let Some(header_match) =
            detect_strippable_rom_header(header, self.total_len, self.extension.as_deref())
        else {
            return Ok(None);
        };
        let Some(stripped) = header_match.stripped_bytes() else {
            return Ok(None);
        };
        let Some(checksum) = StreamingChecksum::new(&self.algorithms)? else {
            return Ok(None);
        };
        Ok(Some(VariantHasher {
            id: "remove-header".to_string(),
            label: "Remove header".to_string(),
            apply_compatibility: json!({
                "removeHeader": true,
                "strip_header": true,
            }),
            transforms: json!({
                "removeHeader": {
                    "profile": header_match.profile_name(),
                    "strippedBytes": stripped,
                }
            }),
            transform: Transform::RemoveHeader {
                stripped: stripped as u64,
            },
            checksum,
        }))
    }

    fn plan_n64_orders(&self, header: &[u8]) -> Result<Vec<VariantHasher>> {
        if !self.total_len.is_multiple_of(4) {
            return Ok(Vec::new());
        }
        let Some(source) = N64Order::detect(header) else {
            return Ok(Vec::new());
        };
        let mut variants = Vec::with_capacity(N64Order::ALL.len());
        for target in N64Order::ALL {
            let Some(checksum) = StreamingChecksum::new(&self.algorithms)? else {
                continue;
            };
            variants.push(VariantHasher {
                id: format!("n64-byte-order:{}", target.id()),
                label: format!("N64 byte order: {}", target.id()),
                apply_compatibility: json!({
                    "n64ByteOrder": target.id(),
                    "n64_byte_order": target.id(),
                }),
                transforms: json!({
                    "n64ByteOrder": {
                        "detected": source.id(),
                        "sourceOrder": source.id(),
                        "targetOrder": target.id(),
                    }
                }),
                transform: Transform::N64ByteOrder {
                    source,
                    target,
                    carry: Vec::new(),
                },
                checksum,
            });
        }
        Ok(variants)
    }

    fn plan_fix_header(&self, header: &[u8]) -> Result<Option<FixHeader>> {
        let gba = plan_gba_repair(header, self.total_len);
        let sega = plan_sega_repair(header, self.total_len);
        let n64 = plan_n64_repair(header, self.total_len);
        if gba.is_none() && sega.is_none() && n64.is_none() {
            return Ok(None);
        }

        let mut flush_offset = 0u64;
        if let Some(gba) = gba.as_ref() {
            flush_offset = flush_offset.max(gba.offset + 1);
        }
        if let Some(sega) = sega.as_ref() {
            flush_offset = flush_offset.max(sega.accumulator.end);
        }
        if let Some(n64) = n64.as_ref() {
            flush_offset = flush_offset.max(n64.accumulator.end);
        }
        let cap_exceeded = flush_offset > FIX_HEADER_PREFIX_CAP;
        let checksum = if cap_exceeded {
            None
        } else {
            StreamingChecksum::new(&self.algorithms)?
        };
        trace!(
            flush_offset,
            cap_exceeded,
            gba = gba.is_some(),
            sega = sega.is_some(),
            n64 = n64.is_some(),
            "planned fix-header variant"
        );
        Ok(Some(FixHeader {
            checksum,
            flush_offset,
            cap_exceeded,
            flushed: false,
            prefix: Vec::new(),
            gba,
            sega,
            n64,
        }))
    }
}

fn plan_gba_repair(header: &[u8], total_len: u64) -> Option<GbaRepair> {
    if total_len < 0x1BE || header.len() < 0x1BE {
        return None;
    }
    if header[0x04..0x08] != GBA_HEADER_MAGIC {
        return None;
    }
    let old_checksum = header[0x1BD];
    let mut checksum = 0i32;
    for value in &header[0xA0..=0xBC] {
        checksum -= i32::from(*value);
    }
    let corrected = ((checksum - 0x19) & 0xFF) as u8;
    if old_checksum == corrected {
        return None;
    }
    Some(GbaRepair {
        offset: 0x1BD,
        corrected,
    })
}

fn plan_sega_repair(header: &[u8], total_len: u64) -> Option<SegaRepair> {
    if total_len <= 0x18F || total_len < 0x200 || header.len() < 0x190 {
        return None;
    }
    let sega_probe = &header[0x100..0x105];
    if sega_probe[0..4] != *b"SEGA" && sega_probe[1..5] != *b"SEGA" {
        return None;
    }
    let old_checksum = u16::from_be_bytes([header[0x18E], header[0x18F]]);
    Some(SegaRepair {
        offset: 0x18E,
        old_checksum,
        accumulator: SegaAccumulator {
            start: 0x200,
            end: total_len,
            sum: 0,
            pending_high: None,
        },
    })
}

fn plan_n64_repair(header: &[u8], total_len: u64) -> Option<N64Repair> {
    if total_len < 0x101000 || header.len() < 0x18 {
        return None;
    }
    let order = N64Order::detect(header)?;
    let old_crc1 = order.word_normalized([header[0x10], header[0x11], header[0x12], header[0x13]]);
    let old_crc2 = order.word_normalized([header[0x14], header[0x15], header[0x16], header[0x17]]);
    Some(N64Repair {
        crc1_offset: 0x10,
        crc2_offset: 0x14,
        old_crc1,
        old_crc2,
        accumulator: N64Accumulator::new(order, 0x1000, 0x101000),
    })
}

/// Mirror of the file-based strippable-header detection, but driven by an
/// in-memory prefix + the known total length + an optional file extension so it
/// works during streaming. Matches `header_detection_and_finalize`'s logic.
fn detect_strippable_rom_header(
    prefix: &[u8],
    total_len: u64,
    extension: Option<&str>,
) -> Option<KnownRomHeaderMatch> {
    let mut matched = detect_known_rom_header_from_prefix(prefix, extension);
    if matched.and_then(|value| value.stripped_bytes()).is_none() {
        matched = detect_size_based_copier_header(extension, total_len);
    }
    let header_match = matched?;
    let header_len = header_match.stripped_bytes()?;
    if total_len < header_len as u64 {
        return None;
    }
    Some(header_match)
}

/// Header candidates ordered by extension match first, then the rest, mirroring
/// `known_header_candidates_for_path`.
fn detect_known_rom_header_from_prefix(
    prefix: &[u8],
    extension: Option<&str>,
) -> Option<KnownRomHeaderMatch> {
    for header in known_header_candidates(extension) {
        if header.signature_matches(prefix) {
            return Some(KnownRomHeaderMatch {
                header,
                stripped_bytes: header.data_offset_bytes(),
            });
        }
    }
    None
}

fn known_header_candidates(extension: Option<&str>) -> Vec<KnownRomHeader> {
    let mut candidates = Vec::with_capacity(KnownRomHeader::ALL.len());
    if let Some(extension) = extension {
        for header in KnownRomHeader::ALL {
            if header.matches_extension(extension) {
                candidates.push(header);
            }
        }
    }
    for header in KnownRomHeader::ALL {
        if !candidates.contains(&header) {
            candidates.push(header);
        }
    }
    candidates
}

/// SNES/PCE copier detection by extension + size modulus, matching
/// `detect_size_based_copier_header`.
fn detect_size_based_copier_header(
    extension: Option<&str>,
    total_len: u64,
) -> Option<KnownRomHeaderMatch> {
    if total_len <= ROM_HEADER_BYTES as u64 {
        return None;
    }
    let extension = extension?;
    if extension_matches(extension, &[".smc", ".sfc"])
        && total_len % SNES_COPIER_HEADER_MODULUS == ROM_HEADER_BYTES as u64
    {
        return Some(KnownRomHeaderMatch {
            header: KnownRomHeader::SnesCopier,
            stripped_bytes: Some(ROM_HEADER_BYTES),
        });
    }
    if extension_matches(extension, &[".pce", ".tg16"])
        && total_len % PCE_COPIER_HEADER_MODULUS == ROM_HEADER_BYTES as u64
    {
        return Some(KnownRomHeaderMatch {
            header: KnownRomHeader::PceCopier,
            stripped_bytes: Some(ROM_HEADER_BYTES),
        });
    }
    None
}

fn extension_matches(extension: &str, candidates: &[&str]) -> bool {
    candidates
        .iter()
        .any(|candidate| extension.eq_ignore_ascii_case(candidate))
}

/// Extract a `.ext` suffix (lowercased by the caller) from a file name/path.
fn extension_with_dot(name: &str) -> Option<String> {
    let name = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let dot = name.rfind('.')?;
    if dot == 0 || dot + 1 >= name.len() {
        return None;
    }
    Some(name[dot..].to_string())
}

/// Complete a deferred `fix-header` variant (if any) by applying its repair patches in one extra
/// read of `path`, appending the finished row to `rows`. The engine defers only the digest — the
/// patches are already known — when the repair dependency exceeds [`FIX_HEADER_PREFIX_CAP`]. Both
/// variant callers (the `checksum` command and the extract write path) finish it this same way; a
/// `None` deferral is a no-op so callers can pipe `VariantOutput::deferred_fix_header` straight in.
pub fn finish_deferred_fix_header(
    rows: &mut Vec<VariantRow>,
    deferred: Option<DeferredFixHeader>,
    algorithms: &[String],
    path: &std::path::Path,
) -> Result<()> {
    let Some(deferred) = deferred else {
        return Ok(());
    };
    let mut file = std::fs::File::open(path)?;
    let checksums = overlay_checksums(&mut file, algorithms, &deferred.patches)?;
    rows.push(VariantRow {
        id: deferred.id,
        label: deferred.label,
        checksums,
        apply_compatibility: deferred.apply_compatibility,
        transforms: deferred.transforms,
    });
    Ok(())
}

/// Compute checksums for a stream after applying a sparse byte overlay. Used to
/// produce a deferred `fix-header` digest in a single extra read.
pub fn overlay_checksums<R: Read>(
    reader: &mut R,
    algorithms: &[String],
    patches: &BTreeMap<u64, Vec<u8>>,
) -> Result<BTreeMap<String, String>> {
    let Some(mut checksum) = StreamingChecksum::new(algorithms)? else {
        return Ok(BTreeMap::new());
    };
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut offset = 0u64;
    loop {
        let read = reader.read(&mut buffer).map_err(RomWeaverError::from)?;
        if read == 0 {
            break;
        }
        let chunk_start = offset;
        let chunk_end = offset + read as u64;
        let mut patched: Option<Vec<u8>> = None;
        for (patch_offset, patch_bytes) in patches {
            let patch_end = patch_offset + patch_bytes.len() as u64;
            if patch_end <= chunk_start || *patch_offset >= chunk_end {
                continue;
            }
            let target = patched.get_or_insert_with(|| buffer[..read].to_vec());
            let write_start = patch_offset.saturating_sub(chunk_start) as usize;
            let source_start = chunk_start.saturating_sub(*patch_offset) as usize;
            let write_len = (patch_bytes.len() - source_start).min(target.len() - write_start);
            target[write_start..write_start + write_len]
                .copy_from_slice(&patch_bytes[source_start..source_start + write_len]);
        }
        match patched {
            Some(bytes) => checksum.update_owned(bytes)?,
            None => checksum.update(&buffer[..read])?,
        }
        offset = chunk_end;
    }
    checksum.finalize()
}
