import Foundation

enum HelperError: Error, LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let text): return text }
    }
}

enum CaptureSource: Equatable {
    case window(UInt32)
    case display(UInt32)

    static func parse(_ value: String) throws -> CaptureSource {
        let parts = value.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[2] == "0", !parts[1].isEmpty,
              parts[1].allSatisfy({ $0 >= "0" && $0 <= "9" }),
              let id = UInt32(parts[1]) else {
            throw HelperError.message("Invalid Electron source ID: \(value)")
        }
        switch parts[0] {
        case "window" where id != 0: return .window(id)
        case "screen": return .display(id)
        default: throw HelperError.message("Invalid Electron source ID: \(value)")
        }
    }
}

struct AppIdentity: Equatable {
    let pid: Int32
    let name: String
    let bundleID: String
    let path: String
}

struct ExclusionPolicy {
    let selfPID: Int32
    let ancestorPIDs: Set<Int32>

    func excludes(_ app: AppIdentity) -> Bool {
        if app.pid == selfPID || ancestorPIDs.contains(app.pid) { return true }
        // Broad matches deliberately favor over-exclusion, including app helpers.
        let labels = [app.name, app.bundleID, app.path].map { $0.lowercased() }
        return labels.contains { $0.contains("discord") || $0.contains("chdss") }
    }

    func allowedPIDs(_ applications: [AppIdentity]) -> Set<Int32> {
        Set(applications.filter { !excludes($0) }.map(\.pid))
    }
}

struct WindowIdentity: Equatable {
    let windowID: UInt32
    let pid: Int32
    func isPresent(in windows: [WindowIdentity]) -> Bool { windows.contains(self) }
}

struct CapturePlan: Equatable {
    let displayID: UInt32
    let allowedPIDs: Set<Int32>
    let owner: WindowIdentity?
    var scope: String { owner == nil ? "display" : "application" }

    static func make(source: CaptureSource, windows: [WindowIdentity], apps: [AppIdentity],
                     displayIDs: [UInt32], policy: ExclusionPolicy) throws -> CapturePlan {
        guard let firstDisplay = displayIDs.first else { throw HelperError.message("No capture display available") }
        switch source {
        case .window(let id):
            guard let window = windows.first(where: { $0.windowID == id }),
                  let app = apps.first(where: { $0.pid == window.pid }) else {
                throw HelperError.message("Selected window or owning application is no longer available")
            }
            guard app.pid != policy.selfPID, !policy.ancestorPIDs.contains(app.pid),
                  ![app.name, app.bundleID, app.path].contains(where: { $0.lowercased().contains("chdss") }) else {
                throw HelperError.message("CHDSS cannot capture its own audio")
            }
            return CapturePlan(displayID: firstDisplay, allowedPIDs: [app.pid], owner: window)
        case .display(let id):
            let display: UInt32
            if displayIDs.contains(id) { display = id }
            else if Int(id) < displayIDs.count { display = displayIDs[Int(id)] }
            else { throw HelperError.message("Selected display is no longer available") }
            let allowed = policy.allowedPIDs(apps)
            guard !allowed.isEmpty else { throw HelperError.message("No eligible applications; refusing unfiltered capture") }
            return CapturePlan(displayID: display, allowedPIDs: allowed, owner: nil)
        }
    }
}

final class CaptureGate: @unchecked Sendable {
    private let lock = NSLock()
    private var generation: UUID?
    func open(for token: UUID) { lock.lock(); generation = token; lock.unlock() }
    func close() { lock.lock(); generation = nil; lock.unlock() }
    func close(for token: UUID) {
        lock.lock(); defer { lock.unlock() }
        if generation == token { generation = nil }
    }
    func permits(_ token: UUID) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return generation == token
    }
    // The write and gate transition are mutually exclusive. No queued PCM may
    // sneak through after lifecycle code has closed the gate.
    func withPermission<T>(_ token: UUID, _ body: () throws -> T) rethrows -> T? {
        lock.lock(); defer { lock.unlock() }
        guard generation == token else { return nil }
        return try body()
    }
}
