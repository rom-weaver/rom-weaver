use std::{
    collections::VecDeque,
    fs,
    fs::OpenOptions,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{Arc, Mutex},
};

use rom_weaver_core::{
    BlockCacheReader, RomWeaverError, SharedThreadPool, DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
    DEFAULT_BLOCK_CACHE_SIZE_BYTES,
};
use sha1::{Digest, Sha1};

type VmResult<T> = std::result::Result<T, String>;
const FILE_IO_CHUNK_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy)]
enum StepControl {
    Continue,
    Exit(u32),
}

enum VmOutcome {
    Success,
    Failure(u32),
}

enum PatchSpace<'a> {
    Borrowed(&'a [u8]),
    Owned(Vec<u8>),
    Cached {
        len: usize,
        reader: Arc<Mutex<BlockCacheReader>>,
    },
}

impl<'a> PatchSpace<'a> {
    fn len(&self) -> usize {
        match self {
            Self::Borrowed(bytes) => bytes.len(),
            Self::Owned(bytes) => bytes.len(),
            Self::Cached { len, .. } => *len,
        }
    }

    fn read_byte(&self, position: usize) -> VmResult<u8> {
        let mut byte = [0u8; 1];
        self.read_exact_into(position, &mut byte)?;
        Ok(byte[0])
    }

    fn read_halfword(&self, position: usize) -> VmResult<u16> {
        let mut word = [0u8; 2];
        self.read_exact_into(position, &mut word)?;
        Ok(u16::from_le_bytes(word))
    }

    fn read_word(&self, position: usize) -> VmResult<u32> {
        let mut word = [0u8; 4];
        self.read_exact_into(position, &mut word)?;
        Ok(u32::from_le_bytes(word))
    }

    fn read_vec(&self, start: usize, len: usize) -> VmResult<Vec<u8>> {
        let mut bytes = vec![0u8; len];
        self.read_exact_into(start, &mut bytes)?;
        Ok(bytes)
    }

    fn read_exact_into(&self, start: usize, output: &mut [u8]) -> VmResult<()> {
        let end = start
            .checked_add(output.len())
            .ok_or_else(|| "attempted to read past the end of the patch space".to_string())?;
        if end > self.len() {
            return Err("attempted to read past the end of the patch space".to_string());
        }

        match self {
            Self::Borrowed(bytes) => {
                output.copy_from_slice(&bytes[start..end]);
                Ok(())
            }
            Self::Owned(bytes) => {
                output.copy_from_slice(&bytes[start..end]);
                Ok(())
            }
            Self::Cached { reader, .. } => {
                let mut guard = reader
                    .lock()
                    .map_err(|_| "BSP patch block cache lock is poisoned".to_string())?;
                guard
                    .read_exact_at(start as u64, output)
                    .map_err(|error| format!("failed to read BSP patch data: {error}"))
            }
        }
    }
}

struct Frame<'a> {
    instruction_pointer: u32,
    variables: [u32; 256],
    patch_space: PatchSpace<'a>,
    stack: VecDeque<u32>,
    waiting_var: Option<u8>,
    message_buffer: String,
}

impl<'a> Frame<'a> {
    fn new(patch_space: PatchSpace<'a>) -> Self {
        Self {
            instruction_pointer: 0,
            variables: [0; 256],
            patch_space,
            stack: VecDeque::new(),
            waiting_var: None,
            message_buffer: String::new(),
        }
    }
}

struct VmFileBuffer {
    file: std::fs::File,
    len: usize,
}

impl VmFileBuffer {
    fn open(path: &Path) -> VmResult<Self> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .map_err(|error| format!("failed to open BSP file buffer: {error}"))?;
        let len = usize::try_from(
            file.metadata()
                .map_err(|error| format!("failed to read BSP file metadata: {error}"))?
                .len(),
        )
        .map_err(|_| "BSP file buffer length overflow".to_string())?;
        Ok(Self { file, len })
    }

    fn len(&self) -> usize {
        self.len
    }

    fn ensure_size(&mut self, size: u32) -> VmResult<()> {
        let size = usize::try_from(size).map_err(|_| "file buffer size overflow".to_string())?;
        if self.len < size {
            self.file
                .set_len(size as u64)
                .map_err(|error| format!("failed to grow BSP file buffer: {error}"))?;
            self.len = size;
        }
        Ok(())
    }

    fn truncate(&mut self, size: u32) -> VmResult<()> {
        let size = usize::try_from(size).map_err(|_| "file buffer size overflow".to_string())?;
        self.file
            .set_len(size as u64)
            .map_err(|error| format!("failed to truncate BSP file buffer: {error}"))?;
        self.len = size;
        Ok(())
    }

    fn write_at(&mut self, position: usize, bytes: &[u8]) -> VmResult<()> {
        let end = position
            .checked_add(bytes.len())
            .ok_or_else(|| "file buffer size overflow".to_string())?;
        if end > self.len {
            return Err("attempted to write past the end of the file buffer".to_string());
        }
        self.file
            .seek(SeekFrom::Start(position as u64))
            .map_err(|error| format!("failed to seek BSP file buffer: {error}"))?;
        self.file
            .write_all(bytes)
            .map_err(|error| format!("failed to write BSP file buffer: {error}"))?;
        Ok(())
    }

    fn read_exact_at(&mut self, position: usize, output: &mut [u8]) -> VmResult<()> {
        let end = position
            .checked_add(output.len())
            .ok_or_else(|| "file buffer size overflow".to_string())?;
        if end > self.len {
            return Err("attempted to read past the end of the file buffer".to_string());
        }
        self.file
            .seek(SeekFrom::Start(position as u64))
            .map_err(|error| format!("failed to seek BSP file buffer: {error}"))?;
        self.file
            .read_exact(output)
            .map_err(|error| format!("failed to read BSP file buffer: {error}"))?;
        Ok(())
    }

    fn read_vec_at(&mut self, position: usize, len: usize) -> VmResult<Vec<u8>> {
        let mut output = vec![0u8; len];
        self.read_exact_at(position, output.as_mut_slice())?;
        Ok(output)
    }

    fn write_range(&mut self, position: usize, data: &[u8]) -> VmResult<()> {
        if data.is_empty() {
            return Ok(());
        }
        self.write_at(position, data)
    }

    fn xor_range(&mut self, position: usize, data: &[u8]) -> VmResult<()> {
        if data.is_empty() {
            return Ok(());
        }
        let end = position
            .checked_add(data.len())
            .ok_or_else(|| "attempted to read past the end of the file buffer".to_string())?;
        if end > self.len {
            return Err("attempted to read past the end of the file buffer".to_string());
        }
        let mut processed = 0usize;
        while processed < data.len() {
            let chunk_len = (data.len() - processed).min(FILE_IO_CHUNK_BYTES);
            let offset = position + processed;
            let mut chunk = self.read_vec_at(offset, chunk_len)?;
            for (dest, src) in chunk
                .iter_mut()
                .zip(&data[processed..processed + chunk_len])
            {
                *dest ^= *src;
            }
            self.write_at(offset, chunk.as_slice())?;
            processed += chunk_len;
        }
        Ok(())
    }

    fn sha1_digest(&mut self) -> VmResult<[u8; 20]> {
        self.file
            .seek(SeekFrom::Start(0))
            .map_err(|error| format!("failed to seek BSP file buffer: {error}"))?;
        let mut hasher = Sha1::new();
        let mut chunk = vec![0u8; FILE_IO_CHUNK_BYTES];
        loop {
            let read = self
                .file
                .read(chunk.as_mut_slice())
                .map_err(|error| format!("failed to read BSP file buffer: {error}"))?;
            if read == 0 {
                break;
            }
            hasher.update(&chunk[..read]);
        }
        let digest = hasher.finalize();
        let mut output = [0u8; 20];
        output.copy_from_slice(digest.as_slice());
        Ok(output)
    }
}

struct BspVm<'a, 'pool> {
    file_buffer: VmFileBuffer,
    current_file_pointer: u32,
    current_file_pointer_locked: bool,
    frames: Vec<Frame<'a>>,
    dirty: bool,
    sha1: [u8; 20],
    _thread_pool: std::marker::PhantomData<&'pool SharedThreadPool>,
}

impl<'a, 'pool> BspVm<'a, 'pool> {
    fn new(
        patch_bytes: &'a [u8],
        input_path: &Path,
        _thread_pool: Option<&'pool SharedThreadPool>,
    ) -> VmResult<Self> {
        Self::new_with_patch_space(PatchSpace::Borrowed(patch_bytes), input_path, None)
    }

    fn new_from_patch_path(
        patch_path: &Path,
        input_path: &Path,
        _thread_pool: Option<&'pool SharedThreadPool>,
    ) -> VmResult<Self> {
        let patch_len = usize::try_from(
            fs::metadata(patch_path)
                .map_err(|error| format!("failed to read BSP patch metadata: {error}"))?
                .len(),
        )
        .map_err(|_| "BSP patch length overflow".to_string())?;
        let reader = BlockCacheReader::open(
            patch_path,
            DEFAULT_BLOCK_CACHE_SIZE_BYTES,
            DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
        )
        .map_err(|error| format!("failed to open BSP patch block cache: {error}"))?;
        let patch_space = PatchSpace::Cached {
            len: patch_len,
            reader: Arc::new(Mutex::new(reader)),
        };
        Self::new_with_patch_space(patch_space, input_path, None)
    }

    fn new_with_patch_space(
        patch_space: PatchSpace<'a>,
        input_path: &Path,
        _thread_pool: Option<&'pool SharedThreadPool>,
    ) -> VmResult<Self> {
        Ok(Self {
            file_buffer: VmFileBuffer::open(input_path)?,
            current_file_pointer: 0,
            current_file_pointer_locked: false,
            frames: vec![Frame::new(patch_space)],
            dirty: true,
            sha1: [0; 20],
            _thread_pool: std::marker::PhantomData,
        })
    }

    fn execute(&mut self) -> VmResult<VmOutcome> {
        while !self.frames.is_empty() {
            let opcode = self.next_patch_byte()?;
            let args = self.opcode_parameters(opcode)?;
            let control = self.execute_opcode(opcode, &args)?;
            match control {
                StepControl::Continue => {}
                StepControl::Exit(exit_code) => {
                    self.frames.pop();
                    if let Some(parent) = self.frames.last_mut() {
                        if let Some(waiting_var) = parent.waiting_var.take() {
                            parent.variables[waiting_var as usize] = exit_code;
                            continue;
                        }
                        return Err("BSP runtime returned an invalid completion state".to_string());
                    }

                    if exit_code == 0 {
                        return Ok(VmOutcome::Success);
                    }
                    return Ok(VmOutcome::Failure(exit_code));
                }
            }
        }

        Err("BSP runtime returned an invalid completion state".to_string())
    }

    fn top_frame<'b>(&'b self) -> &'b Frame<'a> {
        match self.frames.last() {
            Some(frame) => frame,
            None => panic!("BSP runtime frame stack is empty"),
        }
    }

    fn top_frame_mut<'b>(&'b mut self) -> &'b mut Frame<'a> {
        match self.frames.last_mut() {
            Some(frame) => frame,
            None => panic!("BSP runtime frame stack is empty"),
        }
    }

    fn patch_len(&self) -> usize {
        self.top_frame().patch_space.len()
    }

    fn get_patch_byte(&self, pos: u32) -> VmResult<u8> {
        let pos = pos as usize;
        self.top_frame().patch_space.read_byte(pos)
    }

    fn get_patch_halfword(&self, pos: u32) -> VmResult<u16> {
        let pos = pos as usize;
        self.top_frame().patch_space.read_halfword(pos)
    }

    fn get_patch_word(&self, pos: u32) -> VmResult<u32> {
        let pos = pos as usize;
        self.top_frame().patch_space.read_word(pos)
    }

    fn next_patch_byte(&mut self) -> VmResult<u8> {
        let frame = self.top_frame_mut();
        let ip = frame.instruction_pointer as usize;
        let value = frame.patch_space.read_byte(ip)?;
        frame.instruction_pointer = frame.instruction_pointer.wrapping_add(1);
        Ok(value)
    }

    fn next_patch_halfword(&mut self) -> VmResult<u16> {
        let frame = self.top_frame_mut();
        let ip = frame.instruction_pointer as usize;
        let value = frame.patch_space.read_halfword(ip)?;
        frame.instruction_pointer = frame.instruction_pointer.wrapping_add(2);
        Ok(value)
    }

    fn next_patch_word(&mut self) -> VmResult<u32> {
        let frame = self.top_frame_mut();
        let ip = frame.instruction_pointer as usize;
        let value = frame.patch_space.read_word(ip)?;
        frame.instruction_pointer = frame.instruction_pointer.wrapping_add(4);
        Ok(value)
    }

    fn set_variable(&mut self, variable: u8, value: u32) {
        self.top_frame_mut().variables[variable as usize] = value;
    }

    fn get_variable(&self, variable: u8) -> u32 {
        self.top_frame().variables[variable as usize]
    }

    fn next_patch_variable(&mut self) -> VmResult<u32> {
        let variable = self.next_patch_byte()?;
        Ok(self.get_variable(variable))
    }

    fn push_to_stack(&mut self, value: u32) {
        self.top_frame_mut().stack.push_front(value);
    }

    fn pop_from_stack(&mut self) -> VmResult<u32> {
        self.top_frame_mut()
            .stack
            .pop_front()
            .ok_or_else(|| "popped empty stack".to_string())
    }

    fn calculate_real_stack_position(&self, position: u32) -> VmResult<usize> {
        let len = self.top_frame().stack.len() as i64;
        let mut pos = position as i64;
        if position >= 0x8000_0000 {
            pos = len + (position as i64 - 0x1_0000_0000i64);
        }
        if pos < 0 || pos >= len {
            return Err("invalid stack position".to_string());
        }
        Ok(pos as usize)
    }

    fn resize_stack(&mut self, size: u32) -> VmResult<()> {
        let target = usize::try_from(size).map_err(|_| "stack size overflow".to_string())?;
        let frame = self.top_frame_mut();
        if target < frame.stack.len() {
            while frame.stack.len() > target {
                frame.stack.pop_front();
            }
            return Ok(());
        }
        while frame.stack.len() < target {
            frame.stack.push_front(0);
        }
        Ok(())
    }

    fn ensure_file_size(&mut self, size: u32) -> VmResult<()> {
        self.file_buffer.ensure_size(size)
    }

    fn set_file_byte(&mut self, position: u32, value: u8) -> VmResult<()> {
        let new_size = position
            .checked_add(1)
            .ok_or_else(|| "file buffer size overflow".to_string())?;
        self.ensure_file_size(new_size)?;
        self.file_buffer.write_at(position as usize, &[value])
    }

    fn set_file_halfword(&mut self, position: u32, value: u16) -> VmResult<()> {
        let new_size = position
            .checked_add(2)
            .ok_or_else(|| "file buffer size overflow".to_string())?;
        self.ensure_file_size(new_size)?;
        self.file_buffer
            .write_at(position as usize, &value.to_le_bytes())
    }

    fn set_file_word(&mut self, position: u32, value: u32) -> VmResult<()> {
        let new_size = position
            .checked_add(4)
            .ok_or_else(|| "file buffer size overflow".to_string())?;
        self.ensure_file_size(new_size)?;
        self.file_buffer
            .write_at(position as usize, &value.to_le_bytes())
    }

    fn get_file_byte(&mut self, position: u32) -> VmResult<u8> {
        let position = position as usize;
        if position >= self.file_buffer.len() {
            return Err("attempted to read past the end of the file buffer".to_string());
        }
        let mut output = [0u8; 1];
        self.file_buffer.read_exact_at(position, &mut output)?;
        Ok(output[0])
    }

    fn get_file_halfword(&mut self, position: u32) -> VmResult<u16> {
        let position = position as usize;
        if position + 2 > self.file_buffer.len() {
            return Err("attempted to read past the end of the file buffer".to_string());
        }
        let mut output = [0u8; 2];
        self.file_buffer.read_exact_at(position, &mut output)?;
        Ok(u16::from_le_bytes(output))
    }

    fn get_file_word(&mut self, position: u32) -> VmResult<u32> {
        let position = position as usize;
        if position + 4 > self.file_buffer.len() {
            return Err("attempted to read past the end of the file buffer".to_string());
        }
        let mut output = [0u8; 4];
        self.file_buffer.read_exact_at(position, &mut output)?;
        Ok(u32::from_le_bytes(output))
    }

    fn update_current_file_pointer(&mut self, value: u32) {
        if self.current_file_pointer_locked {
            return;
        }
        self.current_file_pointer = value;
    }

    fn read_byte(&mut self, increment: bool) -> VmResult<u8> {
        let result = self.get_file_byte(self.current_file_pointer)?;
        if increment {
            self.update_current_file_pointer(self.current_file_pointer.wrapping_add(1));
        }
        Ok(result)
    }

    fn read_halfword(&mut self, increment: bool) -> VmResult<u16> {
        let result = self.get_file_halfword(self.current_file_pointer)?;
        if increment {
            self.update_current_file_pointer(self.current_file_pointer.wrapping_add(2));
        }
        Ok(result)
    }

    fn read_word(&mut self, increment: bool) -> VmResult<u32> {
        let result = self.get_file_word(self.current_file_pointer)?;
        if increment {
            self.update_current_file_pointer(self.current_file_pointer.wrapping_add(4));
        }
        Ok(result)
    }

    fn write_byte(&mut self, value: u32) -> VmResult<()> {
        if self.current_file_pointer > 0xFFFF_FFFE {
            return Err("current file pointer overflow".to_string());
        }
        self.set_file_byte(self.current_file_pointer, (value & 0xFF) as u8)?;
        self.dirty = true;
        self.update_current_file_pointer(self.current_file_pointer + 1);
        Ok(())
    }

    fn write_halfword(&mut self, value: u32) -> VmResult<()> {
        if self.current_file_pointer > 0xFFFF_FFFD {
            return Err("current file pointer overflow".to_string());
        }
        self.set_file_halfword(self.current_file_pointer, (value & 0xFFFF) as u16)?;
        self.dirty = true;
        self.update_current_file_pointer(self.current_file_pointer + 2);
        Ok(())
    }

    fn write_word(&mut self, value: u32) -> VmResult<()> {
        if self.current_file_pointer > 0xFFFF_FFFB {
            return Err("current file pointer overflow".to_string());
        }
        self.set_file_word(self.current_file_pointer, value)?;
        self.dirty = true;
        self.update_current_file_pointer(self.current_file_pointer + 4);
        Ok(())
    }

    fn truncate(&mut self, value: u32) -> VmResult<()> {
        self.file_buffer.truncate(value)?;
        self.dirty = true;
        Ok(())
    }

    fn utf8_decode(&self, mut address: u32) -> VmResult<String> {
        let mut bytes = Vec::new();
        loop {
            let next = self.get_patch_byte(address)?;
            address = address.wrapping_add(1);
            if next == 0 {
                break;
            }
            bytes.push(next);
        }
        let decoded =
            std::str::from_utf8(&bytes).map_err(|_| "invalid UTF-8 string".to_string())?;
        Ok(decoded.to_string())
    }

    fn update_hashes(&mut self) -> VmResult<()> {
        if !self.dirty {
            return Ok(());
        }
        self.sha1 = self.file_buffer.sha1_digest()?;
        self.dirty = false;
        Ok(())
    }

    fn write_data(&mut self, position: u32, address: u32, len: u32) -> VmResult<()> {
        if len == 0 {
            self.dirty = true;
            return Ok(());
        }

        let end_address = address
            .checked_add(len)
            .ok_or_else(|| "attempted to read past the end of the patch space".to_string())?;
        if end_address as usize > self.patch_len() {
            return Err("attempted to read past the end of the patch space".to_string());
        }

        let end_position = position
            .checked_add(len)
            .ok_or_else(|| "file buffer size overflow".to_string())?;
        self.ensure_file_size(end_position)?;

        let start = position as usize;
        let patch_start = address as usize;

        let source = self
            .top_frame()
            .patch_space
            .read_vec(patch_start, len as usize)?;
        self.file_buffer.write_range(start, source.as_slice())?;

        self.dirty = true;
        Ok(())
    }

    fn xor_data(&mut self, position: u32, address: u32, len: u32) -> VmResult<()> {
        if len == 0 {
            self.dirty = true;
            return Ok(());
        }

        let end_address = address
            .checked_add(len)
            .ok_or_else(|| "attempted to read past the end of the patch space".to_string())?;
        if end_address as usize > self.patch_len() {
            return Err("attempted to read past the end of the patch space".to_string());
        }

        let end_position = position
            .checked_add(len)
            .ok_or_else(|| "attempted to read past the end of the file buffer".to_string())?;
        if end_position as usize > self.file_buffer.len() {
            return Err("attempted to read past the end of the file buffer".to_string());
        }

        let start = position as usize;
        let patch_start = address as usize;

        let source = self
            .top_frame()
            .patch_space
            .read_vec(patch_start, len as usize)?;
        self.file_buffer.xor_range(start, source.as_slice())?;

        self.dirty = true;
        Ok(())
    }

    fn opcode_parameters(&mut self, opcode: u8) -> VmResult<Vec<u32>> {
        let args = match opcode {
            0x00 | 0x01 | 0x80 | 0x81 | 0x82 | 0x92 | 0x93 | 0xA6 | 0xA7 => vec![],
            0x02 | 0x04 | 0x06 | 0x08 | 0x1C | 0x1E | 0x60 | 0x62 | 0x64 | 0x66 | 0x68 | 0x8E
            | 0xA0 | 0xA2 | 0xA4 | 0xA8 => vec![self.next_patch_word()?],
            0x03 | 0x05 | 0x07 | 0x09 | 0x19 | 0x1B | 0x1D | 0x1F | 0x61 | 0x63 | 0x65 | 0x67
            | 0x69 | 0x83 | 0x8F | 0x90 | 0x91 | 0xA1 | 0xA3 | 0xA5 | 0xA9 => {
                vec![self.next_patch_variable()?]
            }
            0x10 | 0x12 | 0x14 | 0x16 | 0x6A | 0x84 | 0x86 | 0x8C => {
                vec![self.next_patch_byte()? as u32, self.next_patch_word()?]
            }
            0x11 | 0x13 | 0x15 | 0x17 | 0x6B | 0x85 | 0x87 | 0x8D | 0xAF => {
                vec![self.next_patch_byte()? as u32, self.next_patch_variable()?]
            }
            0x0A | 0x0B | 0x0C | 0x0D | 0x0E | 0x0F | 0x18 | 0x9B | 0x9F | 0xAA | 0xAC | 0xAD
            | 0xAE => vec![self.next_patch_byte()? as u32],
            0x1A => vec![self.next_patch_halfword()? as u32],
            0x20 | 0x24 | 0x28 | 0x2C | 0x30 | 0x34 | 0x38 | 0x3C | 0x94 => {
                vec![
                    self.next_patch_byte()? as u32,
                    self.next_patch_word()?,
                    self.next_patch_word()?,
                ]
            }
            0x21 | 0x25 | 0x29 | 0x2D | 0x31 | 0x35 | 0x39 | 0x3D | 0x95 => {
                vec![
                    self.next_patch_byte()? as u32,
                    self.next_patch_word()?,
                    self.next_patch_variable()?,
                ]
            }
            0x22 | 0x26 | 0x2A | 0x2E | 0x32 | 0x36 | 0x3A | 0x3E | 0x96 => {
                vec![
                    self.next_patch_byte()? as u32,
                    self.next_patch_variable()?,
                    self.next_patch_word()?,
                ]
            }
            0x23 | 0x27 | 0x2B | 0x2F | 0x33 | 0x37 | 0x3B | 0x3F | 0x97 => {
                vec![
                    self.next_patch_byte()? as u32,
                    self.next_patch_variable()?,
                    self.next_patch_variable()?,
                ]
            }
            0x40 | 0x44 | 0x48 | 0x4C | 0x50 | 0x54 => {
                vec![
                    self.next_patch_variable()?,
                    self.next_patch_word()?,
                    self.next_patch_word()?,
                ]
            }
            0x41 | 0x45 | 0x49 | 0x4D | 0x51 | 0x55 => {
                vec![
                    self.next_patch_variable()?,
                    self.next_patch_word()?,
                    self.next_patch_variable()?,
                ]
            }
            0x42 | 0x46 | 0x4A | 0x4E | 0x52 | 0x56 => {
                vec![
                    self.next_patch_variable()?,
                    self.next_patch_variable()?,
                    self.next_patch_word()?,
                ]
            }
            0x43 | 0x47 | 0x4B | 0x4F | 0x53 | 0x57 => {
                vec![
                    self.next_patch_variable()?,
                    self.next_patch_variable()?,
                    self.next_patch_variable()?,
                ]
            }
            0x58 | 0x5A | 0x5C | 0x5E | 0x6E | 0x7A | 0x7E | 0x8A => {
                vec![self.next_patch_variable()?, self.next_patch_word()?]
            }
            0x59 | 0x5B | 0x5D | 0x5F | 0x6F | 0x73 | 0x77 | 0x7B | 0x7F | 0x8B => {
                vec![self.next_patch_variable()?, self.next_patch_variable()?]
            }
            0x6C | 0x78 | 0x7C | 0x88 => {
                vec![self.next_patch_word()?, self.next_patch_word()?]
            }
            0x6D | 0x71 | 0x75 | 0x79 | 0x7D | 0x89 => {
                vec![self.next_patch_word()?, self.next_patch_variable()?]
            }
            0x70 => vec![self.next_patch_word()?, self.next_patch_byte()? as u32],
            0x72 => vec![self.next_patch_variable()?, self.next_patch_byte()? as u32],
            0x74 => vec![self.next_patch_word()?, self.next_patch_halfword()? as u32],
            0x76 => vec![
                self.next_patch_variable()?,
                self.next_patch_halfword()? as u32,
            ],
            0x98 | 0x99 | 0x9A | 0x9C | 0x9D | 0x9E | 0xAB => {
                vec![
                    self.next_patch_byte()? as u32,
                    self.next_patch_byte()? as u32,
                ]
            }
            0xB0 | 0xB4 | 0xB8 | 0xBC => {
                vec![
                    self.next_patch_byte()? as u32,
                    self.next_patch_byte()? as u32,
                    self.next_patch_word()?,
                    self.next_patch_word()?,
                ]
            }
            0xB1 | 0xB5 | 0xB9 | 0xBD => {
                vec![
                    self.next_patch_byte()? as u32,
                    self.next_patch_byte()? as u32,
                    self.next_patch_word()?,
                    self.next_patch_variable()?,
                ]
            }
            0xB2 | 0xB6 | 0xBA | 0xBE => {
                vec![
                    self.next_patch_byte()? as u32,
                    self.next_patch_byte()? as u32,
                    self.next_patch_variable()?,
                    self.next_patch_word()?,
                ]
            }
            0xB3 | 0xB7 | 0xBB | 0xBF => {
                vec![
                    self.next_patch_byte()? as u32,
                    self.next_patch_byte()? as u32,
                    self.next_patch_variable()?,
                    self.next_patch_variable()?,
                ]
            }
            _ => return Err("undefined opcode".to_string()),
        };
        Ok(args)
    }

    fn execute_opcode(&mut self, opcode: u8, args: &[u32]) -> VmResult<StepControl> {
        match opcode {
            0x00 => Ok(StepControl::Continue),
            0x01 => self.return_opcode(),
            0x02 | 0x03 => self.jump_opcode(args[0]),
            0x04 | 0x05 => self.call_opcode(args[0]),
            0x06 | 0x07 => Ok(StepControl::Exit(args[0])),
            0x08 | 0x09 => {
                self.push_to_stack(args[0]);
                Ok(StepControl::Continue)
            }
            0x0A => {
                let value = self.pop_from_stack()?;
                self.set_variable(args[0] as u8, value);
                Ok(StepControl::Continue)
            }
            0x0B => {
                self.set_variable(args[0] as u8, self.file_buffer.len() as u32);
                Ok(StepControl::Continue)
            }
            0x0C => {
                let value = self.read_byte(true)? as u32;
                self.set_variable(args[0] as u8, value);
                Ok(StepControl::Continue)
            }
            0x0D => {
                let value = self.read_halfword(true)? as u32;
                self.set_variable(args[0] as u8, value);
                Ok(StepControl::Continue)
            }
            0x0E => {
                let value = self.read_word(true)?;
                self.set_variable(args[0] as u8, value);
                Ok(StepControl::Continue)
            }
            0x0F => {
                self.set_variable(args[0] as u8, self.current_file_pointer);
                Ok(StepControl::Continue)
            }
            0x10 | 0x11 => {
                self.set_variable(args[0] as u8, self.get_patch_byte(args[1])? as u32);
                Ok(StepControl::Continue)
            }
            0x12 | 0x13 => {
                self.set_variable(args[0] as u8, self.get_patch_halfword(args[1])? as u32);
                Ok(StepControl::Continue)
            }
            0x14 | 0x15 => {
                self.set_variable(args[0] as u8, self.get_patch_word(args[1])?);
                Ok(StepControl::Continue)
            }
            0x16 | 0x17 => {
                self.update_hashes()?;
                let mut result = 0u32;
                for index in 0..20u32 {
                    if self.get_patch_byte(args[1].wrapping_add(index))?
                        != self.sha1[index as usize]
                    {
                        result |= 1 << index;
                    }
                }
                self.set_variable(args[0] as u8, result);
                Ok(StepControl::Continue)
            }
            0x18 | 0x19 => {
                self.write_byte(args[0])?;
                Ok(StepControl::Continue)
            }
            0x1A | 0x1B => {
                self.write_halfword(args[0])?;
                Ok(StepControl::Continue)
            }
            0x1C | 0x1D => {
                self.write_word(args[0])?;
                Ok(StepControl::Continue)
            }
            0x1E | 0x1F => {
                self.truncate(args[0])?;
                Ok(StepControl::Continue)
            }
            0x20 | 0x21 | 0x22 | 0x23 => {
                self.set_variable(args[0] as u8, args[1].wrapping_add(args[2]));
                Ok(StepControl::Continue)
            }
            0x24 | 0x25 | 0x26 | 0x27 => {
                self.set_variable(args[0] as u8, args[1].wrapping_sub(args[2]));
                Ok(StepControl::Continue)
            }
            0x28 | 0x29 | 0x2A | 0x2B => {
                self.set_variable(args[0] as u8, args[1].wrapping_mul(args[2]));
                Ok(StepControl::Continue)
            }
            0x2C | 0x2D | 0x2E | 0x2F => {
                if args[2] == 0 {
                    return Err("division by zero".to_string());
                }
                self.set_variable(args[0] as u8, args[1] / args[2]);
                Ok(StepControl::Continue)
            }
            0x30 | 0x31 | 0x32 | 0x33 => {
                if args[2] == 0 {
                    return Err("division by zero".to_string());
                }
                self.set_variable(args[0] as u8, args[1] % args[2]);
                Ok(StepControl::Continue)
            }
            0x34 | 0x35 | 0x36 | 0x37 => {
                self.set_variable(args[0] as u8, args[1] & args[2]);
                Ok(StepControl::Continue)
            }
            0x38 | 0x39 | 0x3A | 0x3B => {
                self.set_variable(args[0] as u8, args[1] | args[2]);
                Ok(StepControl::Continue)
            }
            0x3C | 0x3D | 0x3E | 0x3F => {
                self.set_variable(args[0] as u8, args[1] ^ args[2]);
                Ok(StepControl::Continue)
            }
            0x40 | 0x41 | 0x42 | 0x43 => {
                if args[0] < args[1] {
                    self.jump_opcode(args[2])
                } else {
                    Ok(StepControl::Continue)
                }
            }
            0x44 | 0x45 | 0x46 | 0x47 => {
                if args[0] <= args[1] {
                    self.jump_opcode(args[2])
                } else {
                    Ok(StepControl::Continue)
                }
            }
            0x48 | 0x49 | 0x4A | 0x4B => {
                if args[0] > args[1] {
                    self.jump_opcode(args[2])
                } else {
                    Ok(StepControl::Continue)
                }
            }
            0x4C | 0x4D | 0x4E | 0x4F => {
                if args[0] >= args[1] {
                    self.jump_opcode(args[2])
                } else {
                    Ok(StepControl::Continue)
                }
            }
            0x50 | 0x51 | 0x52 | 0x53 => {
                if args[0] == args[1] {
                    self.jump_opcode(args[2])
                } else {
                    Ok(StepControl::Continue)
                }
            }
            0x54 | 0x55 | 0x56 | 0x57 => {
                if args[0] != args[1] {
                    self.jump_opcode(args[2])
                } else {
                    Ok(StepControl::Continue)
                }
            }
            0x58 | 0x59 => {
                if args[0] == 0 {
                    self.jump_opcode(args[1])
                } else {
                    Ok(StepControl::Continue)
                }
            }
            0x5A | 0x5B => {
                if args[0] != 0 {
                    self.jump_opcode(args[1])
                } else {
                    Ok(StepControl::Continue)
                }
            }
            0x5C | 0x5D => {
                if args[0] == 0 {
                    self.call_opcode(args[1])
                } else {
                    Ok(StepControl::Continue)
                }
            }
            0x5E | 0x5F => {
                if args[0] != 0 {
                    self.call_opcode(args[1])
                } else {
                    Ok(StepControl::Continue)
                }
            }
            0x60 | 0x61 => {
                self.update_current_file_pointer(args[0]);
                Ok(StepControl::Continue)
            }
            0x62 | 0x63 => {
                if self.current_file_pointer_locked {
                    return Ok(StepControl::Continue);
                }
                let next = self
                    .current_file_pointer
                    .checked_add(args[0])
                    .ok_or_else(|| "current file pointer overflow".to_string())?;
                self.current_file_pointer = next;
                Ok(StepControl::Continue)
            }
            0x64 | 0x65 => {
                if self.current_file_pointer_locked {
                    return Ok(StepControl::Continue);
                }
                if args[0] > self.current_file_pointer {
                    return Err("current file pointer overflow".to_string());
                }
                self.current_file_pointer -= args[0];
                Ok(StepControl::Continue)
            }
            0x66 | 0x67 => {
                if self.current_file_pointer_locked {
                    return Ok(StepControl::Continue);
                }
                let len = self.file_buffer.len() as u32;
                if args[0] > len {
                    return Err("current file pointer overflow".to_string());
                }
                self.current_file_pointer = len - args[0];
                Ok(StepControl::Continue)
            }
            0x68 | 0x69 => {
                let _ = self.utf8_decode(args[0])?;
                Ok(StepControl::Continue)
            }
            0x6A | 0x6B => {
                let variable = args[0] as u8;
                let mut address = args[1];
                let mut option_addresses = Vec::new();
                loop {
                    let option = self.get_patch_word(address)?;
                    if option == 0xFFFF_FFFF {
                        break;
                    }
                    option_addresses.push(option);
                    address = address.checked_add(4).ok_or_else(|| {
                        "attempted to read past the end of the patch space".to_string()
                    })?;
                }

                if option_addresses.is_empty() {
                    self.set_variable(variable, 0xFFFF_FFFF);
                    return Ok(StepControl::Continue);
                }

                // Native BSP is non-interactive today, so menu instructions pick the first entry.
                // We still decode all strings to preserve UTF-8 validation semantics.
                for option_address in option_addresses {
                    let _ = self.utf8_decode(option_address)?;
                }

                self.set_variable(variable, 0);
                Ok(StepControl::Continue)
            }
            0x6C | 0x6D | 0x6E | 0x6F => {
                let start = args[0];
                let len = args[1];
                let end = (self.current_file_pointer as u64) + (len as u64);
                if end > u32::MAX as u64 {
                    return Err("file position overflow".to_string());
                }
                let size = self.file_buffer.len() as u32;
                if self.current_file_pointer >= size {
                    self.write_data(self.current_file_pointer, start, len)?;
                } else {
                    let bytes_to_end = size - self.current_file_pointer;
                    if bytes_to_end >= len {
                        self.xor_data(self.current_file_pointer, start, len)?;
                    } else {
                        self.xor_data(self.current_file_pointer, start, bytes_to_end)?;
                        self.write_data(
                            self.current_file_pointer + bytes_to_end,
                            start + bytes_to_end,
                            len - bytes_to_end,
                        )?;
                    }
                }
                if !self.current_file_pointer_locked {
                    self.current_file_pointer = self.current_file_pointer.wrapping_add(len);
                }
                Ok(StepControl::Continue)
            }
            0x70 | 0x71 | 0x72 | 0x73 => {
                let mut count = args[0];
                let value = (args[1] & 0xFF) as u8;
                if count == 0 {
                    return Ok(StepControl::Continue);
                }
                let mut address = self.current_file_pointer;
                if (address as u64) + (count as u64) > u32::MAX as u64 {
                    return Err("file position overflow".to_string());
                }
                while count > 0 {
                    self.set_file_byte(address, value)?;
                    address = address.wrapping_add(1);
                    count -= 1;
                }
                if !self.current_file_pointer_locked {
                    self.current_file_pointer = address;
                }
                self.dirty = true;
                Ok(StepControl::Continue)
            }
            0x74 | 0x75 | 0x76 | 0x77 => {
                let mut count = args[0];
                let value = (args[1] & 0xFFFF) as u16;
                if count == 0 {
                    return Ok(StepControl::Continue);
                }
                let mut address = self.current_file_pointer;
                if (address as u64) + (2u64 * count as u64) > u32::MAX as u64 {
                    return Err("file position overflow".to_string());
                }
                while count > 0 {
                    self.set_file_halfword(address, value)?;
                    address = address.wrapping_add(2);
                    count -= 1;
                }
                if !self.current_file_pointer_locked {
                    self.current_file_pointer = address;
                }
                self.dirty = true;
                Ok(StepControl::Continue)
            }
            0x78 | 0x79 | 0x7A | 0x7B => {
                let mut count = args[0];
                let value = args[1];
                if count == 0 {
                    return Ok(StepControl::Continue);
                }
                let mut address = self.current_file_pointer;
                if (address as u64) + (4u64 * count as u64) > u32::MAX as u64 {
                    return Err("file position overflow".to_string());
                }
                while count > 0 {
                    self.set_file_word(address, value)?;
                    address = address.wrapping_add(4);
                    count -= 1;
                }
                if !self.current_file_pointer_locked {
                    self.current_file_pointer = address;
                }
                self.dirty = true;
                Ok(StepControl::Continue)
            }
            0x7C | 0x7D | 0x7E | 0x7F => {
                let start = args[0];
                let len = args[1];
                if (self.current_file_pointer as u64) + (len as u64) > u32::MAX as u64 {
                    return Err("file position overflow".to_string());
                }
                self.write_data(self.current_file_pointer, start, len)?;
                if !self.current_file_pointer_locked {
                    self.current_file_pointer = self.current_file_pointer.wrapping_add(len);
                }
                Ok(StepControl::Continue)
            }
            0x80 => {
                self.current_file_pointer_locked = true;
                Ok(StepControl::Continue)
            }
            0x81 => {
                self.current_file_pointer_locked = false;
                Ok(StepControl::Continue)
            }
            0x82 => {
                self.truncate(self.current_file_pointer)?;
                Ok(StepControl::Continue)
            }
            0x83 => {
                let value = args[0];
                let address = value
                    .checked_mul(4)
                    .and_then(|v| v.checked_add(self.top_frame().instruction_pointer))
                    .ok_or_else(|| {
                        "attempted to read past the end of the patch space".to_string()
                    })?;
                if (address as usize) + 4 > self.patch_len() {
                    return Err("attempted to read past the end of the patch space".to_string());
                }
                let target = self.get_patch_word(address)?;
                self.top_frame_mut().instruction_pointer = target;
                Ok(StepControl::Continue)
            }
            0x84 | 0x85 => {
                self.set_variable(args[0] as u8, args[1]);
                Ok(StepControl::Continue)
            }
            0x86 | 0x87 => {
                self.ipspatch_opcode(args[0] as u8, args[1])?;
                Ok(StepControl::Continue)
            }
            0x88 | 0x89 | 0x8A | 0x8B => {
                let position = self.calculate_real_stack_position(args[0])?;
                self.top_frame_mut().stack[position] = args[1];
                Ok(StepControl::Continue)
            }
            0x8C | 0x8D => {
                let position = self.calculate_real_stack_position(args[1])?;
                let value = self.top_frame().stack[position];
                self.set_variable(args[0] as u8, value);
                Ok(StepControl::Continue)
            }
            0x8E | 0x8F => {
                let amount = if args[0] >= 0x8000_0000 {
                    (args[0] as i64) - 0x1_0000_0000i64
                } else {
                    args[0] as i64
                };
                let len = self.top_frame().stack.len() as i64;
                if amount + len < 0 {
                    return Err("stack underflow".to_string());
                }
                self.resize_stack((amount + len) as u32)?;
                Ok(StepControl::Continue)
            }
            0x90 => {
                if args[0] == 0 {
                    self.return_opcode()
                } else {
                    Ok(StepControl::Continue)
                }
            }
            0x91 => {
                if args[0] != 0 {
                    self.return_opcode()
                } else {
                    Ok(StepControl::Continue)
                }
            }
            0x92 => {
                self.push_to_stack(self.current_file_pointer);
                Ok(StepControl::Continue)
            }
            0x93 => {
                let value = self.pop_from_stack()?;
                self.update_current_file_pointer(value);
                Ok(StepControl::Continue)
            }
            0x94 | 0x95 | 0x96 | 0x97 => self.bsppatch_opcode(args[0] as u8, args[1], args[2]),
            0x98 => {
                let address_var = args[1] as u8;
                let address = self.get_variable(address_var);
                self.set_variable(address_var, address.wrapping_add(1));
                self.set_variable(args[0] as u8, self.get_patch_byte(address)? as u32);
                Ok(StepControl::Continue)
            }
            0x99 => {
                let address_var = args[1] as u8;
                let address = self.get_variable(address_var);
                self.set_variable(address_var, address.wrapping_add(2));
                self.set_variable(args[0] as u8, self.get_patch_halfword(address)? as u32);
                Ok(StepControl::Continue)
            }
            0x9A => {
                let address_var = args[1] as u8;
                let address = self.get_variable(address_var);
                self.set_variable(address_var, address.wrapping_add(4));
                self.set_variable(args[0] as u8, self.get_patch_word(address)?);
                Ok(StepControl::Continue)
            }
            0x9B => {
                let variable = args[0] as u8;
                self.set_variable(variable, self.get_variable(variable).wrapping_add(1));
                Ok(StepControl::Continue)
            }
            0x9C => {
                let address_var = args[1] as u8;
                let address = self.get_variable(address_var);
                self.set_variable(address_var, address.wrapping_sub(1));
                self.set_variable(args[0] as u8, self.get_patch_byte(address)? as u32);
                Ok(StepControl::Continue)
            }
            0x9D => {
                let address_var = args[1] as u8;
                let address = self.get_variable(address_var);
                self.set_variable(address_var, address.wrapping_sub(2));
                self.set_variable(args[0] as u8, self.get_patch_halfword(address)? as u32);
                Ok(StepControl::Continue)
            }
            0x9E => {
                let address_var = args[1] as u8;
                let address = self.get_variable(address_var);
                self.set_variable(address_var, address.wrapping_sub(4));
                self.set_variable(args[0] as u8, self.get_patch_word(address)?);
                Ok(StepControl::Continue)
            }
            0x9F => {
                let variable = args[0] as u8;
                self.set_variable(variable, self.get_variable(variable).wrapping_sub(1));
                Ok(StepControl::Continue)
            }
            0xA0 | 0xA1 => {
                let text = self.utf8_decode(args[0])?;
                self.top_frame_mut().message_buffer.push_str(&text);
                Ok(StepControl::Continue)
            }
            0xA2 | 0xA3 => {
                let character = args[0];
                if character > 0x10FFFF || (character & 0xFFFF_F800) == 0xD800 {
                    return Err("invalid Unicode character".to_string());
                }
                if character > 0 {
                    let c = char::from_u32(character)
                        .ok_or_else(|| "invalid Unicode character".to_string())?;
                    self.top_frame_mut().message_buffer.push(c);
                }
                Ok(StepControl::Continue)
            }
            0xA4 | 0xA5 => {
                self.top_frame_mut()
                    .message_buffer
                    .push_str(&args[0].to_string());
                Ok(StepControl::Continue)
            }
            0xA6 => {
                self.top_frame_mut().message_buffer.clear();
                Ok(StepControl::Continue)
            }
            0xA7 => {
                self.top_frame_mut().message_buffer.clear();
                Ok(StepControl::Continue)
            }
            0xA8 | 0xA9 => {
                self.resize_stack(args[0])?;
                Ok(StepControl::Continue)
            }
            0xAA => {
                self.set_variable(args[0] as u8, self.top_frame().stack.len() as u32);
                Ok(StepControl::Continue)
            }
            0xAB => {
                self.bit_shift_opcode(args[0] as u8, args[1] as u8)?;
                Ok(StepControl::Continue)
            }
            0xAC => {
                let value = self.read_byte(false)? as u32;
                self.set_variable(args[0] as u8, value);
                Ok(StepControl::Continue)
            }
            0xAD => {
                let value = self.read_halfword(false)? as u32;
                self.set_variable(args[0] as u8, value);
                Ok(StepControl::Continue)
            }
            0xAE => {
                let value = self.read_word(false)?;
                self.set_variable(args[0] as u8, value);
                Ok(StepControl::Continue)
            }
            0xAF => {
                self.set_variable(args[0] as u8, self.get_variable(args[1] as u8));
                Ok(StepControl::Continue)
            }
            0xB0 | 0xB1 | 0xB2 | 0xB3 => {
                let variable = args[0] as u8;
                let carry = args[1] as u8;
                let first = args[2];
                let second = args[3];
                let result = first.wrapping_add(second);
                if result < first {
                    self.set_variable(carry, self.get_variable(carry).wrapping_add(1));
                }
                if variable != carry {
                    self.set_variable(variable, result);
                }
                Ok(StepControl::Continue)
            }
            0xB4 | 0xB5 | 0xB6 | 0xB7 => {
                let variable = args[0] as u8;
                let borrow = args[1] as u8;
                let first = args[2];
                let second = args[3];
                if first < second {
                    self.set_variable(borrow, self.get_variable(borrow).wrapping_sub(1));
                }
                if variable != borrow {
                    self.set_variable(variable, first.wrapping_sub(second));
                }
                Ok(StepControl::Continue)
            }
            0xB8 | 0xB9 | 0xBA | 0xBB => {
                let low_var = args[0] as u8;
                let high_var = args[1] as u8;
                let wide = (args[2] as u64) * (args[3] as u64);
                let low = wide as u32;
                let high = (wide >> 32) as u32;
                self.set_variable(high_var, high);
                if low_var != high_var {
                    self.set_variable(low_var, low);
                }
                Ok(StepControl::Continue)
            }
            0xBC | 0xBD | 0xBE | 0xBF => {
                let low_var = args[0] as u8;
                let high_var = args[1] as u8;
                let first = args[2] as u64;
                let second = args[3] as u64;
                if low_var == high_var {
                    self.set_variable(
                        low_var,
                        args[2]
                            .wrapping_mul(args[3])
                            .wrapping_add(self.get_variable(low_var)),
                    );
                    return Ok(StepControl::Continue);
                }
                let wide = first * second;
                let mut low = wide as u32;
                let mut high = (wide >> 32) as u32;

                let existing_low = self.get_variable(low_var);
                let (next_low, carry) = low.overflowing_add(existing_low);
                low = next_low;
                if carry {
                    high = high.wrapping_add(1);
                }
                high = high.wrapping_add(self.get_variable(high_var));

                self.set_variable(low_var, low);
                self.set_variable(high_var, high);
                Ok(StepControl::Continue)
            }
            _ => Err("undefined opcode".to_string()),
        }
    }

    fn return_opcode(&mut self) -> VmResult<StepControl> {
        if self.top_frame().stack.is_empty() {
            return Ok(StepControl::Exit(0));
        }
        let ip = self.pop_from_stack()?;
        self.top_frame_mut().instruction_pointer = ip;
        Ok(StepControl::Continue)
    }

    fn jump_opcode(&mut self, target: u32) -> VmResult<StepControl> {
        self.top_frame_mut().instruction_pointer = target;
        Ok(StepControl::Continue)
    }

    fn call_opcode(&mut self, target: u32) -> VmResult<StepControl> {
        let current_ip = self.top_frame().instruction_pointer;
        self.push_to_stack(current_ip);
        self.jump_opcode(target)
    }

    fn ips_next_byte(&self, current_address: &mut u32) -> VmResult<u8> {
        let byte = self.get_patch_byte(*current_address)?;
        *current_address = current_address.wrapping_add(1);
        Ok(byte)
    }

    fn ips_next_value(&self, current_address: &mut u32, bytes: u8) -> VmResult<u32> {
        let mut result = 0u32;
        let mut remaining = bytes;
        while remaining > 0 {
            result = (result << 8) | (self.ips_next_byte(current_address)? as u32);
            remaining -= 1;
        }
        Ok(result)
    }

    fn ipspatch_opcode(&mut self, variable: u8, address: u32) -> VmResult<()> {
        let mut current_address = address;

        for expected in [0x50, 0x41, 0x54, 0x43, 0x48] {
            if self.ips_next_byte(&mut current_address)? != expected {
                return Err("invalid IPS header".to_string());
            }
        }

        loop {
            let mut position = self.ips_next_value(&mut current_address, 3)?;
            if position == 0x45_4F_46 {
                break;
            }
            position = position.wrapping_add(self.current_file_pointer);
            if position >= 0xFFFF_FFFF {
                return Err("file position overflow".to_string());
            }

            let mut count = self.ips_next_value(&mut current_address, 2)?;
            if count == 0 {
                count = self.ips_next_value(&mut current_address, 2)?;
                let value = self.ips_next_byte(&mut current_address)?;
                while count > 0 {
                    self.set_file_byte(position, value)?;
                    position = position.wrapping_add(1);
                    count -= 1;
                }
            } else {
                while count > 0 {
                    let value = self.ips_next_byte(&mut current_address)?;
                    self.set_file_byte(position, value)?;
                    position = position.wrapping_add(1);
                    count -= 1;
                }
            }
        }

        self.set_variable(variable, current_address);
        self.dirty = true;
        Ok(())
    }

    fn bsppatch_opcode(&mut self, variable: u8, start: u32, len: u32) -> VmResult<StepControl> {
        let start = start as usize;
        let len = len as usize;
        if start + len > self.patch_len() {
            return Err("attempted to read past the end of the patch space".to_string());
        }
        if len == 0 {
            return Err("invalid zero length".to_string());
        }

        let slice = self.top_frame().patch_space.read_vec(start, len)?;

        self.top_frame_mut().waiting_var = Some(variable);
        self.frames.push(Frame::new(PatchSpace::Owned(slice)));
        Ok(StepControl::Continue)
    }

    fn bit_shift_opcode(&mut self, bitflags: u8, variable: u8) -> VmResult<()> {
        let mut shift_count = (bitflags & 31) as u32;
        let shift_type = (bitflags >> 5) & 3;
        let mut value = if (bitflags & 0x80) != 0 {
            self.next_patch_variable()?
        } else {
            self.next_patch_word()?
        };

        if shift_count == 0 {
            shift_count = self.next_patch_variable()? & 31;
        }

        value = match shift_type {
            0 => value.wrapping_shl(shift_count),
            1 => value.wrapping_shr(shift_count),
            2 => value.rotate_left(shift_count),
            3 => ((value as i32) >> shift_count) as u32,
            _ => value,
        };

        self.set_variable(variable, value);
        Ok(())
    }

    fn output_len(&self) -> usize {
        self.file_buffer.len()
    }
}

pub(crate) fn apply_bsp_patch_file_native(
    patch_bytes: &[u8],
    file_path: &Path,
    pool: Option<&SharedThreadPool>,
) -> Result<u64, RomWeaverError> {
    let mut vm = BspVm::new(patch_bytes, file_path, pool).map_err(|message| {
        RomWeaverError::Validation(format!("BSP patch execution failed: {message}"))
    })?;
    match vm.execute() {
        Ok(VmOutcome::Success) => Ok(vm.output_len() as u64),
        Ok(VmOutcome::Failure(code)) => Err(RomWeaverError::Validation(format!(
            "BSP patch script exited with failure status {}",
            code as i64
        ))),
        Err(message) => Err(RomWeaverError::Validation(format!(
            "BSP patch execution failed: {message}"
        ))),
    }
}

pub(crate) fn apply_bsp_patch_file_native_from_path(
    patch_path: &Path,
    file_path: &Path,
    pool: Option<&SharedThreadPool>,
) -> Result<u64, RomWeaverError> {
    let mut vm = BspVm::new_from_patch_path(patch_path, file_path, pool).map_err(|message| {
        RomWeaverError::Validation(format!("BSP patch execution failed: {message}"))
    })?;
    match vm.execute() {
        Ok(VmOutcome::Success) => Ok(vm.output_len() as u64),
        Ok(VmOutcome::Failure(code)) => Err(RomWeaverError::Validation(format!(
            "BSP patch script exited with failure status {}",
            code as i64
        ))),
        Err(message) => Err(RomWeaverError::Validation(format!(
            "BSP patch execution failed: {message}"
        ))),
    }
}
