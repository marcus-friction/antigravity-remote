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
  private static let backgroundPollIntervalSeconds: TimeInterval = 10.0
  private static let backgroundPollScript =
    "(function(){try{if(!window.location||window.location.origin!=='https://antigravity.google.com')return;window.__agyKeepAliveLockDesired=true;if(window.__agyInboxBridge&&typeof window.__agyInboxBridge.backgroundTick==='function'){window.__agyInboxBridge.backgroundTick(8000);}else if(window.__agyInboxBridge&&typeof window.__agyInboxBridge.refresh==='function'){window.__agyInboxBridge.refresh(false,true);}}catch(_){}})();"
  private var keepAliveEnabled: Bool = false
  private var keepAliveMinutes: Int = 0
  private var sessionActive: Bool = false
  private var backgroundTaskId: UIBackgroundTaskIdentifier = .invalid
  private var backgroundPollTimer: Timer?

  deinit {
    backgroundPollTimer?.invalidate()
    backgroundPollTimer = nil
  }

  private func runOnMain(_ block: @escaping () -> Void) {
    if Thread.isMainThread {
      block()
    } else {
      DispatchQueue.main.async(execute: block)
    }
  }

  private func findWebView(in view: UIView) -> WKWebView? {
    if let webView = view as? WKWebView {
      return webView
    }
    for subview in view.subviews {
      if let found = findWebView(in: subview) {
        return found
      }
    }
    return nil
  }

  private func resolveActiveWebView() -> WKWebView? {
    for scene in UIApplication.shared.connectedScenes {
      guard let windowScene = scene as? UIWindowScene else { continue }
      for window in windowScene.windows {
        if let found = findWebView(in: window) {
          return found
        }
      }
    }
    return nil
  }

  private func isTrustedAntigravityUrl(_ url: URL?) -> Bool {
    guard let url = url,
          url.scheme?.lowercased() == "https",
          url.host?.lowercased() == "antigravity.google.com",
          url.port == nil,
          url.user == nil,
          url.password == nil else {
      return false
    }
    return true
  }

  private func triggerBackgroundStateRefresh() {
    guard keepAliveEnabled, keepAliveMinutes > 0, sessionActive, backgroundTaskId != .invalid else {
      return
    }
    guard let webView = resolveActiveWebView(), isTrustedAntigravityUrl(webView.url) else {
      return
    }
    webView.evaluateJavaScript(Self.backgroundPollScript, completionHandler: nil)
  }

  private func stopBackgroundPollTimer() {
    backgroundPollTimer?.invalidate()
    backgroundPollTimer = nil
  }

  private func startBackgroundPollTimer() {
    stopBackgroundPollTimer()
    let timer = Timer(
      timeInterval: Self.backgroundPollIntervalSeconds,
      repeats: true
    ) { [weak self] activeTimer in
      guard let self = self else {
        activeTimer.invalidate()
        return
      }
      self.triggerBackgroundStateRefresh()
    }
    RunLoop.main.add(timer, forMode: .common)
    backgroundPollTimer = timer
  }

  private func endBackgroundKeepAliveTask() {
    stopBackgroundPollTimer()
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
      let finishExpired = {
        expiredSynchronously = true
        guard let self = self else {
          if capturedId != .invalid {
            UIApplication.shared.endBackgroundTask(capturedId)
          }
          return
        }
        guard self.backgroundTaskId == capturedId else {
          return
        }
        self.stopBackgroundPollTimer()
        self.backgroundTaskId = .invalid
        if capturedId != .invalid {
          UIApplication.shared.endBackgroundTask(capturedId)
        }
      }
      if Thread.isMainThread {
        finishExpired()
      } else {
        DispatchQueue.main.async(execute: finishExpired)
      }
    }
    if expiredSynchronously {
      if newTaskId != .invalid {
        UIApplication.shared.endBackgroundTask(newTaskId)
      }
      backgroundTaskId = .invalid
    } else {
      backgroundTaskId = newTaskId
      if newTaskId != .invalid {
        startBackgroundPollTimer()
      }
    }
  }

  private struct ActionCardItem {
    let title: String
    let attentionKind: String
    let statusLabel: String
    let attentionReason: String
    let projectName: String
    let instanceName: String
    let subtitle: String
  }

  private func parseActionCardItems(_ itemsJson: String) -> [ActionCardItem] {
    guard !itemsJson.isEmpty,
          let data = itemsJson.data(using: .utf8),
          let rawArray = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else {
      return []
    }
    var items: [ActionCardItem] = []
    for dict in rawArray.prefix(4) {
      let title = (dict["title"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      guard !title.isEmpty else { continue }
      let kind = (dict["attentionKind"] as? String ?? "unread").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      let rawLabel = (dict["statusLabel"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      let statusLabel: String
      if !rawLabel.isEmpty {
        statusLabel = rawLabel
      } else {
        switch kind {
        case "approval": statusLabel = "NEEDS APPROVAL"
        case "error": statusLabel = "NEEDS REVIEW"
        case "unread": statusLabel = "FINISHED"
        case "running": statusLabel = "WORKING"
        default: statusLabel = "UPDATE"
        }
      }
      let reason = (dict["attentionReason"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      let projectName = (dict["projectName"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      let instanceName = (dict["instanceName"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      let subtitle = (dict["subtitle"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      items.append(ActionCardItem(
        title: title,
        attentionKind: kind,
        statusLabel: statusLabel,
        attentionReason: reason,
        projectName: projectName,
        instanceName: instanceName,
        subtitle: subtitle
      ))
    }
    return items
  }

  private func cardPalette(for kind: String) -> (
    cardBg: UIColor,
    cardBorder: UIColor,
    accent: UIColor,
    badgeBg: UIColor,
    badgeBorder: UIColor,
    badgeText: UIColor,
    reasonText: UIColor
  ) {
    switch kind {
    case "approval":
      return (
        cardBg: UIColor(red: 0.106, green: 0.098, blue: 0.082, alpha: 1.0),
        cardBorder: UIColor(red: 0.290, green: 0.220, blue: 0.094, alpha: 1.0),
        accent: UIColor(red: 0.961, green: 0.620, blue: 0.043, alpha: 1.0),
        badgeBg: UIColor(red: 0.961, green: 0.620, blue: 0.043, alpha: 0.17),
        badgeBorder: UIColor(red: 0.961, green: 0.620, blue: 0.043, alpha: 0.42),
        badgeText: UIColor(red: 0.992, green: 0.902, blue: 0.541, alpha: 1.0),
        reasonText: UIColor(red: 0.992, green: 0.902, blue: 0.541, alpha: 1.0)
      )
    case "error":
      return (
        cardBg: UIColor(red: 0.110, green: 0.082, blue: 0.090, alpha: 1.0),
        cardBorder: UIColor(red: 0.306, green: 0.149, blue: 0.169, alpha: 1.0),
        accent: UIColor(red: 0.937, green: 0.267, blue: 0.267, alpha: 1.0),
        badgeBg: UIColor(red: 0.937, green: 0.267, blue: 0.267, alpha: 0.17),
        badgeBorder: UIColor(red: 0.937, green: 0.267, blue: 0.267, alpha: 0.42),
        badgeText: UIColor(red: 0.996, green: 0.792, blue: 0.792, alpha: 1.0),
        reasonText: UIColor(red: 0.988, green: 0.647, blue: 0.647, alpha: 1.0)
      )
    case "unread":
      return (
        cardBg: UIColor(red: 0.078, green: 0.098, blue: 0.149, alpha: 1.0),
        cardBorder: UIColor(red: 0.141, green: 0.227, blue: 0.380, alpha: 1.0),
        accent: UIColor(red: 0.196, green: 0.475, blue: 0.976, alpha: 1.0),
        badgeBg: UIColor(red: 0.196, green: 0.475, blue: 0.976, alpha: 0.19),
        badgeBorder: UIColor(red: 0.541, green: 0.706, blue: 0.973, alpha: 0.44),
        badgeText: UIColor(red: 0.749, green: 0.859, blue: 0.996, alpha: 1.0),
        reasonText: UIColor(red: 0.576, green: 0.773, blue: 0.992, alpha: 1.0)
      )
    default:
      return (
        cardBg: UIColor(red: 0.086, green: 0.086, blue: 0.106, alpha: 1.0),
        cardBorder: UIColor(red: 0.165, green: 0.169, blue: 0.200, alpha: 1.0),
        accent: UIColor(red: 0.392, green: 0.455, blue: 0.545, alpha: 1.0),
        badgeBg: UIColor(white: 1.0, alpha: 0.08),
        badgeBorder: UIColor(white: 1.0, alpha: 0.16),
        badgeText: UIColor(red: 0.737, green: 0.741, blue: 0.776, alpha: 1.0),
        reasonText: UIColor(red: 0.737, green: 0.741, blue: 0.776, alpha: 1.0)
      )
    }
  }

  private func drawFolderIcon(in rect: CGRect, color: UIColor) {
    let sx = rect.width / 16.0
    let sy = rect.height / 16.0
    func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
      CGPoint(x: rect.minX + x * sx, y: rect.minY + y * sy)
    }
    let path = UIBezierPath()
    path.move(to: pt(2.0, 4.5))
    path.addQuadCurve(to: pt(3.5, 3.0), controlPoint: pt(2.0, 3.0))
    path.addLine(to: pt(6.2, 3.0))
    path.addLine(to: pt(7.7, 4.7))
    path.addLine(to: pt(12.5, 4.7))
    path.addQuadCurve(to: pt(14.0, 6.2), controlPoint: pt(14.0, 4.7))
    path.addLine(to: pt(14.0, 11.5))
    path.addQuadCurve(to: pt(12.5, 13.0), controlPoint: pt(14.0, 13.0))
    path.addLine(to: pt(3.5, 13.0))
    path.addQuadCurve(to: pt(2.0, 11.5), controlPoint: pt(2.0, 13.0))
    path.close()
    path.lineWidth = 1.25
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    color.setStroke()
    path.stroke()
  }

  private func renderCardsAttachment(items: [ActionCardItem], totalCount: Int) -> (UNNotificationAttachment, URL)? {
    let rendered = Array(items.prefix(3))
    guard !rendered.isEmpty else { return nil }

    let width: CGFloat = 340
    let pad: CGFloat = 10
    let cardGap: CGFloat = 7
    let cardHeights = rendered.map { $0.projectName.isEmpty ? CGFloat(68) : CGFloat(82) }
    let remaining = max(0, totalCount - rendered.count)
    let footerHeight: CGFloat = remaining > 0 ? 22 : 0
    let totalCardsHeight = cardHeights.reduce(0, +)
    let totalHeight = pad * 2
      + totalCardsHeight
      + CGFloat(max(0, rendered.count - 1)) * cardGap
      + footerHeight

    let format = UIGraphicsImageRendererFormat()
    format.scale = 2.0
    format.opaque = true
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: totalHeight), format: format)

    let image = renderer.image { _ in
      UIColor(red: 0.043, green: 0.043, blue: 0.055, alpha: 1.0).setFill()
      UIRectFill(CGRect(x: 0, y: 0, width: width, height: totalHeight))

      let truncatingParagraph = NSMutableParagraphStyle()
      truncatingParagraph.lineBreakMode = .byTruncatingTail

      let rightParagraph = NSMutableParagraphStyle()
      rightParagraph.alignment = .right
      rightParagraph.lineBreakMode = .byTruncatingTail

      let projectColor = UIColor(red: 0.737, green: 0.741, blue: 0.776, alpha: 1.0)

      var y = pad
      for (index, item) in rendered.enumerated() {
        let cardHeight = cardHeights[index]
        let palette = cardPalette(for: item.attentionKind)
        let cardRect = CGRect(x: pad, y: y, width: width - pad * 2, height: cardHeight)
        let cardPath = UIBezierPath(roundedRect: cardRect, cornerRadius: 10)
        palette.cardBg.setFill()
        cardPath.fill()
        palette.cardBorder.setStroke()
        cardPath.lineWidth = 1.0
        cardPath.stroke()

        let accentRect = CGRect(x: cardRect.minX + 6, y: cardRect.minY + 7, width: 3.5, height: cardHeight - 14)
        palette.accent.setFill()
        UIBezierPath(roundedRect: accentRect, cornerRadius: 2).fill()

        let contentX = accentRect.maxX + 9
        let contentWidth = cardRect.maxX - contentX - 10

        let badgeAttrs: [NSAttributedString.Key: Any] = [
          .font: UIFont.systemFont(ofSize: 9, weight: .bold),
          .foregroundColor: palette.badgeText,
        ]
        let badgeSize = (item.statusLabel as NSString).size(withAttributes: badgeAttrs)
        let badgeRect = CGRect(
          x: contentX,
          y: cardRect.minY + 8,
          width: min(contentWidth * 0.56, badgeSize.width + 10),
          height: 15
        )
        let badgePath = UIBezierPath(roundedRect: badgeRect, cornerRadius: 4)
        palette.badgeBg.setFill()
        badgePath.fill()
        palette.badgeBorder.setStroke()
        badgePath.lineWidth = 0.8
        badgePath.stroke()
        (item.statusLabel as NSString).draw(
          in: CGRect(x: badgeRect.minX + 5, y: badgeRect.minY + 2, width: badgeRect.width - 10, height: 12),
          withAttributes: badgeAttrs
        )

        let rightMeta = item.projectName.isEmpty ? item.subtitle : item.instanceName
        if !rightMeta.isEmpty {
          let subX = badgeRect.maxX + 6
          let subWidth = max(0, cardRect.maxX - subX - 10)
          if subWidth > 20 {
            let subAttrs: [NSAttributedString.Key: Any] = [
              .font: UIFont.systemFont(ofSize: 9.5, weight: .medium),
              .foregroundColor: UIColor(red: 0.529, green: 0.533, blue: 0.561, alpha: 1.0),
              .paragraphStyle: rightParagraph,
            ]
            (rightMeta as NSString).draw(
              in: CGRect(x: subX, y: cardRect.minY + 9, width: subWidth, height: 13),
              withAttributes: subAttrs
            )
          }
        }

        var nextY = cardRect.minY + 27
        if !item.projectName.isEmpty {
          let iconRect = CGRect(x: contentX, y: nextY + 1, width: 11, height: 11)
          drawFolderIcon(in: iconRect, color: projectColor)
          let projAttrs: [NSAttributedString.Key: Any] = [
            .font: UIFont.systemFont(ofSize: 10.5, weight: .semibold),
            .foregroundColor: projectColor,
            .paragraphStyle: truncatingParagraph,
          ]
          (item.projectName as NSString).draw(
            in: CGRect(x: contentX + 15, y: nextY, width: max(0, contentWidth - 15), height: 14),
            withAttributes: projAttrs
          )
          nextY += 15
        }

        let titleAttrs: [NSAttributedString.Key: Any] = [
          .font: UIFont.systemFont(ofSize: 12.5, weight: .semibold),
          .foregroundColor: UIColor(red: 0.957, green: 0.961, blue: 0.969, alpha: 1.0),
          .paragraphStyle: truncatingParagraph,
        ]
        (item.title as NSString).draw(
          in: CGRect(x: contentX, y: nextY, width: contentWidth, height: 16),
          withAttributes: titleAttrs
        )

        let reasonAttrs: [NSAttributedString.Key: Any] = [
          .font: UIFont.systemFont(ofSize: 11, weight: .medium),
          .foregroundColor: palette.reasonText,
          .paragraphStyle: truncatingParagraph,
        ]
        (item.attentionReason as NSString).draw(
          in: CGRect(x: contentX, y: nextY + 19, width: contentWidth, height: 15),
          withAttributes: reasonAttrs
        )

        y += cardHeight + cardGap
      }

      if remaining > 0 {
        let footerParagraph = NSMutableParagraphStyle()
        footerParagraph.alignment = .center
        let footerAttrs: [NSAttributedString.Key: Any] = [
          .font: UIFont.systemFont(ofSize: 10.5, weight: .semibold),
          .foregroundColor: UIColor(red: 0.541, green: 0.706, blue: 0.973, alpha: 1.0),
          .paragraphStyle: footerParagraph,
        ]
        ("+\(remaining) more in Inbox • Tap to open" as NSString).draw(
          in: CGRect(x: pad, y: y + 2, width: width - pad * 2, height: 16),
          withAttributes: footerAttrs
        )
      }
    }

    guard let pngData = image.pngData() else { return nil }
    let fileUrl = FileManager.default.temporaryDirectory
      .appendingPathComponent("agy_action_cards_\(UUID().uuidString).png")
    do {
      try pngData.write(to: fileUrl, options: .atomic)
      let attachment = try UNNotificationAttachment(
        identifier: "agy_action_cards",
        url: fileUrl,
        options: [UNNotificationAttachmentOptionsTypeHintKey: "public.png"]
      )
      return (attachment, fileUrl)
    } catch {
      try? FileManager.default.removeItem(at: fileUrl)
      return nil
    }
  }

  private func buildNotificationSubtitle(items: [ActionCardItem], totalCount: Int) -> String {
    if totalCount == 1, let first = items.first {
      if !first.projectName.isEmpty {
        return first.instanceName.isEmpty
          ? "\(first.statusLabel) · 📁 \(first.projectName)"
          : "\(first.statusLabel) · 📁 \(first.projectName) · \(first.instanceName)"
      }
      return first.subtitle.isEmpty ? first.statusLabel : "\(first.statusLabel) · \(first.subtitle)"
    }
    var approvals = 0
    var errors = 0
    var unread = 0
    for item in items {
      switch item.attentionKind {
      case "approval": approvals += 1
      case "error": errors += 1
      default: unread += 1
      }
    }
    var parts: [String] = []
    if approvals > 0 { parts.append("\(approvals) approval\(approvals == 1 ? "" : "s")") }
    if errors > 0 { parts.append("\(errors) review") }
    if unread > 0 { parts.append("\(unread) finished") }
    let remaining = max(0, totalCount - items.count)
    if remaining > 0 {
      parts.append("+\(remaining) more")
    }
    return parts.joined(separator: " · ")
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
      (title: String, body: String, expandedBody: String, count: Int, deepLinkUrl: String, shouldAlert: Bool, itemsJson: String) in
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

      let items = self.parseActionCardItems(itemsJson)
      let content = UNMutableNotificationContent()
      content.title = title
      let subtitle = self.buildNotificationSubtitle(items: items, totalCount: count)
      if !subtitle.isEmpty {
        content.subtitle = subtitle
      }
      content.body = expandedBody.isEmpty ? body : expandedBody
      content.threadIdentifier = "agy_action_threads"
      content.badge = NSNumber(value: count)
      var attachmentTempUrl: URL? = nil
      if let (attachment, tempUrl) = self.renderCardsAttachment(items: items, totalCount: count) {
        content.attachments = [attachment]
        attachmentTempUrl = tempUrl
      }
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
      center.add(request) { error in
        if error != nil, let tempUrl = attachmentTempUrl {
          try? FileManager.default.removeItem(at: tempUrl)
        }
      }
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
