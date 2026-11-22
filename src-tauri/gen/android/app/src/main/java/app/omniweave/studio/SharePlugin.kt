// Omniweave (GPL-3.0-or-later) — "share" for the phone app: hands a finished file to the system share sheet
// (KakaoTalk, mail, Drive, Files…) through the FileProvider declared in AndroidManifest.xml.
// Also "capture" for scanning: the WebView ignores <input capture> and offers the photo picker, so the camera app is
// asked directly (ACTION_IMAGE_CAPTURE: no CAMERA permission needed, the photo goes to the app's cache folder).
// Registered from Rust (src-tauri/src/mobile.rs, register_android_plugin); docs/MOBILE_PLAN.md §3.5 T3.
package app.omniweave.studio

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class ShareArgs {
  lateinit var path: String
  var mime: String? = null
  var title: String? = null
}

@InvokeArg
class NameArgs {
  lateinit var uri: String
}

@InvokeArg
class CopyArgs {
  lateinit var path: String
  lateinit var uri: String
}

@InvokeArg
class SpellArgs {
  lateinit var lang: String
  var words: List<String> = listOf()
}

@InvokeArg
class PrintArgs {
  lateinit var path: String
  var title: String? = null
}

/** A finished PDF streamed to the print service as it is (the pages were laid out by Omniweave). */
class PdfFileAdapter(private val file: File, private val name: String) : android.print.PrintDocumentAdapter() {
  override fun onLayout(oldAttributes: android.print.PrintAttributes?, newAttributes: android.print.PrintAttributes?, cancellationSignal: android.os.CancellationSignal?, callback: LayoutResultCallback, extras: android.os.Bundle?) {
    if (cancellationSignal?.isCanceled == true) {
      callback.onLayoutCancelled()
      return
    }
    val info = android.print.PrintDocumentInfo.Builder(name).setContentType(android.print.PrintDocumentInfo.CONTENT_TYPE_DOCUMENT).build()
    callback.onLayoutFinished(info, true)
  }

  override fun onWrite(pages: Array<out android.print.PageRange>?, destination: android.os.ParcelFileDescriptor, cancellationSignal: android.os.CancellationSignal?, callback: WriteResultCallback) {
    try {
      file.inputStream().use { input -> java.io.FileOutputStream(destination.fileDescriptor).use { out -> input.copyTo(out, 1 shl 16) } }
      callback.onWriteFinished(arrayOf(android.print.PageRange.ALL_PAGES))
    } catch (e: Exception) {
      callback.onWriteFailed(e.message)
    }
  }
}

@TauriPlugin
class SharePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun share(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ShareArgs::class.java)
      val file = File(args.path)
      if (!file.isFile) {
        invoke.reject("no such file")
        return
      }
      val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", file)
      val send = Intent(Intent.ACTION_SEND).apply {
        type = args.mime ?: "application/octet-stream"
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_TITLE, file.name)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      val chooser = Intent.createChooser(send, args.title ?: file.name).apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      activity.startActivity(chooser)
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject(e.message ?: e.toString())
    }
  }

  /** Display name of a content:// URI another app handed over (a media id like …/file/18 has none in the URI). */
  @Command
  fun name(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(NameArgs::class.java)
      var name: String? = null
      activity.contentResolver.query(Uri.parse(args.uri), arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) name = c.getString(0)
      }
      val ret = app.tauri.plugin.JSObject()
      ret.put("name", name)
      invoke.resolve(ret)
    } catch (e: Exception) {
      invoke.reject(e.message ?: e.toString())
    }
  }

  /** "Save as copy": stream a staged file (cache/stage) into the document the user picked. */
  @Command
  fun copyTo(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(CopyArgs::class.java)
      val src = File(args.path)
      val stage = File(activity.cacheDir, "stage").canonicalFile
      if (!src.isFile || src.canonicalFile.parentFile != stage) {
        invoke.reject("not a staged file")
        return
      }
      val out = activity.contentResolver.openOutputStream(Uri.parse(args.uri), "wt")
      if (out == null) {
        invoke.reject("cannot write")
        return
      }
      out.use { o -> src.inputStream().use { it.copyTo(o, 1 shl 16) } }
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject(e.message ?: e.toString())
    }
  }

  /** Keep read access to a picked document after a restart (recent files). Fails quietly for providers that refuse. */
  @Command
  fun persist(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(NameArgs::class.java)
      val uri = Uri.parse(args.uri)
      // read and write when the picker gave both (the phone editor may save over the original), else read only
      try {
        activity.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      } catch (e: SecurityException) {
        activity.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject(e.message ?: e.toString())
    }
  }

  /** May this app write the document at a content:// URI (save over the original)? { write: Boolean } */
  @Command
  fun canWrite(invoke: Invoke) {
    val ret = app.tauri.plugin.JSObject()
    try {
      val args = invoke.parseArgs(NameArgs::class.java)
      val uri = Uri.parse(args.uri)
      val persisted = activity.contentResolver.persistedUriPermissions.any { it.uri == uri && it.isWritePermission }
      val granted = activity.checkUriPermission(uri, android.os.Process.myPid(), android.os.Process.myUid(), Intent.FLAG_GRANT_WRITE_URI_PERMISSION) == android.content.pm.PackageManager.PERMISSION_GRANTED
      ret.put("write", persisted || granted)
    } catch (e: Exception) {
      ret.put("write", false)
    }
    invoke.resolve(ret)
  }

  /** Print a staged PDF with the system print service (network printers, "Save as PDF"). The WebView has no
   *  window.print, so the PC program's 인쇄 makes its PDF and hands it over here. */
  @Command
  fun print(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(PrintArgs::class.java)
      val src = File(args.path)
      val stage = File(activity.cacheDir, "stage").canonicalFile
      if (!src.isFile || src.canonicalFile.parentFile != stage) {
        invoke.reject("not a staged file")
        return
      }
      val pm = activity.getSystemService(android.content.Context.PRINT_SERVICE) as android.print.PrintManager
      val name = args.title ?: src.name
      pm.print(name, PdfFileAdapter(src, name), android.print.PrintAttributes.Builder().build())
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject(e.message ?: e.toString())
    }
  }

  @Command
  fun spellCheck(invoke: Invoke) = spell(invoke, false)

  @Command
  fun spellSuggest(invoke: Invoke) = spell(invoke, true)

  /** Spelling with the phone's own spell checker (the keyboard's, Settings ▸ System ▸ Languages ▸ Spell checker):
   *  { bad: [Boolean] } per word, or { suggestions: [String] } for words[0]; { unsupported: true } without one. */
  private fun spell(invoke: Invoke, suggest: Boolean) {
    val args = try {
      invoke.parseArgs(SpellArgs::class.java)
    } catch (e: Exception) {
      invoke.reject(e.message ?: e.toString())
      return
    }
    val words = args.words
    activity.runOnUiThread {
      try {
        val tsm = activity.getSystemService(android.content.Context.TEXT_SERVICES_MANAGER_SERVICE) as android.view.textservice.TextServicesManager
        var session: android.view.textservice.SpellCheckerSession? = null
        val listener = object : android.view.textservice.SpellCheckerSession.SpellCheckerSessionListener {
          override fun onGetSuggestions(results: Array<out android.view.textservice.SuggestionsInfo>?) = answer((results ?: arrayOf()).toList())

          /** one sentence per word: its first (only) word's result */
          override fun onGetSentenceSuggestions(results: Array<out android.view.textservice.SentenceSuggestionsInfo>?) =
            answer((results ?: arrayOf()).map { if (it.suggestionsCount > 0) it.getSuggestionsInfoAt(0) else null })

          fun answer(infos: List<android.view.textservice.SuggestionsInfo?>) {
            val ret = app.tauri.plugin.JSObject()
            if (suggest) {
              val list = org.json.JSONArray()
              infos.firstOrNull()?.let { s -> for (i in 0 until s.suggestionsCount) list.put(s.getSuggestionAt(i)) }
              ret.put("suggestions", list)
            } else {
              val typo = android.view.textservice.SuggestionsInfo.RESULT_ATTR_LOOKS_LIKE_TYPO
              val bad = words.indices.map { i -> infos.getOrNull(i)?.let { (it.suggestionsAttributes and typo) != 0 } ?: false }
              // a checker without this language marks every word: say "no checker" instead of underlining all
              // a checker that answered nothing about any word (no dictionary for the language yet): same
              val silent = words.size >= 3 && infos.none { it != null && it.suggestionsAttributes != 0 }
              if (silent || (words.size >= 6 && bad.count { it } * 10 >= words.size * 9)) ret.put("unsupported", true)
              else ret.put("bad", org.json.JSONArray(bad))
            }
            session?.close()
            invoke.resolve(ret)
          }
        }
        session = tsm.newSpellCheckerSession(null, java.util.Locale.forLanguageTag(args.lang), listener, false)
        if (session == null || words.isEmpty()) {
          val ret = app.tauri.plugin.JSObject()
          if (session == null) ret.put("unsupported", true) else ret.put("bad", org.json.JSONArray())
          session?.close()
          invoke.resolve(ret)
          return@runOnUiThread
        }
        // (the sentence form: current spell checkers such as Gboard answer it; the old per-word form came back empty)
        session.getSentenceSuggestions(words.map { android.view.textservice.TextInfo(it) }.toTypedArray(), if (suggest) 8 else 1)
      } catch (e: Exception) {
        invoke.reject(e.message ?: e.toString())
      }
    }
  }

  private fun photoFile(): File = File(activity.cacheDir, "scan/photo.jpg")

  /** Take one photo with the camera app; resolves { path } (null when cancelled). */
  @Command
  fun capture(invoke: Invoke) {
    try {
      val f = photoFile()
      f.parentFile?.mkdirs()
      f.delete()
      val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", f)
      val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
        putExtra(MediaStore.EXTRA_OUTPUT, uri)
        addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      startActivityForResult(invoke, intent, "captureDone")
    } catch (e: Exception) {
      invoke.reject(e.message ?: e.toString())
    }
  }

  @ActivityCallback
  fun captureDone(invoke: Invoke, result: ActivityResult) {
    val f = photoFile()
    val ret = app.tauri.plugin.JSObject()
    ret.put("path", if (result.resultCode == Activity.RESULT_OK && f.isFile && f.length() > 0) f.absolutePath else null)
    invoke.resolve(ret)
  }
}
