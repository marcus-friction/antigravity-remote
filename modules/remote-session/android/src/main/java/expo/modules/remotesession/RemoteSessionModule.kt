package expo.modules.remotesession

import android.webkit.WebStorage
import android.webkit.WebView
import androidx.webkit.WebStorageCompat
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class RemoteSessionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RemoteSession")
    AsyncFunction("clearWebData") { promise: Promise ->
      try {
        val context = appContext.reactContext ?: throw IllegalStateException("Application unavailable")
        WebView(context).apply { clearCache(true); destroy() }
        val storage = WebStorage.getInstance()
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)) {
          WebStorageCompat.deleteBrowsingData(storage) { promise.resolve(null) }
        } else {
          // Legacy WebViews expose no completion callback for DOM storage removal.
          storage.deleteAllData()
          promise.resolve(null)
        }
      } catch (error: Exception) {
        promise.reject("ERR_WEB_DATA_CLEANUP", "Unable to clear website data", error)
      }
    }.runOnQueue(Queues.MAIN)
  }
}
