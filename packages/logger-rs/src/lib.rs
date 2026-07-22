#![forbid(unsafe_code)]
//! `logger-rs` — a lightweight, scoped, timed logger for the `pics-rs` monorepo.
//!
//! Every record is emitted as a single line in the form:
//!
//! ```text
//! [HH:MM:SS] [LEVEL] [file:name] message
//! ```
//!
//! where `HH:MM:SS` is the local wall-clock time, `LEVEL` is one of
//! `TRACE DEBUG INFO WARN ERROR`, and `file:name` is a scope tag such as
//! `gallery.rs:scan_folder`. For example:
//!
//! ```text
//! [14:03:11] [INFO] [gallery.rs:scan_folder] Scanning folder took 2.30s
//! ```
//!
//! Records can be written to stderr (optionally with a colorized level token)
//! and/or appended to a log file. File output is always plain (no ANSI), and is
//! byte-identical to the console line minus color codes.
//!
//! # Quick start
//!
//! ```
//! use logger_rs::{init, Config, Level, Scope};
//!
//! init(Config { min_level: Level::Debug, ..Default::default() });
//!
//! let log = Scope::new("gallery.rs", "scan_folder");
//! log.info("starting scan");
//! {
//!     let _t = log.timer("scan");
//!     // ... work ...
//! } // logs "scan took <duration>" on drop
//! ```
//!
//! Or derive the file tag automatically with the [`scope!`] macro:
//!
//! ```
//! let log = logger_rs::scope!("scan_folder");
//! log.info("hello");
//! ```

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Severity level of a log record.
///
/// Levels are ordered `Trace < Debug < Info < Warn < Error`; a record is
/// emitted only when its level is `>=` the configured [`Config::min_level`].
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Level {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    /// The uppercase, unpadded token used in the log line (e.g. `"INFO"`).
    fn as_str(self) -> &'static str {
        match self {
            Level::Trace => "TRACE",
            Level::Debug => "DEBUG",
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
        }
    }

    /// ANSI SGR color code for the level token on the console.
    fn color_code(self) -> &'static str {
        match self {
            Level::Trace | Level::Debug => "\x1b[2m", // dim/gray
            Level::Info => "\x1b[32m",                // green
            Level::Warn => "\x1b[33m",                // yellow
            Level::Error => "\x1b[31m",               // red
        }
    }
}

/// Configuration for the global logger.
///
/// The [`Default`] configuration writes to stderr at [`Level::Info`] with color
/// enabled and no log file.
pub struct Config {
    /// Optional path to a log file. Records are appended; missing parent
    /// directories are created. If it can't be opened, logging falls back to
    /// console-only.
    pub file: Option<PathBuf>,
    /// Records below this level are dropped.
    pub min_level: Level,
    /// Also write records to stderr.
    pub console: bool,
    /// Colorize the `[LEVEL]` token on the console.
    pub color: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            file: None,
            min_level: Level::Info,
            console: true,
            color: true,
        }
    }
}

/// Internal global logger state, guarded by a single mutex so console and file
/// writes never interleave.
struct Logger {
    min_level: Level,
    console: bool,
    color: bool,
    file: Option<File>,
}

struct GlobalState {
    inner: Mutex<Logger>,
}

static GLOBAL: OnceLock<GlobalState> = OnceLock::new();

/// Lazily-initialized default logger (console on, `Info`, no file) so that
/// logging before [`init`] still prints to stderr.
fn global() -> &'static GlobalState {
    GLOBAL.get_or_init(|| GlobalState {
        inner: Mutex::new(Logger {
            min_level: Level::Info,
            console: true,
            color: true,
            file: None,
        }),
    })
}

/// Open (or create) the log file for appending, creating parent directories as
/// needed. Returns `None` on any error so callers can fall back to console.
fn open_file(path: &PathBuf) -> Option<File> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            let _ = std::fs::create_dir_all(parent);
        }
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}

/// Initialize or replace the global logger.
///
/// Idempotent and thread-safe: calling it again replaces the current
/// configuration. If never called, a default logger (console on, [`Level::Info`],
/// no file) is used lazily so logging before `init` still prints to stderr.
pub fn init(config: Config) {
    let file = config.file.as_ref().and_then(open_file);
    let state = global();
    if let Ok(mut logger) = state.inner.lock() {
        logger.min_level = config.min_level;
        logger.console = config.console;
        logger.color = config.color;
        logger.file = file;
    }
}

/// Build the plain (uncolored) log line, without a trailing newline.
///
/// Factored out as a pure function so the exact format can be unit-tested.
fn format_line(now_str: &str, level: Level, file: &str, name: &str, msg: &str) -> String {
    format!(
        "[{}] [{}] [{}:{}] {}",
        now_str,
        level.as_str(),
        file,
        name,
        msg
    )
}

/// Low-level emit. Respects the global [`Config::min_level`]. Thread-safe and
/// never panics; IO errors on write are ignored.
pub fn log(level: Level, file: &str, name: &str, msg: &str) {
    let state = global();
    let mut logger = match state.inner.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };

    if level < logger.min_level {
        return;
    }

    let now_str = chrono::Local::now().format("%H:%M:%S").to_string();
    let plain = format_line(&now_str, level, file, name, msg);

    if logger.console {
        if logger.color {
            // Colorize ONLY the level token.
            let colored = format!(
                "[{}] [{}{}\x1b[0m] [{}:{}] {}",
                now_str,
                level.color_code(),
                level.as_str(),
                file,
                name,
                msg
            );
            let _ = writeln!(std::io::stderr(), "{}", colored);
        } else {
            let _ = writeln!(std::io::stderr(), "{}", plain);
        }
    }

    if let Some(f) = logger.file.as_mut() {
        let _ = writeln!(f, "{}", plain);
        let _ = f.flush();
    }
}

/// Format a [`Duration`] compactly for human-readable output.
///
/// - `>= 1s`  → `{:.2}s` (e.g. `2.30s`)
/// - `>= 1ms` → `{:.1}ms` (e.g. `450.0ms`)
/// - `>= 1µs` → `{}µs`
/// - else     → `{}ns`
fn format_duration(d: Duration) -> String {
    let secs = d.as_secs_f64();
    if secs >= 1.0 {
        format!("{:.2}s", secs)
    } else {
        let nanos = d.as_nanos();
        if nanos >= 1_000_000 {
            format!("{:.1}ms", nanos as f64 / 1_000_000.0)
        } else if nanos >= 1_000 {
            format!("{}µs", nanos / 1_000)
        } else {
            format!("{}ns", nanos)
        }
    }
}

/// A scoped logger tag: a `file` (e.g. `gallery.rs`) and a `name`
/// (e.g. `scan_folder`) that prefix every record emitted through it.
#[derive(Clone)]
pub struct Scope {
    file: String,
    name: String,
}

impl Scope {
    /// Create a scope with the given `file` and `name` tags.
    ///
    /// ```
    /// let log = logger_rs::Scope::new("gallery.rs", "scan_folder");
    /// log.info("hi"); // -> [..] [INFO] [gallery.rs:scan_folder] hi
    /// ```
    pub fn new(file: impl Into<String>, name: impl Into<String>) -> Scope {
        Scope {
            file: file.into(),
            name: name.into(),
        }
    }

    /// Derive a child scope for a step within a function; the child's `name`
    /// becomes `"<name>:<step>"` while the `file` tag is preserved.
    pub fn step(&self, step: &str) -> Scope {
        Scope {
            file: self.file.clone(),
            name: format!("{}:{}", self.name, step),
        }
    }

    /// Log a message at [`Level::Trace`].
    pub fn trace(&self, msg: impl AsRef<str>) {
        log(Level::Trace, &self.file, &self.name, msg.as_ref());
    }

    /// Log a message at [`Level::Debug`].
    pub fn debug(&self, msg: impl AsRef<str>) {
        log(Level::Debug, &self.file, &self.name, msg.as_ref());
    }

    /// Log a message at [`Level::Info`].
    pub fn info(&self, msg: impl AsRef<str>) {
        log(Level::Info, &self.file, &self.name, msg.as_ref());
    }

    /// Log a message at [`Level::Warn`].
    pub fn warn(&self, msg: impl AsRef<str>) {
        log(Level::Warn, &self.file, &self.name, msg.as_ref());
    }

    /// Log a message at [`Level::Error`].
    pub fn error(&self, msg: impl AsRef<str>) {
        log(Level::Error, &self.file, &self.name, msg.as_ref());
    }

    /// Start an RAII [`Timer`]. On drop it logs `"<label> took <duration>"` at
    /// the timer's level (default [`Level::Info`]) under this scope's tag.
    pub fn timer(&self, label: impl Into<String>) -> Timer {
        Timer {
            scope: self.clone(),
            label: label.into(),
            start: Instant::now(),
            level: Level::Info,
            done: false,
        }
    }

    /// Time a closure: run `f`, log `"<label> took <duration>"` at
    /// [`Level::Info`] under this scope's tag, and return `f`'s value.
    pub fn time<T>(&self, label: &str, f: impl FnOnce() -> T) -> T {
        let start = Instant::now();
        let value = f();
        let elapsed = start.elapsed();
        log(
            Level::Info,
            &self.file,
            &self.name,
            &format!("{} took {}", label, format_duration(elapsed)),
        );
        value
    }
}

/// An RAII timer that logs the elapsed time on drop.
///
/// Created via [`Scope::timer`]. On drop (unless [`Timer::done`] was called) it
/// logs `"<label> took <duration>"` at its level under the originating scope.
pub struct Timer {
    scope: Scope,
    label: String,
    start: Instant,
    level: Level,
    done: bool,
}

impl Timer {
    /// Set the level the elapsed line is logged at (builder style).
    pub fn level(mut self, level: Level) -> Timer {
        self.level = level;
        self
    }

    /// Log the elapsed line immediately and consume the timer; the subsequent
    /// drop will NOT log again.
    pub fn done(mut self) {
        self.emit();
        self.done = true;
    }

    /// The duration elapsed since the timer started.
    pub fn elapsed(&self) -> Duration {
        self.start.elapsed()
    }

    /// Emit the elapsed line under the timer's scope and level.
    fn emit(&self) {
        log(
            self.level,
            &self.scope.file,
            &self.scope.name,
            &format!("{} took {}", self.label, format_duration(self.start.elapsed())),
        );
    }
}

impl Drop for Timer {
    fn drop(&mut self) {
        if !self.done {
            self.emit();
        }
    }
}

/// Create a [`Scope`] whose `file` tag is the basename of the caller's source
/// file and whose `name` is the given expression.
///
/// ```
/// let log = logger_rs::scope!("scan_folder");
/// // -> Scope::new("<this-file>.rs", "scan_folder")
/// log.info("scanning");
/// ```
#[macro_export]
macro_rules! scope {
    ($name:expr) => {{
        let __full = file!();
        let __base = __full.rsplit(['/', '\\']).next().unwrap_or(__full);
        $crate::Scope::new(__base, $name)
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_ordering() {
        assert!(Level::Trace < Level::Debug);
        assert!(Level::Debug < Level::Info);
        assert!(Level::Info < Level::Warn);
        assert!(Level::Warn < Level::Error);
        assert!(Level::Error > Level::Trace);
        assert_eq!(Level::Info, Level::Info);
    }

    #[test]
    fn level_filtering() {
        // A record is emitted only when level >= min_level.
        let min = Level::Warn;
        assert!(Level::Trace < min);
        assert!(Level::Info < min);
        assert!(Level::Warn >= min);
        assert!(Level::Error >= min);
    }

    #[test]
    fn exact_formatted_line() {
        let line = format_line("14:03:11", Level::Info, "gallery.rs", "scan_folder", "Scanning folder took 2.30s");
        assert_eq!(line, "[14:03:11] [INFO] [gallery.rs:scan_folder] Scanning folder took 2.30s");
    }

    #[test]
    fn formatted_line_levels_unpadded() {
        assert_eq!(
            format_line("00:00:00", Level::Warn, "a.rs", "f", "hi"),
            "[00:00:00] [WARN] [a.rs:f] hi"
        );
        assert_eq!(
            format_line("00:00:00", Level::Error, "a.rs", "f", "hi"),
            "[00:00:00] [ERROR] [a.rs:f] hi"
        );
        assert_eq!(
            format_line("00:00:00", Level::Trace, "a.rs", "f", "hi"),
            "[00:00:00] [TRACE] [a.rs:f] hi"
        );
    }

    #[test]
    fn duration_seconds() {
        assert_eq!(format_duration(Duration::from_millis(2300)), "2.30s");
        assert_eq!(format_duration(Duration::from_secs(1)), "1.00s");
        assert_eq!(format_duration(Duration::from_secs_f64(1.5)), "1.50s");
    }

    #[test]
    fn duration_millis() {
        assert_eq!(format_duration(Duration::from_millis(450)), "450.0ms");
        assert_eq!(format_duration(Duration::from_millis(1)), "1.0ms");
    }

    #[test]
    fn duration_micros() {
        assert_eq!(format_duration(Duration::from_micros(1)), "1µs");
        assert_eq!(format_duration(Duration::from_micros(999)), "999µs");
    }

    #[test]
    fn duration_nanos() {
        assert_eq!(format_duration(Duration::from_nanos(1)), "1ns");
        assert_eq!(format_duration(Duration::from_nanos(999)), "999ns");
    }

    #[test]
    fn duration_thresholds() {
        // Just below 1ms is micros.
        assert_eq!(format_duration(Duration::from_nanos(999_999)), "999µs");
        // Exactly 1ms crosses into ms.
        assert_eq!(format_duration(Duration::from_nanos(1_000_000)), "1.0ms");
        // Just below 1µs is nanos.
        assert_eq!(format_duration(Duration::from_nanos(999)), "999ns");
        // Exactly 1µs crosses into micros.
        assert_eq!(format_duration(Duration::from_nanos(1_000)), "1µs");
    }

    #[test]
    fn scope_step_appends_name() {
        let s = Scope::new("gallery.rs", "scan_folder");
        let child = s.step("read");
        assert_eq!(child.file, "gallery.rs");
        assert_eq!(child.name, "scan_folder:read");
        // Nested steps chain.
        let grandchild = child.step("decode");
        assert_eq!(grandchild.name, "scan_folder:read:decode");
    }

    #[test]
    fn scope_new_accepts_string_and_str() {
        let s1 = Scope::new("a.rs", "f");
        let s2 = Scope::new(String::from("a.rs"), String::from("f"));
        assert_eq!(s1.file, s2.file);
        assert_eq!(s1.name, s2.name);
    }

    #[test]
    fn timer_logs_to_file_on_drop() {
        // Use a temp file so we can observe the drop-emitted line without
        // touching global console assumptions.
        let dir = std::env::temp_dir().join(format!("logger_rs_test_{}", std::process::id()));
        let path = dir.join("nested/timer.log");
        init(Config {
            file: Some(path.clone()),
            min_level: Level::Trace,
            console: false,
            color: false,
        });

        {
            let s = Scope::new("bench.rs", "work");
            let _t = s.timer("job");
        } // drop logs here

        // Also verify explicit done() emits and drop does not double-log.
        {
            let s = Scope::new("bench.rs", "work2");
            let t = s.timer("job2");
            t.done();
        }

        let contents = std::fs::read_to_string(&path).expect("log file should exist");
        assert!(contents.contains("[bench.rs:work] job took"), "got: {contents}");
        assert!(contents.contains("[bench.rs:work2] job2 took"), "got: {contents}");
        // job2 must appear exactly once (done + no double drop).
        assert_eq!(contents.matches("job2 took").count(), 1, "got: {contents}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scope_macro_uses_basename() {
        let log = scope!("some_fn");
        assert_eq!(log.file, "lib.rs");
        assert_eq!(log.name, "some_fn");
    }

    #[test]
    fn timer_level_builder() {
        let s = Scope::new("a.rs", "f");
        let t = s.timer("x").level(Level::Debug);
        assert_eq!(t.level, Level::Debug);
        t.done();
    }

    #[test]
    fn time_closure_returns_value() {
        let s = Scope::new("a.rs", "f");
        let v = s.time("compute", || 21 * 2);
        assert_eq!(v, 42);
    }
}
