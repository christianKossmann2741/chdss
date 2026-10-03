"""Real WASAPI isolation acceptance test, Python stdlib only. Requires Windows/audio.
Run: py test/native-windows-isolation.py --bin-dir native/bin/win32-x64
"""
import argparse
import array
import json
import math
import os
import pathlib
import queue
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import unittest

BIN = pathlib.Path(__file__).resolve().parents[1] / "native/bin/win32-x64"


def amplitude(samples, hz):
    # Correlation at the known frequency; independent sine phases handled by magnitude.
    data = samples[::2]
    if not data:
        return 0.0
    r = sum(x * math.cos(2 * math.pi * hz * i / 48000) for i, x in enumerate(data))
    im = sum(x * math.sin(2 * math.pi * hz * i / 48000) for i, x in enumerate(data))
    return 2 * math.hypot(r, im) / len(data)


class Capture:
    def __init__(self, source):
        self.proc = subprocess.Popen([str(BIN / "chdss-audio.exe"), "--source", source],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        self.q = queue.Queue()
        self.errors = []
        self.ready = threading.Event()
        def output():
            while True:
                data = self.proc.stdout.read(480 * 8)
                if not data:
                    break
                self.q.put(data)
        def status():
            for line in self.proc.stderr:
                obj = json.loads(line)
                if obj.get("type") == "ready":
                    if obj.get("sampleRate") != 48000 or obj.get("channels") != 2:
                        self.errors.append(obj)
                    self.ready.set()
                elif obj.get("type") == "error":
                    self.errors.append(obj)
                    self.ready.set()
        threading.Thread(target=output, daemon=True).start()
        threading.Thread(target=status, daemon=True).start()
        if not self.ready.wait(15) or self.errors:
            self.stop()
            raise AssertionError(f"Capture activation failed: {self.errors}")

    def samples(self, seconds=1.0):
        # Drop all earlier startup/filter-refresh packets, then sample exact whole blocks.
        time.sleep(0.75)
        while not self.q.empty():
            self.q.get_nowait()
        b = bytearray()
        for _ in range(int(seconds * 100)):
            b.extend(self.q.get(timeout=5))
        data = array.array("f")
        data.frombytes(b)
        assert len(data) % 2 == 0
        assert all(math.isfinite(x) and abs(x) <= 1 for x in data)
        return data

    def stop(self):
        if self.proc.poll() is None:
            self.proc.stdin.close()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
                raise AssertionError("Helper did not exit on stdin EOF")
        if self.errors:
            raise AssertionError(self.errors)
        return self.proc.returncode


@unittest.skipUnless(os.name == "nt", "Requires native Windows >=20348 with a render endpoint")
class NativeIsolation(unittest.TestCase):
    def setUp(self):
        self.assertTrue((BIN / "chdss-audio.exe").is_file(), "Build real helper first")
        self.assertTrue((BIN / "chdss-test-tone.exe").is_file(), "Build test tone fixture first")
        self.temp = tempfile.TemporaryDirectory(prefix="chdss-isolation-")
        self.procs = []
        self.captures = []

    def tearDown(self):
        for c in self.captures:
            if c.proc.poll() is None:
                c.stop()
        for p in reversed(self.procs):
            if p.poll() is None:
                p.terminate()
                p.wait(timeout=5)
        self.temp.cleanup()

    def tone(self, name, hz, *args):
        exe = pathlib.Path(self.temp.name) / name
        if not exe.exists():
            shutil.copyfile(BIN / "chdss-test-tone.exe", exe)
        p = subprocess.Popen([str(exe), str(hz), *args], stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True)
        self.procs.append(p)
        # fixture emits real HWND only after rendering started; check startup deadline.
        result = queue.Queue()
        threading.Thread(target=lambda: result.put(p.stdout.readline()), daemon=True).start()
        line = result.get(timeout=10)
        self.assertTrue(line, f"Tone fixture exited {p.poll()}")
        hwnd = json.loads(line)["windowId"]
        return p, hwnd

    def capture(self, source):
        c = Capture(source)
        self.captures.append(c)
        return c

    def assert_tones(self, samples, present, absent):
        for hz in present:
            self.assertGreater(amplitude(samples, hz), 0.025, f"Missing allowed tone {hz} Hz")
        for hz in absent:
            self.assertLess(amplitude(samples, hz), 0.004, f"Leaked excluded tone {hz} Hz")

    def test_window_includes_audio_sibling_not_unrelated_application(self):
        p, hwnd = self.tone("BrowserFixture.exe", 440, "--child", "660")
        _, other = self.tone("OtherApp.exe", 880)
        windows = json.loads(subprocess.check_output([str(BIN / "chdss-audio.exe"), "--list"]))
        self.assertTrue(any(str(w["windowId"]) == str(hwnd) and w["pid"] == p.pid for w in windows))
        # Use the child window: must resolve to same-image root and include root 440 + sibling/child 660.
        child = next(w for w in windows if w["pid"] != p.pid and w.get("rootPid") == p.pid)
        c = self.capture(f'window:{child["windowId"]}:0')
        self.assert_tones(c.samples(), [440, 660], [880])
        self.assertEqual(c.stop(), 0)

    def test_display_excludes_all_discord_variants_and_chdss_and_refreshes(self):
        self.tone("MusicApp.exe", 440)
        self.tone("Discord.exe", 880, "--child", "990")
        self.tone("DiscordPTB.exe", 1100)
        self.tone("DiscordCanary.exe", 1320)
        self.tone("CHDSS.exe", 1540)
        c = self.capture("screen:0:0")
        self.assert_tones(c.samples(), [440], [880, 990, 1100, 1320, 1540])
        # New allowed app must be included; a new Discord tree must never become an allowed root.
        self.tone("NewPlayer.exe", 660)
        self.tone("Discord.exe", 1760)
        self.assert_tones(c.samples(), [440, 660], [880, 990, 1100, 1320, 1540, 1760])
        self.assertEqual(c.stop(), 0)

    def test_ctrl_break_stops_cleanly(self):
        self.tone("MusicApp.exe", 440)
        c = self.capture("screen:0:0")
        c.proc.send_signal(signal.CTRL_BREAK_EVENT)
        self.assertEqual(c.proc.wait(timeout=5), 0)

    def test_eof_during_startup_stops_without_waiting_for_activation(self):
        start = time.monotonic()
        p = subprocess.run([str(BIN / "chdss-audio.exe"), "--source", "screen:0:0"],
                           input=b"", capture_output=True, timeout=5)
        self.assertEqual(p.returncode, 0)
        self.assertLess(time.monotonic() - start, 5)

    def test_invalid_source_is_json_error_without_pcm(self):
        p = subprocess.run([str(BIN / "chdss-audio.exe"), "--source", "window:0:0"],
                           input=b"", capture_output=True, timeout=10)
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(p.stdout, b"")
        self.assertEqual(json.loads(p.stderr)["type"], "error")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin-dir", type=pathlib.Path)
    parser.add_argument("--require-native", action="store_true", help="Fail if native tests are skipped")
    parser.add_argument("--json-report", type=pathlib.Path)
    args, rest = parser.parse_known_args()
    if args.bin_dir:
        BIN = args.bin_dir.resolve()
    program = unittest.main(argv=[__file__, *rest], verbosity=2, exit=False)
    result = program.result
    native_verified = result.wasSuccessful() and result.testsRun > 0 and not result.skipped
    report = {"type": "test-result", "suite": "windows-audio-isolation", "success": result.wasSuccessful(),
              "testsRun": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
              "skipped": len(result.skipped), "nativeAudioVerified": native_verified}
    encoded = json.dumps(report)
    print(encoded)
    if args.json_report:
        args.json_report.parent.mkdir(parents=True, exist_ok=True)
        args.json_report.write_text(encoded + "\n", encoding="utf-8")
    raise SystemExit(0 if result.wasSuccessful() and (not args.require_native or native_verified) else 1)
