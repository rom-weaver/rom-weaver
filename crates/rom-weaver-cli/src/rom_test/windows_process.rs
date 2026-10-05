use std::{ffi::c_void, io, mem, os::windows::io::AsRawHandle, process::Child, ptr};

use rom_weaver_core::{Result, RomWeaverError};

type Handle = *mut c_void;
pub(super) const CREATE_SUSPENDED: u32 = 0x0000_0004;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;

#[repr(C)]
#[derive(Default)]
struct BasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[repr(C)]
#[derive(Default)]
struct IoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[repr(C)]
#[derive(Default)]
struct ExtendedLimitInformation {
    basic_limit_information: BasicLimitInformation,
    io_info: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(
        job: Handle,
        class: i32,
        information: *const c_void,
        length: u32,
    ) -> i32;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtResumeProcess(process: Handle) -> i32;
}

pub(super) struct Job(Handle);

impl Job {
    pub(super) fn assign(child: &Child) -> Result<Self> {
        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if handle.is_null() {
            return Err(RomWeaverError::Io(io::Error::last_os_error()));
        }
        let mut information = ExtendedLimitInformation::default();
        information.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                (&raw const information).cast(),
                mem::size_of::<ExtendedLimitInformation>() as u32,
            )
        };
        let assigned = configured != 0
            && unsafe { AssignProcessToJobObject(handle, child.as_raw_handle().cast()) } != 0;
        if !assigned {
            let error = io::Error::last_os_error();
            unsafe { CloseHandle(handle) };
            return Err(RomWeaverError::Io(error));
        }

        // std::process does not retain the primary thread handle. The child MUST
        // start suspended so the job owns it before any descendant can escape.
        let resume_status = unsafe { NtResumeProcess(child.as_raw_handle().cast()) };
        if resume_status < 0 {
            unsafe { CloseHandle(handle) };
            return Err(RomWeaverError::Io(io::Error::other(format!(
                "cannot resume emulator process: NTSTATUS {resume_status:#010x}"
            ))));
        }
        Ok(Self(handle))
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io::Read,
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        sync::mpsc,
        thread,
        time::Duration,
    };

    use super::{CREATE_SUSPENDED, Job};

    #[test]
    fn closing_job_closes_descendant_pipes() {
        let mut command = Command::new("cmd.exe");
        command
            .args([
                "/D",
                "/C",
                "start \"\" /B ping.exe -n 30 127.0.0.1 & exit /B 0",
            ])
            .creation_flags(CREATE_SUSPENDED)
            .stdout(Stdio::piped());
        let mut child = command.spawn().unwrap();
        let job = Job::assign(&child).unwrap();
        let mut stdout = child.stdout.take().unwrap();
        drop(job);
        let _ = child.kill();
        child.wait().unwrap();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || sender.send(stdout.read_to_end(&mut Vec::new())).unwrap());
        receiver
            .recv_timeout(Duration::from_secs(3))
            .expect("the job must close pipes inherited by descendants")
            .unwrap();
    }
}
