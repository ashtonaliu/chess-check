pub mod parquet;

pub fn peak_rss_bytes() -> u64 {
    // getrusage writes the process counters into this initialized C struct.
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } != 0 {
        return 0;
    }
    let units = if cfg!(target_os = "macos") { 1 } else { 1024 };
    usage.ru_maxrss as u64 * units
}
