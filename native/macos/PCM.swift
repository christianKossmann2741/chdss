import Foundation
import CoreAudio
import CoreMedia

// ScreenCaptureKit is configured for this exact format. Unexpected formats
// terminate capture, rather than emitting mislabelled PCM or falling back.
enum PCMCodec {
    static func read(_ sample: CMSampleBuffer) throws -> Data {
        guard CMSampleBufferIsValid(sample), CMSampleBufferDataIsReady(sample),
              let description = CMSampleBufferGetFormatDescription(sample),
              let format = CMAudioFormatDescriptionGetStreamBasicDescription(description) else {
            throw HelperError.message("Invalid audio sample buffer")
        }
        var required = 0
        var retained: CMBlockBuffer?
        let first = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample,
            bufferListSizeNeededOut: &required, bufferListOut: nil, bufferListSize: 0,
            blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment), blockBufferOut: &retained)
        guard first == noErr, required >= MemoryLayout<AudioBufferList>.size else {
            throw HelperError.message("Cannot determine capture audio buffer size (\(first))")
        }
        let storage = UnsafeMutableRawPointer.allocate(byteCount: required, alignment: 16)
        defer { storage.deallocate() }
        let list = storage.bindMemory(to: AudioBufferList.self, capacity: 1)
        let result = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample,
            bufferListSizeNeededOut: nil, bufferListOut: list, bufferListSize: required,
            blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment), blockBufferOut: &retained)
        guard result == noErr else { throw HelperError.message("Cannot read capture audio (\(result))") }
        return try withExtendedLifetime(retained) {
            try encode(format: format.pointee, buffers: Array(UnsafeMutableAudioBufferListPointer(list)),
                       frames: CMSampleBufferGetNumSamples(sample))
        }
    }

    static func encode(format: AudioStreamBasicDescription, buffers: [AudioBuffer], frames: Int) throws -> Data {
        guard format.mSampleRate == 48000, format.mChannelsPerFrame == 2,
              format.mFormatID == kAudioFormatLinearPCM, format.mBitsPerChannel == 32,
              format.mFormatFlags & kAudioFormatFlagIsFloat != 0,
              format.mFormatFlags & kAudioFormatFlagIsBigEndian == 0,
              frames > 0, frames <= 48000 else {
            throw HelperError.message("Unsupported capture PCM format (expected 48kHz stereo float32 little-endian)")
        }
        let planar = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        if !planar {
            guard buffers.count == 1, buffers[0].mNumberChannels == 2,
                  format.mBytesPerFrame == 8, Int(buffers[0].mDataByteSize) >= frames * 8,
                  let data = buffers[0].mData else {
                throw HelperError.message("Invalid interleaved capture audio buffer")
            }
            return Data(bytes: data, count: frames * 8)
        }
        guard buffers.count == 2, format.mBytesPerFrame == 4,
              buffers.allSatisfy({ $0.mNumberChannels == 1 && Int($0.mDataByteSize) >= frames * 4 && $0.mData != nil }) else {
            throw HelperError.message("Invalid planar capture audio buffer")
        }
        let left = buffers[0].mData!.assumingMemoryBound(to: Float.self)
        let right = buffers[1].mData!.assumingMemoryBound(to: Float.self)
        var pcm = [Float](repeating: 0, count: frames * 2)
        for i in 0..<frames { pcm[i * 2] = left[i]; pcm[i * 2 + 1] = right[i] }
        return pcm.withUnsafeBytes { Data($0) }
    }
}
