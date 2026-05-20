use std::{
    env,
    fs::{self, File},
    io::{self, BufReader, BufWriter, Read, Write},
    num::NonZeroU64,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use lzma_rust2::{XzOptions, XzReader, XzReaderMt, XzWriter, XzWriterMt};
use rayon::prelude::*;
use tar::{Archive as TarArchive, Builder as TarBuilder};
use zip::{
    CompressionMethod as ZipCompressionMethod, ZipArchive as ZipFileArchive,
    ZipWriter as ZipFileWriter, write::SimpleFileOptions as ZipFileOptions,
};

const BENCH_THREADS_SINGLE: usize = 1;
const BENCH_THREADS_PARALLEL: usize = 8;
const BENCH_ITERS: usize = 2;
const BENCH_FILE_COUNT: usize = 8;
const BENCH_FILE_SIZE: usize = 2 * 1024 * 1024;
const XZ_MT_BLOCK_BYTES: u64 = 1 << 20;

type BenchResult<T> = anyhow::Result<T>;

#[derive(Clone)]
struct ZipExtractTask {
    index: usize,
    output_path: PathBuf,
}

fn temp_dir_path(label: &str) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    env::temp_dir().join(format!(
        "rom-weaver-thread-bench-{label}-{}-{timestamp}",
        std::process::id(),
    ))
}

fn write_fixture_inputs(input_dir: &Path) -> io::Result<()> {
    fs::create_dir_all(input_dir)?;
    for file_index in 0..BENCH_FILE_COUNT {
        let path = input_dir.join(format!("asset-{file_index:02}.bin"));
        let mut content = vec![0_u8; BENCH_FILE_SIZE];
        for (offset, byte) in content.iter_mut().enumerate() {
            let value = ((offset as u64)
                .wrapping_mul(131)
                .wrapping_add((file_index as u64).wrapping_mul(17))
                % 251) as u8;
            *byte = value;
        }
        fs::write(path, content)?;
    }
    Ok(())
}

fn collect_input_files(input_dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = fs::read_dir(input_dir)?
        .map(|entry| entry.map(|value| value.path()))
        .collect::<io::Result<Vec<_>>>()?;
    files.sort();
    Ok(files)
}

fn file_name_utf8(path: &Path) -> io::Result<&str> {
    path.file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid file name"))
}

fn zip_entry_output_path(base_dir: &Path, raw_name: &str) -> Option<PathBuf> {
    let name = raw_name.replace('\\', "/");
    if name.ends_with('/') {
        return None;
    }
    Some(base_dir.join(Path::new(name.trim_start_matches("./"))))
}

fn append_tar_inputs<W: Write>(builder: &mut TarBuilder<W>, input_dir: &Path) -> BenchResult<()> {
    for input in collect_input_files(input_dir)? {
        let file_name = file_name_utf8(&input)?;
        builder.append_path_with_name(&input, file_name)?;
    }
    Ok(())
}

fn create_zip_archive(input_dir: &Path, output_path: &Path) -> BenchResult<()> {
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = File::create(output_path)?;
    let writer = BufWriter::new(file);
    let mut archive = ZipFileWriter::new(writer);
    let options = ZipFileOptions::default().compression_method(ZipCompressionMethod::Deflated);
    for input in collect_input_files(input_dir)? {
        let file_name = file_name_utf8(&input)?;
        archive.start_file(file_name, options)?;
        let mut source = BufReader::new(File::open(&input)?);
        io::copy(&mut source, &mut archive)?;
    }
    archive.finish()?;
    Ok(())
}

fn zip_extract_single(source: &Path, out_dir: &Path) -> BenchResult<()> {
    fs::create_dir_all(out_dir)?;
    let file = File::open(source)?;
    let mut archive = ZipFileArchive::new(BufReader::new(file))?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let Some(output_path) = zip_entry_output_path(out_dir, entry.name()) else {
            continue;
        };
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = BufWriter::new(File::create(output_path)?);
        io::copy(&mut entry, &mut output)?;
    }
    Ok(())
}

fn zip_extract_parallel(source: &Path, out_dir: &Path, threads: usize) -> BenchResult<()> {
    fs::create_dir_all(out_dir)?;

    let file = File::open(source)?;
    let mut archive = ZipFileArchive::new(BufReader::new(file))?;
    let mut tasks = Vec::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        let Some(output_path) = zip_entry_output_path(out_dir, entry.name()) else {
            continue;
        };
        tasks.push(ZipExtractTask { index, output_path });
    }

    let worker_count = threads.max(1);
    let chunk_size = tasks.len().div_ceil(worker_count).max(1);
    let written_bytes = AtomicU64::new(0);
    tasks
        .par_chunks(chunk_size)
        .try_for_each(|chunk| -> BenchResult<()> {
            let file = File::open(source)?;
            let mut local_archive = ZipFileArchive::new(BufReader::new(file))?;
            for task in chunk {
                let mut entry = local_archive.by_index(task.index)?;
                if let Some(parent) = task.output_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                let mut output = BufWriter::new(File::create(&task.output_path)?);
                let copied = io::copy(&mut entry, &mut output)?;
                written_bytes.fetch_add(copied, Ordering::Relaxed);
            }
            Ok(())
        })?;
    Ok(())
}

fn create_tar_xz(input_dir: &Path, output_path: &Path, threads: usize) -> BenchResult<()> {
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let output = BufWriter::new(File::create(output_path)?);
    if threads > 1 {
        let mut options = XzOptions::with_preset(6);
        options.set_block_size(NonZeroU64::new(XZ_MT_BLOCK_BYTES));
        let encoder = XzWriterMt::new(output, options, threads.min(256) as u32)?;
        let mut builder = TarBuilder::new(encoder);
        append_tar_inputs(&mut builder, input_dir)?;
        let mut output = builder.into_inner()?.finish()?;
        output.flush()?;
    } else {
        let encoder = XzWriter::new(output, XzOptions::with_preset(6))?;
        let mut builder = TarBuilder::new(encoder);
        append_tar_inputs(&mut builder, input_dir)?;
        let mut output = builder.into_inner()?.finish()?;
        output.flush()?;
    }
    Ok(())
}

fn extract_tar_xz(source: &Path, out_dir: &Path, threads: usize) -> BenchResult<()> {
    fs::create_dir_all(out_dir)?;
    let file = File::open(source)?;
    let reader: Box<dyn Read> = if threads > 1 {
        Box::new(XzReaderMt::new(
            BufReader::new(file),
            false,
            threads.min(256) as u32,
        )?)
    } else {
        Box::new(XzReader::new(BufReader::new(file), false))
    };
    let mut archive = TarArchive::new(reader);
    archive.unpack(out_dir)?;
    Ok(())
}

fn average_duration(durations: &[Duration]) -> Duration {
    let total_nanos = durations
        .iter()
        .fold(0_u128, |acc, value| acc.saturating_add(value.as_nanos()));
    let avg_nanos = total_nanos / (durations.len() as u128);
    Duration::from_nanos(avg_nanos as u64)
}

fn duration_ms(value: Duration) -> f64 {
    value.as_secs_f64() * 1000.0
}

fn timed_runs(
    iterations: usize,
    mut operation: impl FnMut(usize) -> BenchResult<()>,
) -> BenchResult<Duration> {
    let mut samples = Vec::new();
    for iteration in 0..iterations {
        let start = Instant::now();
        operation(iteration)?;
        samples.push(start.elapsed());
    }
    Ok(average_duration(&samples))
}

fn main() -> BenchResult<()> {
    let workspace = temp_dir_path("workspace");
    fs::create_dir_all(&workspace)?;
    let input_dir = workspace.join("input");
    write_fixture_inputs(&input_dir)?;

    let zip_archive = workspace.join("bench.zip");
    create_zip_archive(&input_dir, &zip_archive)?;

    let zip_single = timed_runs(BENCH_ITERS, |iter| {
        let out_dir = workspace.join(format!("zip-single-{iter}"));
        let _ = fs::remove_dir_all(&out_dir);
        let result = zip_extract_single(&zip_archive, &out_dir);
        let _ = fs::remove_dir_all(&out_dir);
        result
    })?;
    let zip_parallel = timed_runs(BENCH_ITERS, |iter| {
        let out_dir = workspace.join(format!("zip-parallel-{iter}"));
        let _ = fs::remove_dir_all(&out_dir);
        let result = zip_extract_parallel(&zip_archive, &out_dir, BENCH_THREADS_PARALLEL);
        let _ = fs::remove_dir_all(&out_dir);
        result
    })?;

    let tar_create_single = timed_runs(BENCH_ITERS, |iter| {
        let output = workspace.join(format!("tar-single-{iter}.tar.xz"));
        let _ = fs::remove_file(&output);
        let result = create_tar_xz(&input_dir, &output, BENCH_THREADS_SINGLE);
        let _ = fs::remove_file(&output);
        result
    })?;
    let tar_create_parallel = timed_runs(BENCH_ITERS, |iter| {
        let output = workspace.join(format!("tar-parallel-{iter}.tar.xz"));
        let _ = fs::remove_file(&output);
        let result = create_tar_xz(&input_dir, &output, BENCH_THREADS_PARALLEL);
        let _ = fs::remove_file(&output);
        result
    })?;

    let tar_extract_source = workspace.join("extract-source.tar.xz");
    create_tar_xz(&input_dir, &tar_extract_source, BENCH_THREADS_PARALLEL)?;
    let tar_extract_single = timed_runs(BENCH_ITERS, |iter| {
        let out_dir = workspace.join(format!("tar-extract-single-{iter}"));
        let _ = fs::remove_dir_all(&out_dir);
        let result = extract_tar_xz(&tar_extract_source, &out_dir, BENCH_THREADS_SINGLE);
        let _ = fs::remove_dir_all(&out_dir);
        result
    })?;
    let tar_extract_parallel = timed_runs(BENCH_ITERS, |iter| {
        let out_dir = workspace.join(format!("tar-extract-parallel-{iter}"));
        let _ = fs::remove_dir_all(&out_dir);
        let result = extract_tar_xz(&tar_extract_source, &out_dir, BENCH_THREADS_PARALLEL);
        let _ = fs::remove_dir_all(&out_dir);
        result
    })?;

    println!(
        "zip extract avg: 1t={:.2} ms, 8t={:.2} ms, speedup={:.2}x",
        duration_ms(zip_single),
        duration_ms(zip_parallel),
        duration_ms(zip_single) / duration_ms(zip_parallel)
    );
    println!(
        "tar.xz create avg: 1t={:.2} ms, 8t={:.2} ms, speedup={:.2}x",
        duration_ms(tar_create_single),
        duration_ms(tar_create_parallel),
        duration_ms(tar_create_single) / duration_ms(tar_create_parallel)
    );
    println!(
        "tar.xz extract avg: 1t={:.2} ms, 8t={:.2} ms, speedup={:.2}x",
        duration_ms(tar_extract_single),
        duration_ms(tar_extract_parallel),
        duration_ms(tar_extract_single) / duration_ms(tar_extract_parallel)
    );
    println!(
        "fixtures: {} files x {} bytes",
        BENCH_FILE_COUNT, BENCH_FILE_SIZE
    );
    println!("iterations: {BENCH_ITERS}");
    println!("workspace: {}", workspace.display());
    let _ = fs::remove_dir_all(&workspace);

    Ok(())
}
