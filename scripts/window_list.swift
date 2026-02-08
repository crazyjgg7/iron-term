import Foundation
import AppKit

let screens = NSScreen.screens
let displayMeta: [[String: String]] = screens.enumerated().map { idx, screen in
  let frame = screen.frame
  return [
    "index": String(idx + 1),
    "x": String(Int(frame.origin.x)),
    "y": String(Int(frame.origin.y)),
    "w": String(Int(frame.size.width)),
    "h": String(Int(frame.size.height))
  ]
}

let regularApps = NSWorkspace.shared.runningApplications
  .filter { !$0.isHidden && !$0.isTerminated && $0.activationPolicy == .regular }

let apps = regularApps
  .map { app -> [String: String] in
    [
      "name": app.localizedName ?? "",
      "bundleId": app.bundleIdentifier ?? ""
    ]
  }
  .filter { !$0["name", default: ""].isEmpty }

let args = CommandLine.arguments
if args.count >= 3 && args[1] == "activate" {
  let bundleId = args[2]
  if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first {
    app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
  }
  exit(0)
}

if args.count >= 7 && args[1] == "move" {
  let bundleId = args[2]
  let displayX = Int(args[3]) ?? 0
  let displayY = Int(args[4]) ?? 0
  let displayW = Int(args[5]) ?? 0
  let displayH = Int(args[6]) ?? 0
  let appName = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first?.localizedName ?? bundleId
  let targetX = displayX + max(0, (displayW - 900) / 2)
  let targetY = displayY + max(0, (displayH - 600) / 2)
  let script = """
  tell application "System Events"
    tell application process "\(appName)"
      try
        set frontmost to true
        set position of front window to {\(targetX), \(targetY)}
      end try
    end tell
  end tell
  """
  let process = Process()
  process.launchPath = "/usr/bin/osascript"
  process.arguments = ["-e", script]
  try? process.run()
  process.waitUntilExit()
  exit(0)
}

let regularAppNames = Set(regularApps.compactMap { $0.localizedName })

let windowInfo = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []

let windows: [[String: String]] = windowInfo.compactMap { info in
  let ownerName = info[kCGWindowOwnerName as String] as? String ?? ""
  let title = info[kCGWindowName as String] as? String ?? ""
  let windowNumber = info[kCGWindowNumber as String] as? Int ?? 0
  let layer = info[kCGWindowLayer as String] as? Int ?? 0
  let boundsDict = info[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let bx = boundsDict["X"] as? Double ?? 0
  let by = boundsDict["Y"] as? Double ?? 0
  let bw = boundsDict["Width"] as? Double ?? 0
  let bh = boundsDict["Height"] as? Double ?? 0
  if ownerName.isEmpty || windowNumber == 0 || layer != 0 {
    return nil
  }
  if !regularAppNames.contains(ownerName) {
    return nil
  }
  let center = CGPoint(x: bx + bw / 2.0, y: by + bh / 2.0)
  var displayIndex = "1"
  var displayX = "0"
  var displayY = "0"
  var displayW = "0"
  var displayH = "0"
  if let match = screens.enumerated().first(where: { (_, screen) in screen.frame.contains(center) }) {
    let frame = match.element.frame
    displayIndex = String(match.offset + 1)
    displayX = String(Int(frame.origin.x))
    displayY = String(Int(frame.origin.y))
    displayW = String(Int(frame.size.width))
    displayH = String(Int(frame.size.height))
  }
  return [
    "appName": ownerName,
    "title": title,
    "id": String(windowNumber)
    ,"x": String(Int(bx))
    ,"y": String(Int(by))
    ,"w": String(Int(bw))
    ,"h": String(Int(bh))
    ,"displayIndex": displayIndex
    ,"displayX": displayX
    ,"displayY": displayY
    ,"displayW": displayW
    ,"displayH": displayH
  ]
}

let payload: [String: Any] = [
  "apps": apps,
  "windows": windows,
  "displays": displayMeta
]

do {
  let data = try JSONSerialization.data(withJSONObject: payload, options: [])
  if let output = String(data: data, encoding: .utf8) {
    print(output)
  }
} catch {
  fputs("{\"apps\":[],\"windows\":[]}", stderr)
}
