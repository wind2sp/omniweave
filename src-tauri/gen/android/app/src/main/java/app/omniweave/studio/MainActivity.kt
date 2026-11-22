package app.omniweave.studio

import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // status / navigation bar icons follow the system's light or dark theme (the page follows it too: mobile.css)
    enableEdgeToEdge(SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT), SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT))
    super.onCreate(savedInstanceState)
    // Omniweave: keep the page out of the status bar, the gesture bar and the keyboard. The system WebView does not
    // report env(safe-area-inset-*) on every Android version, so the content view is inset here instead.
    val root = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    // the system font size (Settings ▸ Display ▸ Font size) scales the page's text, as in other apps
    webView.settings.textZoom = Math.round(resources.configuration.fontScale * 100f)
  }
}
