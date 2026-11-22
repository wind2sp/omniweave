//! Spelling (맞춤법 검사) through the Windows Spell Checking API (ISpellCheckerFactory / ISpellChecker, Windows 8+).
//! No dictionaries ship with Omniweave: Windows checks with the language packs the user has installed, and the
//! user dictionary is Windows' own (ISpellChecker::Add writes to %AppData%\Microsoft\Spelling\<lang>\default.dic,
//! shared with every app that uses the API). docs/design/WORD_HWP_FEATURES.md (맞춤법).
//!
//! All COM calls run on one worker thread (its own MTA apartment); the commands are async and wait for the worker on
//! a blocking thread, so the UI thread is never held.

#[cfg(windows)]
mod imp {
    use std::collections::HashMap;
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Mutex, OnceLock};
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Globalization::{ISpellChecker, ISpellCheckerFactory, ISpellingError, SpellCheckerFactory};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, IEnumString, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};

    pub enum Job {
        Languages,
        Check(String, Vec<String>),
        Suggest(String, String),
        Add(String, String),
        Ignore(String, String),
    }
    pub type Reply = Result<serde_json::Value, String>;

    static WORKER: OnceLock<Mutex<Sender<(Job, Sender<Reply>)>>> = OnceLock::new();

    fn strings(e: &IEnumString) -> Vec<String> {
        let mut out = Vec::new();
        loop {
            let mut buf = [PWSTR::null()];
            let mut got = 0u32;
            let hr = unsafe { e.Next(&mut buf, Some(&mut got)) };
            if hr.is_err() || got == 0 {
                break;
            }
            unsafe {
                out.push(buf[0].to_string().unwrap_or_default());
                CoTaskMemFree(Some(buf[0].0 as *const _));
            }
        }
        out
    }

    struct State {
        factory: Option<ISpellCheckerFactory>,
        checkers: HashMap<String, Option<ISpellChecker>>,
    }

    impl State {
        fn checker(&mut self, lang: &str) -> Result<ISpellChecker, String> {
            let f = self.factory.as_ref().ok_or("no spell checker factory")?.clone();
            let c = self.checkers.entry(lang.to_string()).or_insert_with(|| unsafe {
                let tag = HSTRING::from(lang);
                match f.IsSupported(&tag) {
                    Ok(b) if b.as_bool() => f.CreateSpellChecker(&tag).ok(),
                    _ => None,
                }
            });
            c.clone().ok_or_else(|| "unsupported".to_string())
        }

        fn run(&mut self, job: Job) -> Reply {
            match job {
                Job::Languages => {
                    let f = self.factory.as_ref().ok_or("no spell checker factory")?;
                    let e = unsafe { f.SupportedLanguages() }.map_err(|e| e.to_string())?;
                    Ok(serde_json::json!(strings(&e)))
                }
                Job::Check(lang, words) => {
                    let c = self.checker(&lang)?;
                    let bad: Vec<bool> = words
                        .iter()
                        .map(|w| unsafe {
                            // any error (an unknown word, or an autocorrect pair the user set up) marks the word
                            let Ok(errs) = c.Check(&HSTRING::from(w.as_str())) else { return false };
                            let mut e: Option<ISpellingError> = None;
                            let _ = errs.Next(&mut e);
                            e.is_some()
                        })
                        .collect();
                    Ok(serde_json::json!(bad))
                }
                Job::Suggest(lang, word) => {
                    let c = self.checker(&lang)?;
                    let e = unsafe { c.Suggest(&HSTRING::from(word.as_str())) }.map_err(|e| e.to_string())?;
                    Ok(serde_json::json!(strings(&e).into_iter().take(8).collect::<Vec<_>>()))
                }
                Job::Add(lang, word) => {
                    let c = self.checker(&lang)?;
                    unsafe { c.Add(&HSTRING::from(word.as_str())) }.map_err(|e| e.to_string())?;
                    Ok(serde_json::Value::Null)
                }
                Job::Ignore(lang, word) => {
                    let c = self.checker(&lang)?;
                    unsafe { c.Ignore(&HSTRING::from(word.as_str())) }.map_err(|e| e.to_string())?;
                    Ok(serde_json::Value::Null)
                }
            }
        }
    }

    fn worker() -> Sender<(Job, Sender<Reply>)> {
        WORKER
            .get_or_init(|| {
                let (tx, rx) = channel::<(Job, Sender<Reply>)>();
                std::thread::Builder::new()
                    .name("omniweave-spell".into())
                    .spawn(move || {
                        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
                        let factory: Option<ISpellCheckerFactory> = unsafe { CoCreateInstance(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER) }.ok();
                        let mut st = State { factory, checkers: HashMap::new() };
                        for (job, reply) in rx {
                            let _ = reply.send(st.run(job));
                        }
                    })
                    .expect("spell worker");
                Mutex::new(tx)
            })
            .lock()
            .unwrap()
            .clone()
    }

    pub fn call(job: Job) -> Reply {
        let (tx, rx) = channel();
        worker().send((job, tx)).map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())?
    }
}

#[cfg(not(windows))]
mod imp {
    pub enum Job {
        Languages,
        Check(String, Vec<String>),
        Suggest(String, String),
        Add(String, String),
        Ignore(String, String),
    }
    pub fn call(_job: Job) -> Result<serde_json::Value, String> {
        Err("unavailable".into())
    }
}

use imp::Job;

async fn run(job: Job) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || imp::call(job)).await.map_err(|e| e.to_string())?
}

/// BCP-47 tags Windows can check (installed language packs / spelling features).
#[tauri::command]
pub async fn spell_languages() -> Result<serde_json::Value, String> {
    run(Job::Languages).await
}

/// For each word: true = misspelled. Err("unsupported") when Windows has no checker for `lang`.
#[tauri::command]
pub async fn spell_check<R: tauri::Runtime>(app: tauri::AppHandle<R>, lang: String, words: Vec<String>) -> Result<serde_json::Value, String> {
    // the phone app: Android's own spell checker (the keyboard's), through SharePlugin.kt
    #[cfg(target_os = "android")]
    return crate::mobile::spell_android(&app, "spellCheck", lang, words);
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        run(Job::Check(lang, words)).await
    }
}

/// Up to 8 suggestions for a misspelled word.
#[tauri::command]
pub async fn spell_suggest<R: tauri::Runtime>(app: tauri::AppHandle<R>, lang: String, word: String) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    return crate::mobile::spell_android(&app, "spellSuggest", lang, vec![word]);
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        run(Job::Suggest(lang, word)).await
    }
}

/// Add to the user's Windows dictionary for `lang` (사전에 추가).
#[tauri::command]
pub async fn spell_add(lang: String, word: String) -> Result<serde_json::Value, String> {
    run(Job::Add(lang, word)).await
}

/// Ignore the word for the rest of this session (모두 무시).
#[tauri::command]
pub async fn spell_ignore(lang: String, word: String) -> Result<serde_json::Value, String> {
    run(Job::Ignore(lang, word)).await
}

#[cfg(all(test, windows))]
mod tests {
    use super::imp::{call, Job};

    /// `cargo test --lib spell -- --nocapture`: what this PC's Windows can check.
    #[test]
    fn spell_api() {
        let langs = call(Job::Languages).expect("languages");
        println!("languages: {langs}");
        for (lang, words) in [("en-US", vec!["hello", "helo", "teh"]), ("ko-KR", vec!["안녕하세요", "안녕하새요"])] {
            println!("{lang}: {:?}", call(Job::Check(lang.into(), words.into_iter().map(String::from).collect())));
        }
        println!("suggest helo: {:?}", call(Job::Suggest("en-US".into(), "helo".into())));
    }
}
