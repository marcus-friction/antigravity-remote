import ExpoModulesCore
import WebKit

public class RemoteSessionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RemoteSession")
    AsyncFunction("clearWebData") { (promise: Promise) in
      WKWebsiteDataStore.default().removeData(
        ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
        modifiedSince: Date(timeIntervalSince1970: 0)
      ) { promise.resolve(nil) }
    }.runOnQueue(.main)
  }
}
