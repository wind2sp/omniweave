use std::path::PathBuf;

#[cfg(any(mobile, test))]
mod mobile;
#[cfg(desktop)]
mod portable;
mod spell;

/// The files on the command line: a double-click or "Open with" (`"<exe>" "%1"`), files dropped on the exe, or a
/// CLI call. Windows already split the line (quotes, spaces, Korean names: args_os is exact UTF-16). Flags (`--x`)
/// are skipped, relative paths are made absolute against `cwd`, a stray pair of quotes is dropped, each file once,
/// in order. When no single argument is a file, all of them joined by spaces are tried as one path: a launcher
/// that left `%1` unquoted splits "C:\My Files\a.pdf" in two.
fn launch_paths(args: &[std::ffi::OsString], cwd: Option<&std::path::Path>, is_file: impl Fn(&std::path::Path) -> bool) -> Vec<PathBuf> {
    let abs = |s: &str| {
        let p = PathBuf::from(s.trim().trim_matches('"'));
        match cwd {
            Some(c) if p.is_relative() => c.join(p),
            _ => p,
        }
    };
    let words: Vec<String> = args.iter().map(|a| a.to_string_lossy().into_owned()).filter(|a| !a.starts_with("--") && !a.trim().is_empty()).collect();
    let mut out: Vec<PathBuf> = Vec::new();
    for w in &words {
        let p = abs(w);
        if is_file(&p) && !out.contains(&p) {
            out.push(p);
        }
    }
    if out.is_empty() && words.len() > 1 {
        let p = abs(&words.join(" "));
        if is_file(&p) {
            out.push(p);
        }
    }
    out
}

fn startup_paths() -> Vec<PathBuf> {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    launch_paths(&args, std::env::current_dir().ok().as_deref(), |p| p.is_file())
}

/// The files the app was launched with (file association, "Open with", files dropped on the exe, CLI), in order.
/// The window opens each in its own tab (ui/actions.ts openStartupFile).
#[tauri::command]
fn startup_files() -> Vec<String> {
    startup_paths().iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

/// Bytes of launch file `index` (default the first). Read here (not through the fs plugin scope) because the user
/// chose it by double-clicking; only the launch files can be read this way.
#[tauri::command]
fn startup_bytes(index: Option<usize>) -> Result<tauri::ipc::Response, String> {
    let p = startup_paths().into_iter().nth(index.unwrap_or(0)).ok_or("no startup file")?;
    std::fs::read(&p).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// Self-test (`omniweave.exe --selftest`): the app icon and frontend assets must be embedded.
fn selftest<R: tauri::Runtime>(ctx: &tauri::Context<R>) -> i32 {
    let icon = ctx.default_window_icon().map(|i| (i.width(), i.height()));
    let keys: Vec<String> = ctx.assets().iter().map(|(k, _)| k.to_string()).collect();
    let index = keys.iter().any(|k| k.trim_start_matches('/') == "index.html");
    println!("omniweave selftest: icon={:?} index.html={} assets={}", icon, index, keys.len());
    if icon.is_some() && index { 0 } else { 1 }
}

/// Portable copy = no NSIS uninstaller next to the exe. Portable builds are told about
/// updates but never self-install (that would create a second, installed copy).
#[tauri::command]
fn is_portable() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| !d.join("uninstall.exe").exists()))
        .unwrap_or(true)
}

/// Running from an MSIX package (the Microsoft Store build, packaging/msix): the process has a package identity.
/// The Store installs and updates that build, so the app's own updater stays off there (no checks, no pill, no
/// "Check for updates" menu item). GetCurrentPackageFullName answers APPMODEL_ERROR_NO_PACKAGE (15700) for an
/// unpackaged process and ERROR_INSUFFICIENT_BUFFER (122) for a packaged one when asked for the length only.
/// A process started by another packaged app (an assistant or file manager installed from the Store) can carry that
/// app's identity, so the exe must also lie inside the package's own folder (GetCurrentPackagePath): an installed
/// or portable copy started that way keeps its updater.
#[cfg(windows)]
fn store_package() -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentPackageFullName(length: *mut u32, name: *mut u16) -> i32;
        fn GetCurrentPackagePath(length: *mut u32, path: *mut u16) -> i32;
    }
    let mut len: u32 = 0;
    // SAFETY: a null buffer with length 0 is the documented way to ask only for the length
    let rc = unsafe { GetCurrentPackageFullName(&mut len, std::ptr::null_mut()) };
    if !package_rc_means_packaged(rc) {
        return false;
    }
    let mut len: u32 = 0;
    // SAFETY: as above; then a buffer of exactly the length it reported
    if unsafe { GetCurrentPackagePath(&mut len, std::ptr::null_mut()) } != 122 || len == 0 {
        return false;
    }
    let mut buf = vec![0u16; len as usize];
    if unsafe { GetCurrentPackagePath(&mut len, buf.as_mut_ptr()) } != 0 {
        return false;
    }
    let root = String::from_utf16_lossy(&buf[..buf.iter().position(|&c| c == 0).unwrap_or(buf.len())]);
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    exe_inside(&exe, &root)
}
/// `exe` lies in the folder `root` (Windows paths: case-insensitive, either slash, an optional \\?\ prefix)
#[cfg_attr(not(windows), allow(dead_code))]
fn exe_inside(exe: &str, root: &str) -> bool {
    let norm = |s: &str| s.trim_start_matches(r"\\?\").replace('/', "\\").trim_end_matches('\\').to_lowercase();
    let (exe, root) = (norm(exe), norm(root));
    !root.is_empty() && exe.len() > root.len() && exe.starts_with(&root) && exe.as_bytes()[root.len()] == b'\\'
}
#[cfg(not(windows))]
fn store_package() -> bool {
    false
}
/// 0 or ERROR_INSUFFICIENT_BUFFER: there is a package identity; APPMODEL_ERROR_NO_PACKAGE (and anything else): none
#[cfg_attr(not(windows), allow(dead_code))]
fn package_rc_means_packaged(rc: i32) -> bool {
    rc == 0 || rc == 122
}

#[tauri::command]
fn is_store_package() -> bool {
    store_package()
}

/// UI language picked in the installer ("ko" / "en" / "zh" / "ja"), written next to the exe by the NSIS hook
/// (windows/installer-hooks.nsh). None for portable copies; the app then follows the OS language.
#[tauri::command]
fn installer_language() -> Option<String> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let lang = std::fs::read_to_string(dir.join("language.txt")).ok()?.trim().to_string();
    matches!(lang.as_str(), "ko" | "en" | "zh" | "ja").then_some(lang)
}

/// One line of the UI's update flow (check, download, install, errors) appended to %TEMP%/omniweave-update.log,
/// so a failed or silent update can be diagnosed after the fact (the startup check shows nothing on failure).
#[tauri::command]
fn update_log(app: tauri::AppHandle, line: String) {
    use std::io::Write;
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(std::env::temp_dir().join("omniweave-update.log")) {
        let _ = writeln!(f, "{secs} v{} {line}", app.package_info().version);
    }
}

/// Why an update check could not even start, for the update log: the updater resolves the app's path once at
/// process start (tauri `current_exe`, canonicalized) and fails every check of that process with that error. Seen
/// when the app was started outside the file-system view it was installed in (an install run from a packaged app
/// such as Claude Desktop lands in its private %LOCALAPPDATA% copy; the installer's RunAsUser relaunch then starts
/// the app outside that copy). See docs/RELEASING.md "업데이트 확인 실패".
#[tauri::command]
fn update_diag() -> String {
    let exe = std::env::current_exe();
    let canon = exe.as_ref().map(|p| p.canonicalize().map(|_| ()));
    match tauri::utils::platform::current_exe() {
        Ok(_) => "app path ok".to_string(),
        Err(e) => format!("app path unavailable since start: {e} (exe {exe:?}, canonicalize now {canon:?})"),
    }
}

/// `omniweave.exe --update-test`: the UI checks at once and installs a found update without a click (QA of the
/// whole check → download → install → relaunch path; see update_log).
/// The environment variable OMW_UPDATE_QA=1 does the same and also moves the window out of sight; unlike the argument it is passed
/// on through a portable swap (`--finish-update` → restart), so a QA run can follow both versions without a window.
/// It is honoured only by debug builds and by test builds with their own identifier (scripts/portable-update-e2e.ps1 uses
/// app.omniweave.updatetest), never by the released app: a stray variable must not hide its window or update it unasked.
#[tauri::command]
fn update_test_mode(app: tauri::AppHandle) -> bool {
    std::env::args().any(|a| a == "--update-test") || update_qa_env(&app.config().identifier)
}

/// The identifier of the released app (tauri.conf.json); OMW_UPDATE_QA does nothing there.
const RELEASE_IDENTIFIER: &str = "app.omniweave.studio";

fn update_qa_env(identifier: &str) -> bool {
    update_qa_allowed(cfg!(debug_assertions), identifier) && std::env::var("OMW_UPDATE_QA").map(|v| v == "1").unwrap_or(false)
}

fn update_qa_allowed(debug: bool, identifier: &str) -> bool {
    debug || identifier != RELEASE_IDENTIFIER
}

/// Updater self-check (`omniweave.exe --update-check`): asks the configured update endpoint exactly like the app
/// does and writes what it saw (current version, remote version, decision or error) to
/// %TEMP%/omniweave-update-check.txt, then exits. Lets QA test the update channel without clicking the UI.
#[cfg(desktop)]
fn update_check(app: &tauri::AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    if store_package() {
        let line = format!("store package: updates come from the Microsoft Store | app={}\n", app.package_info().version);
        let _ = std::fs::write(std::env::temp_dir().join("omniweave-update-check.txt"), line);
        app.exit(0);
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let seen2 = seen.clone();
        let result = match handle
            .updater_builder()
            .version_comparator(move |current, remote| {
                *seen2.lock().unwrap() = format!("current={current} remote={}", remote.version);
                remote.version > current
            })
            .build()
        {
            Ok(u) => match u.check().await {
                Ok(Some(up)) => format!("available version={} date={:?}", up.version, up.date),
                Ok(None) => "no update".to_string(),
                Err(e) => format!("error: {e}"),
            },
            Err(e) => format!("builder error: {e} [{}]", update_diag()),
        };
        let line = format!("{} | {} | app={}{}", result, seen.lock().unwrap(), handle.package_info().version, "
");
        let _ = std::fs::write(std::env::temp_dir().join("omniweave-update-check.txt"), line);
        handle.exit(0);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_identity_answers() {
        assert!(package_rc_means_packaged(122)); // ERROR_INSUFFICIENT_BUFFER: packaged, length returned
        assert!(package_rc_means_packaged(0));
        assert!(!package_rc_means_packaged(15700)); // APPMODEL_ERROR_NO_PACKAGE
        assert!(!package_rc_means_packaged(87));
    }

    #[test]
    fn exe_must_be_inside_the_package_folder() {
        let root = r"C:\Program Files\WindowsApps\NinerowPartners.Omniweave_0.2.0.0_x64__abc";
        assert!(exe_inside(&format!(r"{root}\Omniweave\omniweave.exe"), root));
        assert!(exe_inside(&format!(r"\\?\{}\Omniweave\omniweave.exe", root.to_uppercase()), &format!("{root}\\")));
        // the installed copy started by another packaged app: that app's folder, not ours
        assert!(!exe_inside(r"C:\Users\u\AppData\Local\Omniweave\omniweave.exe", root));
        assert!(!exe_inside(&format!("{root}2\\omniweave.exe"), root));
        assert!(!exe_inside(r"C:\x\omniweave.exe", ""));
    }
    #[test]
    fn update_qa_env_is_for_test_builds_only() {
        assert!(!update_qa_allowed(false, RELEASE_IDENTIFIER)); // the released app ignores OMW_UPDATE_QA
        assert!(update_qa_allowed(false, "app.omniweave.updatetest")); // scripts/portable-update-e2e.ps1 builds
        assert!(update_qa_allowed(true, RELEASE_IDENTIFIER)); // debug builds
        let conf = include_str!("../tauri.conf.json");
        assert!(conf.contains(&format!("\"identifier\": \"{RELEASE_IDENTIFIER}\"")), "RELEASE_IDENTIFIER must match tauri.conf.json");
    }
    #[test]
    fn launch_arguments_become_files() {
        use std::ffi::OsString;
        use std::path::Path;
        let cwd = Path::new(r"C:\Users\u\Desktop");
        let files = [r"C:\Users\u\Desktop\보고서 최종.hwpx", r"C:\My Files\a.pdf", r"D:\b.docx", r"C:\Users\u\Desktop\rel.pptx"];
        let is_file = |p: &Path| files.iter().any(|f| Path::new(f) == p);
        let os = |v: &[&str]| v.iter().map(OsString::from).collect::<Vec<_>>();
        let want = |i: &[usize]| i.iter().map(|&i| PathBuf::from(files[i])).collect::<Vec<_>>();
        // "Open with" / double-click: one quoted path, unquoted by Windows; spaces and Korean kept
        assert_eq!(launch_paths(&os(&[files[0]]), Some(cwd), is_file), want(&[0]));
        // several files dropped on the exe: all, in order, each once; flags and missing files skipped
        let got = launch_paths(&os(&["--update-check", r"D:\b.docx", r"C:\nope.pdf", r"C:\My Files\a.pdf", r"D:\b.docx"]), Some(cwd), is_file);
        assert_eq!(got, want(&[2, 1]));
        // a relative CLI path, and a stray pair of quotes
        assert_eq!(launch_paths(&os(&["rel.pptx"]), Some(cwd), is_file), want(&[3]));
        assert_eq!(launch_paths(&os(&["\"D:\\b.docx\""]), Some(cwd), is_file), want(&[2]));
        // an unquoted %1 split at the space
        assert_eq!(launch_paths(&os(&[r"C:\My", r"Files\a.pdf"]), Some(cwd), is_file), want(&[1]));
        // nothing to open
        assert!(launch_paths(&os(&[]), Some(cwd), is_file).is_empty());
        assert!(launch_paths(&os(&["--selftest", ""]), Some(cwd), is_file).is_empty());
    }
    // (no test of store_package() itself: a process started by a packaged app — an IDE or assistant installed from
    // the Store — runs with that app's package identity, so the answer depends on who started the tests)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // portable self-update, before anything else (no window, no plugins): the downloaded `<name>.new.exe` puts
    // itself in place of the old exe and starts it (src/portable.rs)
    let args: Vec<String> = std::env::args().collect();
    #[cfg(desktop)]
    if args.iter().any(|a| a == "--finish-update") {
        std::process::exit(portable::finish_update(&args));
    }
    let ctx = tauri::generate_context!();
    if args.iter().any(|a| a == "--selftest") {
        std::process::exit(selftest(&ctx));
    }
    // leftovers of a finished portable update (`.new.exe`, `.exe.old`); the old process may still be closing
    #[cfg(desktop)]
    if let Ok(exe) = std::env::current_exe() {
        std::thread::spawn(move || {
            if is_portable() && !store_package() {
                for p in portable::cleanup_leftovers(&exe, 20, std::time::Duration::from_millis(500)) {
                    portable::log(&format!("removed {}", p.display()));
                }
            }
        });
    }
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init());
    #[cfg(mobile)]
    let builder = builder.plugin(mobile::init());
    // desktop: the app's own updater, restart, portable self-update; on Android/iOS the store updates the app
    // (docs/MOBILE_PLAN.md §3.2), so those plugins and commands are not built there
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![startup_files, startup_bytes, is_portable, is_store_package, installer_language, update_log, update_diag, update_test_mode, portable::portable_update_download, portable::portable_update_finish, spell::spell_languages, spell::spell_check, spell::spell_suggest, spell::spell_add, spell::spell_ignore]);
    #[cfg(mobile)]
    let builder = builder.manage(OpenedFiles::default()).invoke_handler(tauri::generate_handler![opened_files, mobile::share_bytes, mobile::content_name, mobile::scan_photo, mobile::stage_put, mobile::share_staged, mobile::save_staged, mobile::print_staged, mobile::present_mode, mobile::persist_uri, mobile::can_write_uri, startup_files, startup_bytes, is_portable, is_store_package, installer_language, update_log, update_diag, update_test_mode, spell::spell_languages, spell::spell_check, spell::spell_suggest, spell::spell_add, spell::spell_ignore]);
    builder
        .setup(|app| {
            #[cfg(desktop)]
            desktop_setup(app);
            #[cfg(mobile)]
            let _ = app;
            Ok(())
        })
        .build(ctx)
        .expect("error while running Omniweave")
        .run(|_app, _event| {
            // Android/iOS: a file shared to the app or opened with it ("Open with", ACTION_VIEW / ACTION_SEND, iOS
            // "Open in") arrives here, also at a cold start; the phone shell asks for it (opened_files) and is told
            // when more come (event "opened-files")
            #[cfg(mobile)]
            if let tauri::RunEvent::Opened { urls } = _event {
                use tauri::{Emitter, Manager};
                let list: Vec<String> = urls.iter().map(|u| u.to_string()).collect();
                _app.state::<OpenedFiles>().0.lock().unwrap().extend(list.iter().cloned());
                let _ = _app.emit("opened-files", list);
            }
        });
}

/// Files handed to the mobile app by other apps, not yet taken by the UI (content:// or file:// URLs).
#[cfg(mobile)]
#[derive(Default)]
struct OpenedFiles(std::sync::Mutex<Vec<String>>);

/// The files other apps handed over since the last call (the phone shell opens each); empty on desktop.
#[cfg(mobile)]
#[tauri::command]
fn opened_files(state: tauri::State<OpenedFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

/// Desktop-only start-up: the QA window placement and the `--update-check` self-check.
#[cfg(desktop)]
fn desktop_setup(app: &mut tauri::App) {
    use tauri::Manager;
    if update_qa_env(&app.config().identifier) {
        // QA run: out of sight but not hidden (a hidden WebView2 may hold its page back)
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.set_skip_taskbar(true);
            let _ = w.set_position(tauri::PhysicalPosition::new(-30000, -30000));
        }
    }
    if std::env::args().any(|a| a == "--update-check") {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide();
        }
        update_check(app.handle());
    }
}
