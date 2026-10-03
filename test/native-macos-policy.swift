import Foundation

@main
struct PolicyTests {
    static func main() throws {
        let window = try CaptureSource.parse("window:123:0")
        assert(window == .window(123))
        let display = try CaptureSource.parse("screen:0:0")
        assert(display == .display(0))
        for invalid in ["", "window:0:0", "window:-1:0", "window:123", "screen:foo:0", "screen:0:1", "window:4294967296:0", "window: 1:0", "system"] {
            do {
                _ = try CaptureSource.parse(invalid)
                fatalError("Invalid source accepted: \(invalid)")
            } catch {}
        }
        print("PASS source parsing")
        let blocked = [
            AppIdentity(pid: 1, name: "Discord", bundleID: "com.hnc.Discord", path: ""),
            AppIdentity(pid: 2, name: "Discord Canary", bundleID: "com.hnc.DiscordCanary", path: ""),
            AppIdentity(pid: 3, name: "Discord PTB", bundleID: "com.hnc.DiscordPTB", path: ""),
            AppIdentity(pid: 4, name: "helper", bundleID: "", path: "/Applications/Discord Development.app/Contents/Frameworks/helper"),
            AppIdentity(pid: 5, name: "CHDSS Helper", bundleID: "com.christiankossmann.chdss.helper", path: ""),
            AppIdentity(pid: 6, name: "electron", bundleID: "", path: "/Users/test/chdss/node_modules/electron/dist/Electron.app"),
            AppIdentity(pid: 99, name: "audio", bundleID: "", path: "")
        ]
        let allowed = AppIdentity(pid: 7, name: "Chrome", bundleID: "com.google.Chrome", path: "/Applications/Chrome.app")
        let policy = ExclusionPolicy(selfPID: 99, ancestorPIDs: [100])
        for app in blocked { assert(policy.excludes(app), "Leaking \(app)") }
        assert(policy.excludes(AppIdentity(pid: 100, name: "Electron", bundleID: "", path: "")))
        assert(!policy.excludes(allowed), "Browser audio is application-scoped, not tab-scoped")
        assert(policy.allowedPIDs(blocked + [allowed]) == [7])
        print("PASS Discord variants, CHDSS and ancestor exclusions; allowlist")
        let owner = WindowIdentity(windowID: 123, pid: 7)
        assert(owner.isPresent(in: [WindowIdentity(windowID: 123, pid: 7)]))
        assert(!owner.isPresent(in: []))
        assert(!owner.isPresent(in: [WindowIdentity(windowID: 123, pid: 8)]))
        let gate = CaptureGate()
        let old = UUID(), fresh = UUID()
        assert(!gate.permits(old))
        gate.open(for: old)
        assert(gate.permits(old))
        gate.close()
        assert(!gate.permits(old))
        gate.open(for: fresh)
        assert(!gate.permits(old), "Old stream callbacks must remain discarded")
        assert(gate.permits(fresh))
        gate.close(for: old)
        assert(gate.permits(fresh), "Late stopped callbacks must not close a replacement stream")
        gate.close(for: fresh)
        assert(!gate.permits(fresh))
        print("PASS owner lifetime and fail-closed stream generation gate")
        let plan = try CapturePlan.make(source: .display(0), windows: [owner],
            apps: blocked + [allowed], displayIDs: [42, 43], policy: policy)
        assert(plan.displayID == 42 && plan.allowedPIDs == [7] && plan.scope == "display")
        let indexed = try CapturePlan.make(source: .display(1), windows: [owner],
            apps: blocked + [allowed], displayIDs: [42, 43], policy: policy)
        assert(indexed.displayID == 43)
        let nativeID = try CapturePlan.make(source: .display(43), windows: [owner],
            apps: [allowed], displayIDs: [42, 43], policy: policy)
        assert(nativeID.displayID == 43)
        let appPlan = try CapturePlan.make(source: .window(123), windows: [owner],
            apps: [allowed], displayIDs: [42], policy: policy)
        assert(appPlan.owner == owner && appPlan.scope == "application" && appPlan.allowedPIDs == [7])
        let discordPlan = try CapturePlan.make(source: .window(1), windows: [WindowIdentity(windowID: 1, pid: 1)],
            apps: blocked, displayIDs: [42], policy: policy)
        assert(discordPlan.allowedPIDs == [1], "Explicit Discord window selection is application-scoped, not display exclusion")
        for source in [CaptureSource.window(999), .window(99), .display(999)] {
            do {
                _ = try CapturePlan.make(source: source, windows: [owner, WindowIdentity(windowID: 99, pid: 99)],
                    apps: blocked + [allowed], displayIDs: [42], policy: policy)
                fatalError("Unsafe or missing source accepted")
            } catch {}
        }
        do {
            _ = try CapturePlan.make(source: .display(0), windows: [], apps: blocked, displayIDs: [42], policy: policy)
            fatalError("Empty allowlist must not become unfiltered capture")
        } catch {}
        print("PASS display index/native-ID mapping and application-scoped fail-closed plans")
    }
}
