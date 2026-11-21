//! Portable exe self-update (docs/UPDATES.md §4) — the same steps as the shared exe auto-update method
//! (version manifest + exe swap):
//!
//! 1. The UI finds a new version in latest.json (`portable.windows-x86_64`: url, size, sha256, minisign signature),
//!    shows what changed and asks. `portable_update_download` stores the release's portable exe next to this one as
//!    `<name>.new.exe`, checks its size, SHA-256 and signature (the updater's public key), and runs
//!    `<name>.new.exe --selftest` (no window).
//! 2. `portable_update_finish` starts `<name>.new.exe --finish-update "<this exe>" <pid>` and closes this app.
//! 3. `--finish-update` (handled first thing in `run()`): wait for that pid to end, move this exe to `<name>.exe.old`,
//!    copy itself to the same path under the same name (retrying while the file is still locked), start it.
//! 4. The next start removes `<name>.new.exe` and `<name>.exe.old` (`cleanup_leftovers`).
//!
//! Same path and name: shortcuts, pinned taskbar items and file associations keep working. A folder the app cannot
//! write to (Program Files, a read-only share) is reported as `no-write`; the UI then opens the download page instead.
//! Every step is logged to %TEMP%/omniweave-update.log.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// CREATE_NO_WINDOW: helper processes never flash a console
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Held while the start-up clean-up runs, so a download that starts right after launch never races it.
static CLEANUP: Mutex<()> = Mutex::new(());

/// `<dir>\<stem>.new.exe` — the downloaded new version (it must end in .exe to run)
pub fn new_path(exe: &Path) -> PathBuf {
    let stem = exe.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "omniweave".into());
    exe.with_file_name(format!("{stem}.new.exe"))
}

/// `<dir>\<name>.exe.old` — the replaced version, removed on the next start
pub fn old_path(exe: &Path) -> PathBuf {
    let name = exe.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "omniweave.exe".into());
    exe.with_file_name(format!("{name}.old"))
}

/// True for a file name like `x.new.exe` (a downloaded update that is running, e.g. its self-test or the swap).
pub fn is_new_exe(exe: &Path) -> bool {
    exe.file_name().map(|n| n.to_string_lossy().to_lowercase().ends_with(".new.exe")).unwrap_or(false)
}

/// One line to %TEMP%/omniweave-update.log (the same file as the UI's update_log)
pub fn log(line: &str) {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(std::env::temp_dir().join("omniweave-update.log")) {
        // the process id, not a version: a swap runs from the new exe while the log names the old one
        let _ = writeln!(f, "{secs} portable[{}]: {line}", std::process::id());
    }
}

/// Remove what a finished update left: `<name>.new.exe` (it may still be closing — retried for a few seconds) and
/// `<name>.exe.old`. Never runs from a `.new.exe` itself.
pub fn cleanup_leftovers(exe: &Path, tries: u32, wait: Duration) -> Vec<PathBuf> {
    let _guard = CLEANUP.lock().unwrap_or_else(|e| e.into_inner());
    let mut removed = Vec::new();
    if is_new_exe(exe) {
        return removed;
    }
    for p in [new_path(exe), old_path(exe)] {
        for i in 0..tries.max(1) {
            if !p.exists() {
                break;
            }
            if fs::remove_file(&p).is_ok() {
                removed.push(p.clone());
                break;
            }
            if i + 1 < tries {
                std::thread::sleep(wait);
            }
        }
    }
    removed
}

/// Lower-case hex SHA-256 of a file
pub fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// minisign signature check, exactly as the Tauri updater checks the installer: the public key (tauri.conf.json
/// plugins.updater.pubkey) and the signature (the `.sig` file) are base64 of the minisign text forms.
pub fn verify_signature(data: &[u8], signature_b64: &str, pubkey_b64: &str) -> Result<(), String> {
    use base64::Engine;
    let text = |b64: &str, what: &str| -> Result<String, String> {
        let raw = base64::engine::general_purpose::STANDARD.decode(b64.trim()).map_err(|e| format!("{what}: {e}"))?;
        String::from_utf8(raw).map_err(|e| format!("{what}: {e}"))
    };
    let pk = minisign_verify::PublicKey::decode(&text(pubkey_b64, "public key")?).map_err(|e| format!("public key: {e}"))?;
    let sig = minisign_verify::Signature::decode(&text(signature_b64, "signature")?).map_err(|e| format!("signature: {e}"))?;
    pk.verify(data, &sig, true).map_err(|e| format!("signature does not match: {e}"))
}

/// Size, SHA-256 and signature of a downloaded file against the manifest
pub fn verify_file(path: &Path, size: u64, sha256: &str, signature_b64: &str, pubkey_b64: &str) -> Result<(), String> {
    let got = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if got != size {
        return Err(format!("size {got}, expected {size}"));
    }
    let h = sha256_file(path)?;
    if !h.eq_ignore_ascii_case(sha256.trim()) {
        return Err(format!("sha256 {h}, expected {sha256}"));
    }
    let data = fs::read(path).map_err(|e| e.to_string())?;
    verify_signature(&data, signature_b64, pubkey_b64)
}

/// `exe --selftest` without a window; true when it exits 0 within `timeout`
pub fn run_selftest(exe: &Path, timeout: Duration) -> Result<(), String> {
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("--selftest").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("selftest did not start: {e}"))?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(st)) if st.success() => return Ok(()),
            Ok(Some(st)) => return Err(format!("selftest failed ({st})")),
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                return Err("selftest did not finish".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Put `new_exe` in place of `target`: `target` → `target.old`, then a copy of `new_exe` → `target` (the same path and
/// name). Both steps are retried while the old process still holds the file. If the copy fails for good, the old
/// version is moved back so the user keeps a working exe.
pub fn swap_in(new_exe: &Path, target: &Path, tries: u32, wait: Duration) -> Result<(), String> {
    let old = old_path(target);
    let mut last = String::new();
    for i in 0..tries.max(1) {
        if i > 0 {
            std::thread::sleep(wait);
        }
        if old.exists() {
            if let Err(e) = fs::remove_file(&old) {
                last = format!("remove {}: {e}", old.display());
                continue;
            }
        }
        if target.exists() {
            if let Err(e) = fs::rename(target, &old) {
                last = format!("move {} aside: {e}", target.display());
                continue;
            }
        }
        match fs::copy(new_exe, target) {
            Ok(_) => return Ok(()),
            Err(e) => {
                last = format!("copy to {}: {e}", target.display());
                let _ = fs::remove_file(target);
                let _ = fs::rename(&old, target); // keep the old version working, then try again
            }
        }
    }
    Err(last)
}

/// Wait until process `pid` has ended (or `timeout`). A pid that cannot be opened has already ended.
#[cfg(windows)]
pub fn wait_pid(pid: u32, timeout: Duration) -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn WaitForSingleObject(handle: isize, ms: u32) -> u32;
        fn CloseHandle(handle: isize) -> i32;
    }
    const SYNCHRONIZE: u32 = 0x0010_0000;
    // SAFETY: plain Win32 calls on a handle we own and close
    unsafe {
        let h = OpenProcess(SYNCHRONIZE, 0, pid);
        if h == 0 {
            return true;
        }
        let rc = WaitForSingleObject(h, timeout.as_millis().min(u32::MAX as u128 - 1) as u32);
        CloseHandle(h);
        rc == 0
    }
}
#[cfg(not(windows))]
pub fn wait_pid(_pid: u32, _timeout: Duration) -> bool {
    true
}

/// Start `exe` as a normal app (its own folder as the working directory) and do not wait for it
fn launch(exe: &Path, args: &[&str]) -> Result<(), String> {
    let mut cmd = std::process::Command::new(exe);
    cmd.args(args);
    if let Some(dir) = exe.parent() {
        cmd.current_dir(dir);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// `--finish-update "<target exe>" <pid>`: runs from the downloaded `<name>.new.exe`. Returns the process exit code.
pub fn finish_update(args: &[String]) -> i32 {
    let i = match args.iter().position(|a| a == "--finish-update") {
        Some(i) => i,
        None => return 2,
    };
    let (Some(target), Some(pid)) = (args.get(i + 1).map(PathBuf::from), args.get(i + 2).and_then(|p| p.parse::<u32>().ok())) else {
        log("finish-update: bad arguments");
        return 2;
    };
    let me = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            log(&format!("finish-update: own path unknown: {e}"));
            return 1;
        }
    };
    log(&format!("finish-update: waiting for pid {pid} to close"));
    if !wait_pid(pid, Duration::from_secs(60)) {
        log(&format!("finish-update: pid {pid} still running after 60 s, trying anyway"));
    }
    match swap_in(&me, &target, 60, Duration::from_millis(500)) {
        Ok(()) => {
            log(&format!("finish-update: replaced {}", target.display()));
            match launch(&target, &[]) {
                Ok(()) => {
                    log("finish-update: restarted");
                    0
                }
                Err(e) => {
                    log(&format!("finish-update: restart failed: {e}"));
                    1
                }
            }
        }
        Err(e) => {
            log(&format!("finish-update: could not replace the exe: {e}; starting the previous version"));
            let _ = launch(&target, &[]);
            1
        }
    }
}

/// Download `url` to `dest`, calling `progress(got, total)` now and then. Only https, or http to this PC (local tests).
pub async fn download(url: &str, dest: &Path, mut progress: impl FnMut(u64, u64)) -> Result<u64, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("bad url: {e}"))?;
    let local = matches!(parsed.host_str(), Some("127.0.0.1") | Some("localhost") | Some("[::1]"));
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && local) {
        return Err(format!("refusing a non-https download: {url}"));
    }
    // reqwest is built without its own crypto provider in this tree; ring is the one rustls already has (an Err only
    // means a provider is installed already)
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .user_agent("Omniweave portable-updater")
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client.get(parsed).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?;
    let total = resp.content_length().unwrap_or(0);
    let mut f = fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut got = 0u64;
    let mut last = Instant::now();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        f.write_all(&chunk).map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        if last.elapsed() > Duration::from_millis(150) {
            progress(got, total);
            last = Instant::now();
        }
    }
    f.flush().map_err(|e| e.to_string())?;
    progress(got, total);
    Ok(got)
}

/// Whether a new file can be created next to `exe` (false for Program Files and read-only folders)
pub fn folder_writable(exe: &Path) -> bool {
    let probe = exe.with_file_name(format!(".omniweave-write-test-{}", std::process::id()));
    match fs::File::create(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// The new exe that `portable_update_download` checked (kept until `portable_update_finish`)
static READY: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Download, check and self-test the new portable exe (step 1). Errors starting with `no-write` mean the folder is
/// not writable (the UI opens the download page instead).
#[tauri::command]
pub async fn portable_update_download(app: tauri::AppHandle, url: String, size: u64, sha256: String, signature: String) -> Result<(), String> {
    use tauri::Emitter;
    if crate::store_package() {
        return Err("store package: the Microsoft Store updates this app".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if is_new_exe(&exe) {
        return Err("running from a downloaded update".into());
    }
    if !folder_writable(&exe) {
        log(&format!("no write access to {}", exe.parent().map(|p| p.display().to_string()).unwrap_or_default()));
        return Err("no-write".into());
    }
    let pubkey = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .map(str::to_string)
        .ok_or("no updater public key")?;
    let dest = new_path(&exe);
    drop(CLEANUP.lock().unwrap_or_else(|e| e.into_inner())); // the start-up clean-up has finished
    log(&format!("download {url} → {}", dest.display()));
    let h = app.clone();
    let got = download(&url, &dest, move |got, total| {
        let _ = h.emit("portable-update-progress", (got, total));
    })
    .await
    .map_err(|e| {
        let _ = fs::remove_file(&dest);
        log(&format!("download failed: {e}"));
        e
    })?;
    let d2 = dest.clone();
    let checked = tauri::async_runtime::spawn_blocking(move || {
        verify_file(&d2, size, &sha256, &signature, &pubkey).map_err(|e| format!("check failed: {e}"))?;
        run_selftest(&d2, Duration::from_secs(120))
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    if let Err(e) = checked {
        let _ = fs::remove_file(&dest);
        log(&format!("{e} — removed {}", dest.display()));
        return Err(e);
    }
    log(&format!("downloaded {got} bytes, size + sha256 + signature + selftest ok"));
    *READY.lock().unwrap_or_else(|e| e.into_inner()) = Some(dest);
    Ok(())
}

/// Start the checked new exe with `--finish-update` and close this app (step 2).
#[tauri::command]
pub fn portable_update_finish(app: tauri::AppHandle) -> Result<(), String> {
    let new = READY.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("no update downloaded")?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(&new);
    cmd.arg("--finish-update").arg(&exe).arg(std::process::id().to_string());
    if let Some(dir) = exe.parent() {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map_err(|e| {
        log(&format!("finish-update did not start: {e}"));
        e.to_string()
    })?;
    log(&format!("started {} --finish-update, closing", new.display()));
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("omw-portable-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn names() {
        let exe = Path::new(r"C:\Apps\Omniweave_0.2.0_x64-portable.exe");
        assert_eq!(new_path(exe), Path::new(r"C:\Apps\Omniweave_0.2.0_x64-portable.new.exe"));
        assert_eq!(old_path(exe), Path::new(r"C:\Apps\Omniweave_0.2.0_x64-portable.exe.old"));
        assert!(is_new_exe(&new_path(exe)));
        assert!(!is_new_exe(exe));
    }

    #[test]
    fn swap_puts_the_new_file_under_the_old_name_and_keeps_the_old_one_aside() {
        let d = tmp("swap");
        let target = d.join("app.exe");
        let new = new_path(&target);
        fs::write(&target, b"old version").unwrap();
        fs::write(&new, b"new version").unwrap();
        swap_in(&new, &target, 3, Duration::from_millis(10)).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new version");
        assert_eq!(fs::read(old_path(&target)).unwrap(), b"old version");
        // the next start removes both leftovers
        let removed = cleanup_leftovers(&target, 2, Duration::from_millis(10));
        assert_eq!(removed.len(), 2);
        assert!(!new.exists() && !old_path(&target).exists() && target.exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn swap_waits_for_a_locked_exe() {
        let d = tmp("locked");
        let target = d.join("app.exe");
        let new = new_path(&target);
        fs::write(&target, b"old").unwrap();
        fs::write(&new, b"new").unwrap();
        // a file opened without FILE_SHARE_DELETE cannot be renamed (like a running exe) — released after 300 ms
        #[cfg(windows)]
        let held = {
            use std::os::windows::fs::OpenOptionsExt;
            fs::OpenOptions::new().read(true).share_mode(1).open(&target).unwrap()
        };
        #[cfg(windows)]
        {
            assert!(swap_in(&new, &target, 2, Duration::from_millis(10)).is_err(), "must not replace a locked exe");
            assert_eq!(fs::read(&target).unwrap(), b"old", "the old version stays in place");
        }
        #[cfg(windows)]
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            drop(held);
        });
        swap_in(&new, &target, 40, Duration::from_millis(50)).unwrap();
        #[cfg(windows)]
        t.join().unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_missing_source_keeps_the_old_version() {
        let d = tmp("missing");
        let target = d.join("app.exe");
        fs::write(&target, b"old").unwrap();
        assert!(swap_in(&d.join("gone.new.exe"), &target, 2, Duration::from_millis(10)).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"old");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn cleanup_never_runs_from_the_downloaded_exe() {
        let d = tmp("selfnew");
        let target = d.join("app.exe");
        let new = new_path(&target);
        fs::write(&new, b"x").unwrap();
        assert!(cleanup_leftovers(&new, 1, Duration::from_millis(1)).is_empty());
        assert!(new.exists());
        let _ = fs::remove_dir_all(&d);
    }

    // a throwaway minisign key pair made for this test only (`tauri signer generate`, empty password) and the
    // signature of the bytes b"omniweave portable update test\n" — base64 of the minisign text forms, like the
    // updater's pubkey and .sig files
    const TEST_PUB: &str = include_str!("../testdata/portable-test-key.pub");
    const TEST_SIG: &str = include_str!("../testdata/portable-test-data.sig");
    const TEST_DATA: &[u8] = b"omniweave portable update test\n";

    #[test]
    fn size_sha_and_signature_are_all_checked() {
        let d = tmp("verify");
        let f = d.join("x.new.exe");
        fs::write(&f, TEST_DATA).unwrap();
        let sha = sha256_file(&f).unwrap();
        assert_eq!(sha.len(), 64);
        verify_file(&f, TEST_DATA.len() as u64, &sha, TEST_SIG, TEST_PUB).unwrap();
        assert!(verify_file(&f, TEST_DATA.len() as u64 + 1, &sha, TEST_SIG, TEST_PUB).unwrap_err().starts_with("size"));
        assert!(verify_file(&f, TEST_DATA.len() as u64, &"0".repeat(64), TEST_SIG, TEST_PUB).unwrap_err().starts_with("sha256"));
        // same size and a matching sha256 written by an attacker: the signature still fails
        fs::write(&f, b"omniweave portable update TEST\n").unwrap();
        let sha2 = sha256_file(&f).unwrap();
        assert!(verify_file(&f, TEST_DATA.len() as u64, &sha2, TEST_SIG, TEST_PUB).unwrap_err().contains("signature"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn selftest_exit_code_decides() {
        // cmd.exe stands in for the new exe: `cmd --selftest` is not a cmd switch, so use a tiny .cmd per answer
        #[cfg(windows)]
        {
            let d = tmp("selftest");
            let ok = d.join("ok.cmd");
            let bad = d.join("bad.cmd");
            fs::write(&ok, "@exit /b 0\r\n").unwrap();
            fs::write(&bad, "@exit /b 3\r\n").unwrap();
            run_selftest(&ok, Duration::from_secs(20)).unwrap();
            assert!(run_selftest(&bad, Duration::from_secs(20)).is_err());
            assert!(run_selftest(&d.join("none.exe"), Duration::from_secs(5)).is_err());
            let _ = fs::remove_dir_all(&d);
        }
    }

    #[test]
    fn only_https_or_this_pc() {
        let d = tmp("url");
        let f = d.join("x");
        let run = |u: &str| tauri::async_runtime::block_on(download(u, &f, |_, _| {}));
        assert!(run("http://example.com/x.exe").unwrap_err().contains("non-https"));
        assert!(run("file:///C:/x.exe").unwrap_err().contains("non-https"));
        let _ = fs::remove_dir_all(&d);
    }


    #[test]
    fn downloads_from_a_local_server() {
        use std::net::TcpListener;
        let srv = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = srv.local_addr().unwrap().port();
        let body = vec![7u8; 300_000];
        let b2 = body.clone();
        std::thread::spawn(move || {
            let (mut s, _) = srv.accept().unwrap();
            let mut req = [0u8; 2048];
            let _ = s.read(&mut req);
            let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", b2.len());
            let _ = s.write_all(&b2);
        });
        let d = tmp("dl");
        let f = d.join("app.new.exe");
        let mut seen = 0;
        let got = tauri::async_runtime::block_on(download(&format!("http://127.0.0.1:{port}/app.exe"), &f, |g, _| seen = g)).unwrap();
        assert_eq!(got, body.len() as u64);
        assert_eq!(seen, body.len() as u64);
        assert_eq!(fs::read(&f).unwrap(), body);
        let _ = fs::remove_dir_all(&d);
    }
}
