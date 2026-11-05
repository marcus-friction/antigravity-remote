import ExpoModulesCore
import UIKit
import UserNotifications
import WebKit

private final class ActionNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
  static let shared = ActionNotificationDelegate()
  static let deepLinkKey = "agyDeepLink"
  static let shouldAlertKey = "agyShouldAlert"
  static let countKey = "agyCount"
  static let allowedPrefix = "antigravity-remote://"

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let shouldAlert = (notification.request.content.userInfo[Self.shouldAlertKey] as? Bool) ?? false
    if shouldAlert {
      completionHandler([.banner, .list, .sound, .badge])
    } else {
      completionHandler([.list, .badge])
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let userInfo = response.notification.request.content.userInfo
    let rawLink = userInfo[Self.deepLinkKey] as? String
    let count = (userInfo[Self.countKey] as? Int) ?? 0
    if let link = rawLink, link.hasPrefix(Self.allowedPrefix), let url = URL(string: link) {
      DispatchQueue.main.async {
        if count <= 1 {
          if #available(iOS 16.0, *) {
            center.setBadgeCount(0) { _ in }
          } else {
            UIApplication.shared.applicationIconBadgeNumber = 0
          }
        }
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
      }
    }
    completionHandler()
  }
}

public class RemoteSessionModule: Module {
  private static let actionNotificationIdentifier = "agy_action_required"
  private var keepAliveEnabled: Bool = false
  private var keepAliveMinutes: Int = 0
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

    OnCreate {
      self.runOnMain {
        let center = UNUserNotificationCenter.current()
        if center.delegate == nil {
          center.delegate = ActionNotificationDelegate.shared
        }
      }
    }

    AsyncFunction("clearWebData") { (promise: Promise) in
      self.sessionActive = false
      self.endBackgroundKeepAliveTask()
      let center = UNUserNotificationCenter.current()
      center.removeDeliveredNotifications(withIdentifiers: [Self.actionNotificationIdentifier])
      center.removePendingNotificationRequests(withIdentifiers: [Self.actionNotificationIdentifier])
      if #available(iOS 16.0, *) {
        center.setBadgeCount(0) { _ in }
      } else {
        UIApplication.shared.applicationIconBadgeNumber = 0
      }
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

    AsyncFunction("installDocumentStartScript") { (_: String) in
      // iOS injects document-start subframe scripts via WKUserScript
      // (`injectedJavaScriptBeforeContentLoadedForMainFrameOnly={false}`).
    }.runOnQueue(.main)

    AsyncFunction("syncActionNotification") {
      (title: String, body: String, expandedBody: String, count: Int, deepLinkUrl: String, shouldAlert: Bool) in
      let center = UNUserNotificationCenter.current()
      if center.delegate == nil {
        center.delegate = ActionNotificationDelegate.shared
      }
      guard count > 0, deepLinkUrl.hasPrefix(ActionNotificationDelegate.allowedPrefix) else {
        center.removeDeliveredNotifications(withIdentifiers: [Self.actionNotificationIdentifier])
        center.removePendingNotificationRequests(withIdentifiers: [Self.actionNotificationIdentifier])
        if #available(iOS 16.0, *) {
          center.setBadgeCount(0) { _ in }
        } else {
          UIApplication.shared.applicationIconBadgeNumber = 0
        }
        return
      }

      let content = UNMutableNotificationContent()
      content.title = title
      content.body = expandedBody.isEmpty ? body : expandedBody
      content.badge = NSNumber(value: count)
      if shouldAlert {
        content.sound = .default
        if #available(iOS 15.0, *) {
          content.interruptionLevel = .active
        }
      } else if #available(iOS 15.0, *) {
        content.interruptionLevel = .passive
      }
      content.userInfo = [
        ActionNotificationDelegate.deepLinkKey: deepLinkUrl,
        ActionNotificationDelegate.shouldAlertKey: shouldAlert,
        ActionNotificationDelegate.countKey: count,
      ]

      let request = UNNotificationRequest(
        identifier: Self.actionNotificationIdentifier,
        content: content,
        trigger: nil
      )
      center.add(request, withCompletionHandler: nil)
    }.runOnQueue(.main)

    AsyncFunction("clearActionNotification") {
      let center = UNUserNotificationCenter.current()
      center.removeDeliveredNotifications(withIdentifiers: [Self.actionNotificationIdentifier])
      center.removePendingNotificationRequests(withIdentifiers: [Self.actionNotificationIdentifier])
      if #available(iOS 16.0, *) {
        center.setBadgeCount(0) { _ in }
      } else {
        UIApplication.shared.applicationIconBadgeNumber = 0
      }
    }.runOnQueue(.main)

    AsyncFunction("requestNotificationPermission") { (promise: Promise) in
      let center = UNUserNotificationCenter.current()
      if center.delegate == nil {
        center.delegate = ActionNotificationDelegate.shared
      }
      center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
        promise.resolve(granted)
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
