#!/usr/bin/env python3
"""Transfer files and run commands through Runpod's PTY-only SSH proxy."""

from __future__ import annotations

import argparse
import base64
import hashlib
import os
from pathlib import Path
import re
import shlex
import sys
import time
import uuid

import paramiko


def connect(args):
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        args.host,
        port=args.port,
        username=args.username,
        key_filename=args.identity,
        look_for_keys=False,
        allow_agent=False,
        timeout=30,
        banner_timeout=30,
        auth_timeout=30,
    )
    transport = client.get_transport()
    transport.set_keepalive(15)
    channel = client.invoke_shell(term="xterm", width=200, height=50)
    channel.settimeout(1.0)
    deadline = time.monotonic() + 30
    initial = bytearray()
    while time.monotonic() < deadline and b"]# " not in initial:
        if channel.recv_ready():
            initial.extend(channel.recv(65536))
        else:
            time.sleep(0.1)
    if b"]# " not in initial:
        raise TimeoutError("Runpod proxy shell prompt did not become ready")
    sys.stdout.buffer.write(initial)
    sys.stdout.buffer.flush()
    channel.sendall("stty -echo\n")
    time.sleep(0.5)
    while channel.recv_ready():
        sys.stdout.buffer.write(channel.recv(65536))
    sys.stdout.buffer.flush()
    return client, channel


def run_command(channel, command: str, timeout: int) -> int:
    token = f"__KILN_RC_{uuid.uuid4().hex}__"
    wrapped = f"bash -lc {shlex.quote(command)}; rc=$?; printf '\\n{token}%s\\n' \"$rc\"\n"
    channel.sendall(wrapped)
    deadline = time.monotonic() + timeout
    pending = bytearray()
    pattern = re.compile(re.escape(token.encode()) + rb"(\d+)\r?\n")
    while time.monotonic() < deadline:
        if channel.recv_ready():
            chunk = channel.recv(65536)
            if not chunk:
                raise RuntimeError("SSH proxy channel closed")
            pending.extend(chunk)
            match = pattern.search(pending)
            if match:
                before = pending[: match.start()]
                sys.stdout.buffer.write(before)
                sys.stdout.buffer.flush()
                return int(match.group(1))
            if len(pending) > 256 * 1024:
                keep = len(token) + 32
                sys.stdout.buffer.write(pending[:-keep])
                sys.stdout.buffer.flush()
                del pending[:-keep]
        else:
            time.sleep(0.1)
    raise TimeoutError(f"remote command exceeded {timeout} seconds")


def upload(channel, local: Path, remote: str, timeout: int) -> None:
    marker = f"KILN_UPLOAD_{uuid.uuid4().hex}"
    temporary = f"{remote}.partial"
    channel.sendall(f"base64 -d > {shlex.quote(temporary)} <<'{marker}'\n")
    with local.open("rb") as source:
        while chunk := source.read(57 * 1024):
            channel.sendall(base64.b64encode(chunk) + b"\n")
    channel.sendall(f"{marker}\n")
    digest = hashlib.sha256(local.read_bytes()).hexdigest()
    command = (
        f"actual=$(sha256sum {shlex.quote(temporary)} | awk '{{print $1}}'); "
        f"test \"$actual\" = {shlex.quote(digest)} && mv {shlex.quote(temporary)} {shlex.quote(remote)}"
    )
    rc = run_command(channel, command, timeout)
    if rc != 0:
        raise RuntimeError(f"uploaded file failed digest validation: {local}")
    print(f"uploaded={local} remote={remote} sha256={digest}", flush=True)


def download(channel, remote: str, local: Path, timeout: int) -> None:
    begin = f"__KILN_DOWNLOAD_BEGIN_{uuid.uuid4().hex}__"
    end = f"__KILN_DOWNLOAD_END_{uuid.uuid4().hex}__"
    channel.sendall(
        f"printf '{begin}'; base64 -w 0 {shlex.quote(remote)}; printf '{end}\\n'\n"
    )
    deadline = time.monotonic() + timeout
    data = bytearray()
    while time.monotonic() < deadline:
        if channel.recv_ready():
            chunk = channel.recv(1024 * 1024)
            if not chunk:
                raise RuntimeError("SSH proxy channel closed")
            data.extend(chunk)
            start = data.find(begin.encode())
            finish = data.find(end.encode(), start + len(begin)) if start >= 0 else -1
            if start >= 0 and finish >= 0:
                encoded = bytes(data[start + len(begin):finish]).replace(b"\r", b"").replace(b"\n", b"")
                local.parent.mkdir(parents=True, exist_ok=True)
                local.write_bytes(base64.b64decode(encoded, validate=True))
                print(f"downloaded={remote} local={local} sha256={hashlib.sha256(local.read_bytes()).hexdigest()}", flush=True)
                return
        else:
            time.sleep(0.1)
    raise TimeoutError(f"download exceeded {timeout} seconds")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="ssh.runpod.io")
    parser.add_argument("--port", type=int, default=22)
    parser.add_argument("--username", required=True)
    parser.add_argument("--identity", required=True)
    subparsers = parser.add_subparsers(dest="action", required=True)
    execute = subparsers.add_parser("exec")
    execute.add_argument("command")
    execute.add_argument("--timeout", type=int, default=7200)
    send = subparsers.add_parser("upload")
    send.add_argument("local", type=Path)
    send.add_argument("remote")
    send.add_argument("--timeout", type=int, default=1800)
    receive = subparsers.add_parser("download")
    receive.add_argument("remote")
    receive.add_argument("local", type=Path)
    receive.add_argument("--timeout", type=int, default=3600)
    args = parser.parse_args()
    client, channel = connect(args)
    try:
        if args.action == "exec":
            raise SystemExit(run_command(channel, args.command, args.timeout))
        if args.action == "upload":
            upload(channel, args.local.resolve(), args.remote, args.timeout)
        else:
            download(channel, args.remote, args.local.resolve(), args.timeout)
    finally:
        channel.close()
        client.close()


if __name__ == "__main__":
    main()
