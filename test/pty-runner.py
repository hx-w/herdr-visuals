"""Run the real viewer in a sized PTY; stdin carries test key/resize messages."""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 90, 0, 0))
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)

def stop(*_):
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)

signal.signal(signal.SIGTERM, stop)
pending = b''
while child.poll() is None:
    ready, _, _ = select.select([master, sys.stdin.buffer], [], [], 0.2)
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    if sys.stdin.buffer in ready:
        data = os.read(sys.stdin.fileno(), 65536)
        if not data:
            stop()
            break
        pending += data
        while b'\n' in pending:
            line, pending = pending.split(b'\n', 1)
            command = json.loads(line)
            if 'keys' in command:
                os.write(master, command['keys'].encode())
            if 'resize' in command:
                cols, rows = command['resize']
                fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                os.killpg(child.pid, signal.SIGWINCH)
try:
    sys.exit(child.wait(timeout=20))
except subprocess.TimeoutExpired:
    os.killpg(child.pid, signal.SIGKILL)
    sys.exit(1)
