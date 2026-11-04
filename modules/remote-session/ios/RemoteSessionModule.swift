import ExpoModulesCore
import UIKit
import WebKit

public class RemoteSessionModule: Module {
  private var keepAliveEnabled: Bool = true
  private var keepAliveMinutes: Int = 30
  private var sessionActive: Bool = false
  private var backgroundTaskId: UIBackgroundTaskIdentifier = .invalid

  private func runOnMain(_ block: @escaping () -> Void) {
    if Thread.isMainThread {
      block()
    } else {
      DispatchQueue.main.async(execute: block)
    }
  }

  private func endBackgroundKeepAliveTask() {
    if backgroundTaskId != .invalid {
      let taskToEnd = backgroundTaskId
      backgroundTaskId = .invalid
      UIApplication.shared.endBackgroundTask(taskToEnd)
    }
  }

  private func startBackgroundKeepAliveTaskIfNeeded() {
    endBackgroundKeepAliveTask()
    guard keepAliveEnabled, keepAliveMinutes > 0, sessionActive else {
      return
    }
    var expiredSynchronously = false
    var newTaskId: UIBackgroundTaskIdentifier = .invalid
    newTaskId = UIApplication.shared.beginBackgroundTask(
      withName: "AntigravityRemoteSessionKeepAlive"
    ) { [weak self] in
      let capturedId = newTaskId
      self?.runOnMain {
        expiredSynchronously = true
        if capturedId != .invalid {
          UIApplication.shared.endBackgroundTask(capturedId)
        }
        if self?.backgroundTaskId == capturedId {
          self?.backgroundTaskId = .invalid
        } else {
          self?.endBackgroundKeepAliveTask()
        }
      }
    }
    if expiredSynchronously {
      if newTaskId != .invalid {
        UIApplication.shared.endBackgroundTask(newTaskId)
      }
      backgroundTaskId = .invalid
    } else {
      backgroundTaskId = newTaskId
    }
  }

  public func definition() -> ModuleDefinition {
    Name("RemoteSession")

    AsyncFunction("clearWebData") { (promise: Promise) in
      self.sessionActive = false
      self.endBackgroundKeepAliveTask()
      WKWebsiteDataStore.default().removeData(
        ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
        modifiedSince: Date(timeIntervalSince1970: 0)
      ) { promise.resolve(nil) }
    }.runOnQueue(.main)

    AsyncFunction("configureKeepAlive") { (enabled: Bool, durationMinutes: Int, active: Bool) in
      self.keepAliveEnabled = enabled
      self.keepAliveMinutes = max(0, min(durationMinutes, 60))
      self.sessionActive = active
      if !enabled || durationMinutes <= 0 || !active {
        self.endBackgroundKeepAliveTask()
      }
    }.runOnQueue(.main)

    OnAppEntersBackground {
      self.runOnMain {
        self.startBackgroundKeepAliveTaskIfNeeded()
      }
    }

    OnAppEntersForeground {
      self.runOnMain {
        self.endBackgroundKeepAliveTask()
      }
    }

    OnDestroy {
      self.runOnMain {
        self.endBackgroundKeepAliveTask()
      }
    }
  }
}
