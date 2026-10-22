#!/usr/bin/env python3
"""Bidirectional Unix/TCP relay used to isolate paid benchmark agents."""

from __future__ import annotations

import argparse
import os
import selectors
import socket
import threading


def pump(left: socket.socket, right: socket.socket) -> None:
    selector = selectors.DefaultSelector()
    selector.register(left, selectors.EVENT_READ, right)
    selector.register(right, selectors.EVENT_READ, left)
    try:
        while True:
            events = selector.select()
            for key, _ in events:
                source = key.fileobj
                target = key.data
                data = source.recv(1024 * 1024)
                if not data:
                    return
                target.sendall(data)
    finally:
        selector.close()
        left.close()
        right.close()


def serve(listener: socket.socket, connector) -> None:
    while True:
        client, _ = listener.accept()
        try:
            upstream = connector()
        except Exception:
            client.close()
            continue
        threading.Thread(target=pump, args=(client, upstream), daemon=True).start()


def unix_to_tcp(path: str, host: str, port: int) -> None:
    if os.path.exists(path):
        os.unlink(path)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(path)
    listener.listen(128)
    print(f"unix_to_tcp_ready={path}->{host}:{port}", flush=True)
    serve(listener, lambda: socket.create_connection((host, port), timeout=30))


def tcp_to_unix(host: str, port: int, path: str) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((host, port))
    listener.listen(128)
    print(f"tcp_to_unix_ready={host}:{port}->{path}", flush=True)
    serve(listener, lambda: socket.socket(socket.AF_UNIX, socket.SOCK_STREAM))


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="mode", required=True)
    outgoing = subparsers.add_parser("unix-to-tcp")
    outgoing.add_argument("path")
    outgoing.add_argument("host")
    outgoing.add_argument("port", type=int)
    incoming = subparsers.add_parser("tcp-to-unix")
    incoming.add_argument("host")
    incoming.add_argument("port", type=int)
    incoming.add_argument("path")
    args = parser.parse_args()
    if args.mode == "unix-to-tcp":
        unix_to_tcp(args.path, args.host, args.port)
    else:
        original = socket.socket

        def connector() -> socket.socket:
            value = original(socket.AF_UNIX, socket.SOCK_STREAM)
            value.connect(args.path)
            return value

        listener = original(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind((args.host, args.port))
        listener.listen(128)
        print(f"tcp_to_unix_ready={args.host}:{args.port}->{args.path}", flush=True)
        serve(listener, connector)


if __name__ == "__main__":
    main()
