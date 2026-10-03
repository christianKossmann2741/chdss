import Foundation
import AppKit
import ScreenCaptureKit
import CoreMedia
import CoreGraphics
import Darwin

// Each stream gets a separate generation. Captured/buffered samples belonging
// to a stopped stream can never be admitted after a replacement is started.
final class AudioSink: NSObject, SCStreamOutput, SCStreamDelegate {
    let token: UUID
    let gate: CaptureGate
    let writer: PCMWriter
    let failure: (UUID, Error) -> Void
    init(token: UUID, gate: CaptureGate, writer: PCMWriter, failure: @escaping (UUID, Error) -> Void) {
        self.token = token; self.gate = gate; self.writer = writer; self.failure = failure
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, gate.permits(token) else { return }
        do { try writer.write(PCMCodec.read(sampleBuffer), token: token) }
        catch { gate.close(for: token); failure(token, error) }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        gate.close(for: token)
        failure(token, error)
    }
}

@MainActor
final class CaptureController {
    private let source: CaptureSource
    nonisolated private let gate = CaptureGate()
    private let policy: ExclusionPolicy
    private let queue = DispatchQueue(label: "chdss.audio.pcm", qos: .userInteractive)
    private var writer: PCMWriter!
    private var stream: SCStream?
    private var sink: AudioSink?
    private var plan: CapturePlan?
    private var identities: [AppIdentity] = []
    private var token = UUID()
    private var epoch: UInt64 = 0
    private var stopped = false
    private var rebuilding = false
    private var sentReady = false
    private var observers: [NSObjectProtocol] = []
    private var signalSources: [DispatchSourceSignal] = []
    private var stdinSource: DispatchSourceRead?
    private var monitor: Task<Void, Never>?

    init(source: CaptureSource) {
        self.source = source
        // Electron directly spawns this child. Excluding its PID additionally
        // protects dev-mode Electron, which may lack a CHDSS bundle identifier.
        policy = ExclusionPolicy(selfPID: getpid(), ancestorPIDs: [getppid()])
    }

    func run() async throws {
        signal(SIGPIPE, SIG_IGN)
        writer = try PCMWriter(fd: STDOUT_FILENO, gate: gate)
        installLifetimeObservers()
        try await refresh()
        monitor = Task { @MainActor [weak self] in
            while let self, !self.stopped {
                do {
                    try await Task.sleep(nanoseconds: 250_000_000)
                    if self.stopped { return }
                    try self.verifyWindowLifetime()
                    try await self.refresh()
                } catch is CancellationError { return }
                catch { await self.finish(error: error) }
            }
        }
    }

    private func installLifetimeObservers() {
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                // Main run loop notifications are delivered on the main queue.
                // The application allowlist already denies all new processes.
                // Close before asynchronously rebuilding to discard queued audio.
                self?.gate.close()
                Task { @MainActor [weak self] in self?.epoch &+= 1 }
            })
        }
        for number in [SIGINT, SIGTERM, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in
                self?.gate.close()
                Task { @MainActor [weak self] in await self?.finish(error: nil) }
            }
            signalSources.append(source); source.resume()
        }
        let input = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
        let flags = fcntl(STDIN_FILENO, F_GETFL)
        if flags >= 0 { _ = fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK) }
        input.setEventHandler { [weak self] in
            var bytes = [UInt8](repeating: 0, count: 256)
            let n = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
            if n == 0 || (n < 0 && errno != EAGAIN && errno != EINTR) {
                self?.gate.close()
                Task { @MainActor [weak self] in await self?.finish(error: nil) }
            }
        }
        stdinSource = input; input.resume()
    }

    private func verifyWindowLifetime() throws {
        guard let owner = plan?.owner else { return }
        guard let running = NSRunningApplication(processIdentifier: owner.pid), !running.isTerminated else {
            gate.close()
            throw HelperError.message("Selected window owning application exited")
        }
        guard let windows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
              windows.contains(where: {
                  ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == owner.windowID &&
                  ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == owner.pid
              }) else {
            gate.close()
            throw HelperError.message("Selected window was closed")
        }
    }

    private func refresh() async throws {
        guard !stopped, !rebuilding else { return }
        rebuilding = true
        defer { rebuilding = false }
        let snapshotEpoch = epoch
        let content = try await shareableContent()
        guard !stopped else { return }
        let apps = content.applications.map { app -> AppIdentity in
            let running = NSRunningApplication(processIdentifier: app.processID)
            let path = [running?.bundleURL?.path, running?.executableURL?.path].compactMap { $0 }.joined(separator: " ")
            return AppIdentity(pid: app.processID, name: app.applicationName, bundleID: app.bundleIdentifier, path: path)
        }.sorted { $0.pid < $1.pid }
        let windows = content.windows.compactMap { window -> WindowIdentity? in
            guard let app = window.owningApplication else { return nil }
            return WindowIdentity(windowID: window.windowID, pid: app.processID)
        }
        // Keep the native order for Electron display indices. Audio scope is
        // application/global, not spatially limited to this display's pixels.
        let next = try CapturePlan.make(source: source, windows: windows, apps: apps,
            displayIDs: content.displays.map(\.displayID), policy: policy)
        if let oldOwner = plan?.owner, next.owner != oldOwner {
            gate.close()
            throw HelperError.message("Selected window owning application changed")
        }
        guard snapshotEpoch == epoch else { gate.close(); return }
        let allowedIdentities = apps.filter { next.allowedPIDs.contains($0.pid) }
        if plan == next, identities == allowedIdentities, gate.permits(token) { return }

        gate.close()
        if let previous = stream {
            // Token is invalidated before stop. Delayed delegate callbacks from
            // this stream cannot affect a replacement stream.
            stream = nil; sink = nil; token = UUID()
            try await previous.stopCapture()
        }
        guard !stopped, snapshotEpoch == epoch else { return }
        guard let display = content.displays.first(where: { $0.displayID == next.displayID }) else {
            throw HelperError.message("Selected display disappeared")
        }
        let included = content.applications.filter { next.allowedPIDs.contains($0.processID) }
        guard !included.isEmpty, included.count == next.allowedPIDs.count else {
            throw HelperError.message("Application allowlist changed during configuration")
        }
        // Intentionally use an INCLUSION snapshot, NOT a live display exclusion
        // filter. A newly launched Discord process is never in this snapshot,
        // even before NSWorkspace delivers its launch notification.
        let filter = SCContentFilter(display: display, including: included, exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.width = 2; config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.queueDepth = 3; config.showsCursor = false
        config.capturesAudio = true; config.sampleRate = 48000; config.channelCount = 2
        config.excludesCurrentProcessAudio = true
        if #available(macOS 15.0, *) { config.captureMicrophone = false }
        let freshToken = UUID()
        token = freshToken
        let output = AudioSink(token: freshToken, gate: gate, writer: writer) { [weak self] failedToken, error in
            Task { @MainActor [weak self] in
                guard let self, self.token == failedToken, !self.stopped else { return }
                await self.finish(error: error)
            }
        }
        let fresh = SCStream(filter: filter, configuration: config, delegate: output)
        try fresh.addStreamOutput(output, type: .audio, sampleHandlerQueue: queue)
        // Required by ScreenCaptureKit on some OS versions; discard all video.
        try fresh.addStreamOutput(output, type: .screen, sampleHandlerQueue: queue)
        stream = fresh; sink = output
        try await fresh.startCapture()
        guard !stopped else { return }
        // Do not release buffered samples if a process lifecycle event raced
        // shareable-content enumeration or stream start. Rebuild next tick.
        guard snapshotEpoch == epoch else { gate.close(); return }
        plan = next; identities = allowedIdentities
        try verifyWindowLifetime()
        if !sentReady {
            status(["type": "ready", "sampleRate": 48000, "channels": 2, "scope": next.scope])
            sentReady = true
        }
        gate.open(for: freshToken)
    }

    func finish(error: Error?) async {
        guard !stopped else { return }
        stopped = true; gate.close()
        monitor?.cancel(); stdinSource?.cancel()
        for source in signalSources { source.cancel() }
        for observer in observers { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        if let error { status(["type": "error", "message": error.localizedDescription]) }
        let code: Int32 = error == nil ? 0 : 1
        // A broken system capture service must not leave a child alive forever.
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { Darwin.exit(code) }
        if let stream { try? await stream.stopCapture() }
        Darwin.exit(code)
    }
}
