"""Read-only real-PTY checks, including a checkout with no installed Clack.
Run from any directory: python3 apps/cli/test/terminal-smoke.py
"""
import fcntl
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[3]
TRANSCRIPTS = []


def session(name, entry, args, steps, expected=0, extra_env=None):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 110, 0, 0))
    env = {**os.environ, "TERM": "xterm-256color"}
    env.pop("CI", None)
    env.update(extra_env or {})
    child = subprocess.Popen([shutil.which("node"), str(entry), *args], stdin=slave, stdout=slave, stderr=slave, env=env)
    os.close(slave)
    output = b""
    cursor = 0

    def wait_for(needle):
        nonlocal output, cursor
        deadline = time.monotonic() + 12
        while needle.encode() not in output[cursor:]:
            if time.monotonic() > deadline:
                raise AssertionError(f"{name}: missing {needle!r}: {output.decode(errors='replace')}")
            if select.select([master], [], [], 0.1)[0]:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b""
                if not data:
                    raise AssertionError(f"{name}: exited before {needle!r}")
                output += data
        cursor = output.index(needle.encode(), cursor) + len(needle.encode())

    try:
        for needle, keys in steps:
            wait_for(needle)
            if keys:
                os.write(master, keys.encode())
        deadline = time.monotonic() + 12
        while child.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    output += os.read(master, 65536)
                except OSError:
                    break
        assert child.poll() is not None, (name, output.decode(errors="replace"))
        while select.select([master], [], [], 0.1)[0]:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            output += data
        assert child.returncode == expected, (name, child.returncode, output)
        clean = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output.decode()).replace("\r", "")
        assert "TEST-HIDDEN-PASSWORD" not in clean, name
        TRANSCRIPTS.append(f"## {name} (exit {expected})\n\n```text\n{clean}\n```\n")
        print(f"PASS {name}")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)


main = ROOT / "apps/cli/src/main.ts"
with tempfile.TemporaryDirectory(prefix="rei-cli-smoke-") as directory:
    fixture = Path(directory)
    shutil.copytree(ROOT / "apps/cli/src", fixture / "apps/cli/src")
    fake_docker = fixture / "docker"
    fake_docker.write_text("#!/bin/sh\nexit 127\n")
    fake_docker.chmod(0o755)
    session("Guided setup preflight failure", main, ["setup"], [("Setup stopped", "")], expected=1,
            extra_env={"PATH": str(fixture) + os.pathsep + os.environ["PATH"]})
out = ROOT / ".local/cli-clack/terminal.md"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text("# Terminal smoke checks\n\n" + "\n".join(TRANSCRIPTS))
