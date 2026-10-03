#!/usr/bin/env python3
"""Native CLI integration tests. Does not grant or reset macOS permissions."""
import json
import pathlib
import selectors
import signal
import time
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
BINARY = ROOT / 'native/bin/darwin-arm64/chdss-audio'

class NativeCLITests(unittest.TestCase):
    def test_capture_starts_filtered_or_fails_closed_for_permission(self):
        child = subprocess.Popen([str(BINARY), '--source', 'screen:0:0'], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            selector = selectors.DefaultSelector()
            selector.register(child.stderr, selectors.EVENT_READ)
            self.assertTrue(selector.select(15), 'helper startup timed out')
            event = json.loads(child.stderr.readline())
            if event['type'] == 'error':
                self.assertIn('permission', event['message'].lower())
                child.wait(timeout=5)
                self.assertNotEqual(child.returncode, 0)
                self.assertEqual(child.stdout.read(), b'')
                return
            self.assertEqual(event, {'type': 'ready', 'sampleRate': 48000, 'channels': 2, 'scope': 'display'})
            child.stdin.close()
            child.wait(timeout=5)
            self.assertEqual(child.returncode, 0)
            self.assertEqual(len(child.stdout.read()) % 8, 0)
        finally:
            if child.poll() is None: child.kill(); child.wait()
            for stream in [child.stdin, child.stdout, child.stderr]: stream.close()

    def test_list_is_real_windows_or_explicit_permission_error(self):
        result = subprocess.run([str(BINARY), '--list'], input=b'', capture_output=True, timeout=30)
        if result.returncode:
            self.assertEqual(result.stdout, b'')
            error = json.loads(result.stderr)
            self.assertEqual(error['type'], 'error')
            self.assertIn('permission', error['message'].lower())
            return
        self.assertEqual(result.stderr, b'')
        windows = json.loads(result.stdout)
        self.assertIsInstance(windows, list)
        for window in windows:
            self.assertEqual(set(window), {'windowId', 'pid', 'name', 'bundleId'})
            self.assertIsInstance(window['windowId'], int)
            self.assertIsInstance(window['pid'], int)
            self.assertIsInstance(window['name'], str)
            self.assertIsInstance(window['bundleId'], str)

    def test_invalid_arguments_are_json_errors_with_no_pcm(self):
        self.assertTrue(BINARY.is_file(), 'native helper executable is missing')
        for args in [[], ['--source'], ['--source', 'window:0:0'], ['--source', 'screen:bad:0'], ['--bogus'], ['--list', '--source', 'screen:0:0']]:
            with self.subTest(args=args):
                result = subprocess.run([str(BINARY), *args], input=b'', capture_output=True, timeout=15)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b'')
                status = json.loads(result.stderr)
                self.assertEqual(status['type'], 'error')
                self.assertIsInstance(status['message'], str)

if __name__ == '__main__':
    unittest.main(verbosity=2)
