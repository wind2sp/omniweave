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
