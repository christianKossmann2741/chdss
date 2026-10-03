import Foundation
import CoreAudio
import CoreMedia

@main
struct PCMTests {
    static func main() throws {
        var format = AudioStreamBasicDescription(mSampleRate: 48000, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 8, mFramesPerPacket: 1, mBytesPerFrame: 8,
            mChannelsPerFrame: 2, mBitsPerChannel: 32, mReserved: 0)
        let expected: [Float] = [0.25, -0.5, 0.75, -1]
        let packed = try expected.withUnsafeBytes { bytes in
            try PCMCodec.encode(format: format, buffers: [AudioBuffer(mNumberChannels: 2,
                mDataByteSize: UInt32(bytes.count), mData: UnsafeMutableRawPointer(mutating: bytes.baseAddress))], frames: 2)
        }
        assert(packed == expected.withUnsafeBytes { Data($0) })
        format.mFormatFlags |= kAudioFormatFlagIsNonInterleaved
        format.mBytesPerFrame = 4; format.mBytesPerPacket = 4
        let left: [Float] = [0.25, 0.75], right: [Float] = [-0.5, -1]
        let planar = try left.withUnsafeBytes { l in
            try right.withUnsafeBytes { r in
                try PCMCodec.encode(format: format, buffers: [
                    AudioBuffer(mNumberChannels: 1, mDataByteSize: 8, mData: UnsafeMutableRawPointer(mutating: l.baseAddress)),
                    AudioBuffer(mNumberChannels: 1, mDataByteSize: 8, mData: UnsafeMutableRawPointer(mutating: r.baseAddress))], frames: 2)
            }
        }
        assert(planar == packed, "Planar stereo must be interleaved L/R as f32le")
        for bad in [44100.0, 96000.0] {
            format.mSampleRate = bad
            do { _ = try PCMCodec.encode(format: format, buffers: [], frames: 2); fatalError("Wrong rate accepted") } catch {}
        }
        format.mSampleRate = 48000
        do { _ = try PCMCodec.encode(format: format, buffers: [], frames: 2); fatalError("Missing data accepted") } catch {}
        print("PASS PCM packed/planar conversion and fail-closed invalid format")
        format.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked
        format.mBytesPerFrame = 8; format.mBytesPerPacket = 8
        var description: CMAudioFormatDescription?
        assert(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &format,
            layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil,
            formatDescriptionOut: &description) == noErr)
        var block: CMBlockBuffer?
        assert(CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil,
            blockLength: packed.count, blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
            offsetToData: 0, dataLength: packed.count, flags: 0, blockBufferOut: &block) == noErr)
        packed.withUnsafeBytes { bytes in
            assert(CMBlockBufferReplaceDataBytes(with: bytes.baseAddress!, blockBuffer: block!,
                offsetIntoDestination: 0, dataLength: bytes.count) == noErr)
        }
        var sample: CMSampleBuffer?
        assert(CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: kCFAllocatorDefault,
            dataBuffer: block!, formatDescription: description!, sampleCount: 2,
            presentationTimeStamp: CMTime(value: 0, timescale: 48000), packetDescriptions: nil,
            sampleBufferOut: &sample) == noErr)
        let decoded = try PCMCodec.read(sample!)
        assert(decoded == packed)
        print("PASS CoreMedia sample-buffer extraction")
    }
}
