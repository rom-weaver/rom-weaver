use std::process::ExitCode;

// musl's default malloc serializes threads, which slows the compression pools.
#[cfg(all(target_env = "musl", not(target_family = "wasm")))]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() -> ExitCode {
    rom_weaver_app::main_entry()
}
