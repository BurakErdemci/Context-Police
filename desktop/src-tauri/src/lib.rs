//! Desktop shell for the Context Police local web app.
//!
//! The shell owns no UI of its own: it makes sure the `serve` HTTP server is
//! running on 127.0.0.1:4870, then opens a window pointed at it.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const DEFAULT_PORT: u16 = 4870;
const HEALTH_PATH: &str = "/api/version";

/// `CONTEXT_POLICE_PORT` exists so the spawn path can be exercised while another
/// server already owns the default port.
fn port() -> u16 {
    std::env::var("CONTEXT_POLICE_PORT")
        .ok()
        .and_then(|raw| raw.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn app_url() -> String {
    format!("http://127.0.0.1:{}", port())
}

const PROBE_TIMEOUT: Duration = Duration::from_millis(600);
const STARTUP_PROBE_ATTEMPTS: u32 = 3;
const BOOT_DEADLINE: Duration = Duration::from_secs(10);

/// Child server we started ourselves. `None` means we attached to a server that
/// was already running — that one is somebody else's process and must survive us.
struct OwnedServer(Mutex<Option<Child>>);

/// One raw HTTP/1.0 GET against the health endpoint. Deliberately dependency-free:
/// pulling in an HTTP client for a single liveness check is not worth the build time.
fn probe_once(timeout: Duration) -> bool {
    let p = port();
    let addr = SocketAddr::from(([127, 0, 0, 1], p));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, timeout) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));

    let request =
        format!("GET {HEALTH_PATH} HTTP/1.0\r\nHost: 127.0.0.1:{p}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut head = [0u8; 64];
    let Ok(n) = stream.read(&mut head) else {
        return false;
    };
    String::from_utf8_lossy(&head[..n]).starts_with("HTTP/1.")
        && String::from_utf8_lossy(&head[..n]).contains(" 200 ")
}

fn server_reachable() -> bool {
    (0..STARTUP_PROBE_ATTEMPTS).any(|attempt| {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(200));
        }
        probe_once(PROBE_TIMEOUT)
    })
}

/// V1 limitation: the repo root is resolved from the compile-time crate location
/// (`<repo>/desktop/src-tauri`), which only holds for a dev build run from the repo.
/// `CONTEXT_POLICE_ROOT` overrides it. A bundled app will need the server shipped
/// alongside the binary instead.
fn repo_root() -> PathBuf {
    if let Ok(explicit) = std::env::var("CONTEXT_POLICE_ROOT") {
        return PathBuf::from(explicit);
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let guess = manifest.join("..").join("..");
    guess.canonicalize().unwrap_or(guess)
}

fn spawn_server() -> std::io::Result<Child> {
    let root = repo_root();
    let cli = root.join("core").join("src").join("cli.ts");
    if !cli.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("cli entry not found at {}", cli.display()),
        ));
    }
    Command::new("node")
        .arg("--experimental-strip-types")
        .arg(&cli)
        .arg("serve")
        .arg("--port")
        .arg(port().to_string())
        .current_dir(&root)
        .spawn()
}

/// Returns the child process if (and only if) we started the server.
fn ensure_server() -> Option<Child> {
    if server_reachable() {
        eprintln!("[shell] server already running on {}, attaching", app_url());
        return None;
    }

    eprintln!("[shell] no server on {}, spawning one", app_url());
    let child = match spawn_server() {
        Ok(child) => child,
        Err(err) => {
            eprintln!("[shell] failed to spawn server: {err}");
            return None;
        }
    };

    let deadline = Instant::now() + BOOT_DEADLINE;
    while Instant::now() < deadline {
        if probe_once(PROBE_TIMEOUT) {
            eprintln!("[shell] server is up");
            return Some(child);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    eprintln!("[shell] server did not answer within {BOOT_DEADLINE:?}; opening window anyway");
    Some(child)
}

/// PID of the server we spawned, mirrored outside the mutex so a signal handler
/// can reach it. 0 means "we own nothing".
#[cfg(unix)]
static OWNED_PID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

/// Measured 17 Aug 2026: a SIGTERM to the shell never reaches `RunEvent::Exit`,
/// so the spawned node server survived as an orphan holding the port. Only the
/// normal quit paths (window close / Cmd+Q) go through the Tauri lifecycle.
#[cfg(unix)]
extern "C" fn on_signal(sig: libc::c_int) {
    let pid = OWNED_PID.swap(0, std::sync::atomic::Ordering::SeqCst);
    if pid > 0 {
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
    unsafe {
        libc::signal(sig, libc::SIG_DFL);
        libc::raise(sig);
    }
}

#[cfg(unix)]
fn install_signal_cleanup(pid: u32) {
    OWNED_PID.store(pid as i32, std::sync::atomic::Ordering::SeqCst);
    unsafe {
        libc::signal(libc::SIGTERM, on_signal as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, on_signal as *const () as libc::sighandler_t);
        libc::signal(libc::SIGHUP, on_signal as *const () as libc::sighandler_t);
    }
}

#[cfg(not(unix))]
fn install_signal_cleanup(_pid: u32) {}

fn stop_owned_server(state: &OwnedServer) {
    #[cfg(unix)]
    OWNED_PID.store(0, std::sync::atomic::Ordering::SeqCst);

    let Ok(mut guard) = state.0.lock() else {
        return;
    };
    if let Some(mut child) = guard.take() {
        eprintln!("[shell] stopping the server we spawned (pid {})", child.id());
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let child = ensure_server();
    if let Some(ref c) = child {
        install_signal_cleanup(c.id());
    }
    let owned = OwnedServer(Mutex::new(child));

    tauri::Builder::default()
        .manage(owned)
        // The window is built here rather than declared in tauri.conf.json so the
        // URL can follow CONTEXT_POLICE_PORT. setup() runs after ensure_server(),
        // so the webview never races the server boot.
        .setup(|app| {
            let url = tauri::WebviewUrl::External(app_url().parse()?);
            tauri::WebviewWindowBuilder::new(app, "main", url)
                .title("Context Police")
                // Portrait, matching the notebook the UI draws. Height is capped
                // at 1080 rather than the notebook's true ratio because a 13"
                // display leaves only ~1000-1050pt once the menu bar is gone.
                .inner_size(940.0, 1080.0)
                .min_inner_size(820.0, 980.0)
                .resizable(true)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Context Police shell")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                stop_owned_server(&*tauri::Manager::state::<OwnedServer>(app));
            }
        });
}
