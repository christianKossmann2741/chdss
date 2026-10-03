import Foundation
import Darwin

final class PCMWriter {
    private let fd: Int32
    private let gate: CaptureGate
    init(fd: Int32, gate: CaptureGate) throws {
        self.fd = fd; self.gate = gate
        let flags = fcntl(fd, F_GETFL)
        guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 else {
            throw HelperError.message("Cannot configure nonblocking PCM output")
        }
    }
    func write(_ data: Data, token: UUID) throws {
        guard data.count % 8 == 0 else { throw HelperError.message("Misaligned PCM output") }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            // macOS PIPE_BUF is at least 512; each nonblocking pipe write is
            // atomic. Drop complete chunks under backpressure, never partial frames.
            while offset < bytes.count {
                let count = min(512, bytes.count - offset)
                let accepted: Bool? = try gate.withPermission(token) {
                    var n: Int
                    repeat { n = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), count) } while n < 0 && errno == EINTR
                    if n == count { return true }
                    if n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { return false }
                    throw HelperError.message("PCM output pipe closed or write failed (errno \(errno))")
                }
                guard accepted == true else { return }
                offset += count
            }
        }
    }
}
