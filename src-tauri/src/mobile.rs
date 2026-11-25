#![cfg_attr(not(mobile), allow(dead_code))]
//! Phone app (Android/iOS) only: the system share sheet (docs/MOBILE_PLAN.md §3.5 T3).
//! The UI hands over the finished file's bytes; they are written to the app's cache folder (covered by the
//! FileProvider paths in gen/android/app/src/main/res/xml/file_paths.xml) and given to the share sheet.

use tauri::{plugin::TauriPlugin, Manager, Runtime};

#[cfg(target_os = "android")]
struct Share<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[derive(serde::Serialize)]
struct ShareArgs {
    path: String,
    mime: String,
    title: Option<String>,
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::<R, ()>::new("omwshare")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin("app.omniweave.studio", "SharePlugin")?;
                _app.manage(Share(handle));
            }
            Ok(())
        })
        .build()
}

/// `%XX` → byte (header values are ASCII: the UI sends the file name through encodeURIComponent)
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Bytes sent through a JSON bridge: `[1,2,3]` or a typed array serialized as `{"0":1,"1":2,…}`
fn json_bytes(v: &serde_json::Value) -> Option<Vec<u8>> {
    match v {
        serde_json::Value::Array(a) => a.iter().map(|x| x.as_u64().and_then(|n| u8::try_from(n).ok())).collect(),
        serde_json::Value::Object(o) => {
            let mut out = vec![0u8; o.len()];
            for (k, x) in o {
                let i: usize = k.parse().ok()?;
                *out.get_mut(i)? = u8::try_from(x.as_u64()?).ok()?;
            }
            Some(out)
        }
        _ => None,
    }
}

/// A file name that stays inside the share folder
fn safe_name(name: &str) -> String {
    let n: String = name.chars().map(|c| if matches!(c, '/' | '\\' | ':' | '\0') { '_' } else { c }).collect();
    let n = n.trim().trim_start_matches('.').to_string();
    if n.is_empty() { "file".into() } else { n }
}

/// Share a finished file: raw body = bytes, headers x-name (percent-encoded) and x-mime.
#[tauri::command]
pub async fn share_bytes<R: Runtime>(app: tauri::AppHandle<R>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    // desktop and iOS pass the bytes as they are; Android's IPC bridge hands them over as a JSON array of numbers
    let bytes: Vec<u8> = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        tauri::ipc::InvokeBody::Json(v) => json_bytes(v).ok_or("share_bytes: bytes expected")?,
    };
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(percent_decode);
    let name = safe_name(&header("x-name").unwrap_or_else(|| "file".into()));
    let mime = header("x-mime").unwrap_or_else(|| "application/octet-stream".into());
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("share");
    // only the latest shared files are kept
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&name);
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    let _args = ShareArgs { path: path.to_string_lossy().into_owned(), mime, title: Some(name) };
    #[cfg(target_os = "android")]
    {
        let share = app.state::<Share<R>>();
        share.0.run_mobile_plugin::<()>("share", _args).map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "android"))]
    Err("share is not available on this platform yet".into())
}

#[derive(serde::Serialize)]
struct NameArgs {
    uri: String,
}
#[derive(serde::Deserialize)]
struct NameReply {
    name: Option<String>,
}

/// The display name of a content:// URI (Android's OpenableColumns.DISPLAY_NAME); None when the provider has none.
#[tauri::command]
pub async fn content_name<R: Runtime>(app: tauri::AppHandle<R>, uri: String) -> Option<String> {
    #[cfg(target_os = "android")]
    {
        let share = app.state::<Share<R>>();
        share.0.run_mobile_plugin::<NameReply>("name", NameArgs { uri }).ok().and_then(|r| r.name)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, NameArgs { uri }, |r: NameReply| r.name);
        None
    }
}

#[derive(serde::Deserialize)]
struct CaptureReply {
    path: Option<String>,
}

/// Scan: one photo from the camera app (Android), as JPEG bytes; empty when cancelled.
#[tauri::command]
pub async fn scan_photo<R: Runtime>(app: tauri::AppHandle<R>) -> Result<tauri::ipc::Response, String> {
    #[cfg(target_os = "android")]
    {
        let share = app.state::<Share<R>>();
        let reply: CaptureReply = share.0.run_mobile_plugin("capture", ()).map_err(|e| e.to_string())?;
        let bytes = match reply.path {
            Some(p) => {
                let b = std::fs::read(&p).map_err(|e| e.to_string())?;
                let _ = std::fs::remove_file(&p);
                b
            }
            None => Vec::new(),
        };
        Ok(tauri::ipc::Response::new(bytes))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, |r: CaptureReply| r.path);
        Err("the camera is not available on this platform yet".into())
    }
}

/// Standard base64 (with or without padding) → bytes; None on a character outside the alphabet.
fn b64_decode(s: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    }
    let b: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace() && *c != b'=').collect();
    let mut out = Vec::with_capacity(b.len() * 3 / 4);
    for chunk in b.chunks(4) {
        if chunk.len() == 1 {
            return None;
        }
        let mut n = 0u32;
        for (i, c) in chunk.iter().enumerate() {
            n |= val(*c)? << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

/// The phone app's staging folder (inside the cache, covered by the FileProvider): files on their way to the share
/// sheet or to a document the user picked.
fn stage_dir<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join("stage"))
}

/// Write a finished file into the staging folder in pieces (base64 text, a few MB each): Android's IPC bridge sends
/// a byte array as a JSON array of numbers — several times the size and slow to parse — while a string goes through
/// as it is. `first` starts the file (and clears files staged earlier); returns the file's path.
#[tauri::command]
pub async fn stage_put<R: Runtime>(app: tauri::AppHandle<R>, name: String, data: String, first: bool) -> Result<String, String> {
    use std::io::Write;
    let dir = stage_dir(&app)?;
    if first {
        let _ = std::fs::remove_dir_all(&dir);
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(safe_name(&name));
    let bytes = b64_decode(&data).ok_or("stage_put: base64 expected")?;
    let mut f = if first { std::fs::File::create(&path) } else { std::fs::OpenOptions::new().append(true).open(&path) }.map_err(|e| e.to_string())?;
    f.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Only files in the staging folder may be shared or copied out.
fn staged<R: Runtime>(app: &tauri::AppHandle<R>, path: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::PathBuf::from(path);
    let dir = stage_dir(app)?;
    if p.parent() != Some(dir.as_path()) || !p.is_file() {
        return Err("not a staged file".into());
    }
    Ok(p)
}

/// Hand a staged file to the system share sheet.
#[tauri::command]
pub async fn share_staged<R: Runtime>(app: tauri::AppHandle<R>, path: String, mime: String) -> Result<(), String> {
    let p = staged(&app, &path)?;
    let _args = ShareArgs { title: p.file_name().map(|n| n.to_string_lossy().into_owned()), path: p.to_string_lossy().into_owned(), mime };
    #[cfg(target_os = "android")]
    {
        app.state::<Share<R>>().0.run_mobile_plugin::<()>("share", _args).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    Err("share is not available on this platform yet".into())
}

#[derive(serde::Serialize)]
struct CopyArgs {
    path: String,
    uri: String,
}

/// "Save as copy": copy a staged file into the document the user picked (ACTION_CREATE_DOCUMENT → content:// URI),
/// streamed by Android's ContentResolver.
#[tauri::command]
pub async fn save_staged<R: Runtime>(app: tauri::AppHandle<R>, path: String, uri: String) -> Result<(), String> {
    let p = staged(&app, &path)?;
    let _args = CopyArgs { path: p.to_string_lossy().into_owned(), uri };
    #[cfg(target_os = "android")]
    {
        app.state::<Share<R>>().0.run_mobile_plugin::<()>("copyTo", _args).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    Err("not available on this platform".into())
}

#[derive(serde::Serialize)]
struct PrintArgs {
    path: String,
    title: String,
}

/// Print a staged PDF with Android's print service (printers on the network, "Save as PDF"): the WebView has no
/// window.print, so the PC program's 인쇄 hands its finished PDF here (io/print.ts printPdfBytes).
#[tauri::command]
pub async fn print_staged<R: Runtime>(app: tauri::AppHandle<R>, path: String, title: String) -> Result<(), String> {
    let p = staged(&app, &path)?;
    let _args = PrintArgs { path: p.to_string_lossy().into_owned(), title };
    #[cfg(target_os = "android")]
    {
        app.state::<Share<R>>().0.run_mobile_plugin::<()>("print", _args).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    Err("not available on this platform".into())
}

#[derive(serde::Serialize)]
struct SpellArgs {
    lang: String,
    words: Vec<String>,
}

#[derive(serde::Deserialize, Default)]
struct SpellReply {
    bad: Option<Vec<bool>>,
    suggestions: Option<Vec<String>>,
    unsupported: Option<bool>,
}

/// Spelling on the phone (src/spell.rs's commands on Android): the system spell checker — the keyboard's — asked by
/// SharePlugin.kt. "spellCheck" → one misspelled-or-not per word; "spellSuggest" → suggestions for words[0];
/// Err("unsupported") when the phone has no checker for `lang` (the editor then says so, as on Windows).
pub fn spell_android<R: Runtime>(app: &tauri::AppHandle<R>, cmd: &str, lang: String, words: Vec<String>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        let r: SpellReply = app.state::<Share<R>>().0.run_mobile_plugin(cmd, SpellArgs { lang, words }).map_err(|e| e.to_string())?;
        if r.unsupported == Some(true) {
            return Err("unsupported".into());
        }
        Ok(if cmd == "spellCheck" { serde_json::json!(r.bad.unwrap_or_default()) } else { serde_json::json!(r.suggestions.unwrap_or_default()) })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, cmd, SpellArgs { lang, words }, SpellReply::default().bad);
        Err("unavailable".into())
    }
}

#[derive(serde::Serialize)]
struct PresentArgs {
    on: bool,
}

/// A slide show on the phone: the screen turned sideways and the system bars hidden (on), or back as before (off).
#[tauri::command]
pub async fn present_mode<R: Runtime>(app: tauri::AppHandle<R>, on: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        app.state::<Share<R>>().0.run_mobile_plugin::<()>("present", PresentArgs { on }).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, PresentArgs { on });
        Ok(())
    }
}

/// Keep read access to a picked document across restarts (recent files); false when the provider does not allow it.
#[tauri::command]
pub async fn persist_uri<R: Runtime>(app: tauri::AppHandle<R>, uri: String) -> bool {
    #[cfg(target_os = "android")]
    {
        app.state::<Share<R>>().0.run_mobile_plugin::<()>("persist", NameArgs { uri }).is_ok()
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, uri);
        false
    }
}

#[derive(serde::Deserialize)]
struct WriteReply {
    write: bool,
}

/// May the app write the picked document at `uri` (the phone editor's "save over the original")? false elsewhere.
#[tauri::command]
pub async fn can_write_uri<R: Runtime>(app: tauri::AppHandle<R>, uri: String) -> bool {
    if !uri.starts_with("content://") {
        return false;
    }
    #[cfg(target_os = "android")]
    {
        app.state::<Share<R>>().0.run_mobile_plugin::<WriteReply>("canWrite", NameArgs { uri }).map(|r| r.write).unwrap_or(false)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, |r: WriteReply| r.write);
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn base64() {
        assert_eq!(b64_decode("JVBERg==").as_deref(), Some(&b"%PDF"[..]));
        assert_eq!(b64_decode("JVBERi0").as_deref(), Some(&b"%PDF-"[..]));
        assert_eq!(b64_decode("").as_deref(), Some(&b""[..]));
        assert_eq!(b64_decode("A"), None);
        assert_eq!(b64_decode("@@@@"), None);
    }
    #[test]
    fn names() {
        assert_eq!(percent_decode("%EA%B3%84%EC%95%BD%EC%84%9C.pdf"), "계약서.pdf");
        assert_eq!(percent_decode("a%2"), "a%2");
        assert_eq!(safe_name("../x/y.pdf"), "_x_y.pdf");
        assert_eq!(safe_name(""), "file");
        assert_eq!(json_bytes(&serde_json::json!([37, 80, 68, 70])), Some(b"%PDF".to_vec()));
        assert_eq!(json_bytes(&serde_json::json!({"1": 80, "0": 37})), Some(b"%P".to_vec()));
        assert_eq!(json_bytes(&serde_json::json!([300])), None);
    }
}
