#!/usr/bin/env python3
"""Cross-build real Windows x64 executables; first run policy tests on this host."""
import hashlib
import json
import os
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def run(*args):
    subprocess.run([str(arg) for arg in args], check=True)


def main():
    toolchain = os.environ.get("LLVM_MINGW")
    if not toolchain:
        raise RuntimeError("Set LLVM_MINGW to an extracted llvm-mingw toolchain")
    run("cmake", "-S", HERE, "-B", HERE / "build-host", "-DCMAKE_BUILD_TYPE=Release")
    run("cmake", "--build", HERE / "build-host", "--parallel")
    run("ctest", "--test-dir", HERE / "build-host", "--output-on-failure", "--output-junit", HERE / "build-host/policy-tests.xml")
    run("cmake", "-S", HERE, "-B", HERE / "build-cross", "-DCMAKE_BUILD_TYPE=Release", f"-DCMAKE_TOOLCHAIN_FILE={HERE / 'toolchain-llvm-mingw.cmake'}")
    run("cmake", "--build", HERE / "build-cross", "--parallel")
    exe = ROOT / "native/bin/win32-x64/chdss-audio.exe"
    run(pathlib.Path(toolchain) / "bin/llvm-readobj", "--file-headers", "--coff-imports", exe)
    print(json.dumps({"type": "build-result", "success": True, "architecture": "x64", "runtime": "static", "path": str(exe), "bytes": exe.stat().st_size, "sha256": hashlib.sha256(exe.read_bytes()).hexdigest(), "policyTests": "passed-on-host", "nativeAudioIsolation": "not-run"}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"type": "build-result", "success": False, "message": str(error)}))
        sys.exit(1)
