import Foundation
import Darwin

@main
struct WriterTests {
    static func main() throws {
        signal(SIGPIPE, SIG_IGN)
        var descriptors: [Int32] = [0, 0]
        assert(pipe(&descriptors) == 0)
        defer { Darwin.close(descriptors[0]); Darwin.close(descriptors[1]) }
        let gate = CaptureGate(), token = UUID()
        let writer = try PCMWriter(fd: descriptors[1], gate: gate)
        let data = Data(repeating: 42, count: 16)
        try writer.write(data, token: token) // gated off
        gate.open(for: token)
        try writer.write(data, token: token)
        gate.close()
        try writer.write(data, token: token)
        var readBytes = [UInt8](repeating: 0, count: 16)
        assert(Darwin.read(descriptors[0], &readBytes, 16) == 16)
        assert(Data(readBytes) == data)
        gate.open(for: token)
        let start = Date()
        for _ in 0..<10000 { try writer.write(Data(repeating: 1, count: 1024), token: token) }
        assert(Date().timeIntervalSince(start) < 5, "Full parent pipe must not block shutdown")
        _ = fcntl(descriptors[0], F_SETFL, O_NONBLOCK)
        var total = 0, chunk = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = Darwin.read(descriptors[0], &chunk, chunk.count)
            if n <= 0 { break }; total += n
        }
        assert(total % 8 == 0, "Backpressure may drop whole frames, not corrupt frame alignment")
        do { try writer.write(Data(repeating: 0, count: 3), token: token); fatalError("Misaligned PCM accepted") } catch {}
        print("PASS gated atomic PCM pipe writes, bounded backpressure, frame alignment")
    }
}
