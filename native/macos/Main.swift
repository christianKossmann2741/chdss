import Foundation
import Darwin
import ScreenCaptureKit
import CoreGraphics
import AppKit

func status(_ payload: [String: Any]) {
    do {
        var data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        data.append(10)
        try FileHandle.standardError.write(contentsOf: data)
    } catch { Darwin.exit(1) }
}

enum Command {
    case list
    case capture(CaptureSource)
    static func parse(_ args: [String]) throws -> Command {
        if args == ["--list"] { return .list }
        if args.count == 2, args[0] == "--source" { return .capture(try CaptureSource.parse(args[1])) }
        throw HelperError.message("Usage: chdss-audio --list | --source window:<windowId>:0 | --source screen:<displayId>:0")
    }
}

@main
@MainActor
struct AudioHelper {
    private static var controller: CaptureController?
    static func main() {
        let command: Command
        do { command = try Command.parse(Array(CommandLine.arguments.dropFirst())) }
        catch { status(["type": "error", "message": error.localizedDescription]); Darwin.exit(1) }
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        Task { @MainActor in
            do {
                switch command {
                case .list:
                    let content = try await shareableContent()
                    let windows: [[String: Any]] = content.windows.compactMap { window in
                        guard let app = window.owningApplication else { return nil }
                        return ["windowId": window.windowID, "pid": app.processID,
                                "name": window.title ?? app.applicationName, "bundleId": app.bundleIdentifier]
                    }.sorted { ($0["windowId"] as! UInt32) < ($1["windowId"] as! UInt32) }
                    var data = try JSONSerialization.data(withJSONObject: windows, options: [.sortedKeys])
                    data.append(10)
                    try FileHandle.standardOutput.write(contentsOf: data)
                    Darwin.exit(0)
                case .capture(let source):
                    let capture = CaptureController(source: source)
                    controller = capture
                    do { try await capture.run() }
                    catch { await capture.finish(error: error) }
                }
            } catch {
                status(["type": "error", "message": error.localizedDescription])
                Darwin.exit(1)
            }
        }
        app.run()
    }
}

func shareableContent() async throws -> SCShareableContent {
    guard CGPreflightScreenCaptureAccess() else {
        throw HelperError.message("Screen Recording permission is required. Grant the launching app access in System Settings > Privacy & Security > Screen & System Audio Recording, then restart it.")
    }
    return try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
}
