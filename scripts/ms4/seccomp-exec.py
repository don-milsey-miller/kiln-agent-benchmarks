#!/usr/bin/env python3
"""Exec a command with a permanent Unix-domain-socket-only seccomp policy."""

from __future__ import annotations

import ctypes
import errno
import os
import platform
import sys


class SockFilter(ctypes.Structure):
    _fields_ = [
        ("code", ctypes.c_ushort),
        ("jt", ctypes.c_ubyte),
        ("jf", ctypes.c_ubyte),
        ("k", ctypes.c_uint32),
    ]


class SockFprog(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(SockFilter))]


BPF_LD_W_ABS = 0x20
BPF_JMP_JEQ_K = 0x15
BPF_RET_K = 0x06
SECCOMP_RET_KILL_PROCESS = 0x80000000
SECCOMP_RET_ALLOW = 0x7FFF0000
SECCOMP_RET_ERRNO = 0x00050000
AUDIT_ARCH_X86_64 = 0xC000003E
SYS_SOCKET_X86_64 = 41
AF_UNIX = 1
PR_SET_NO_NEW_PRIVS = 38
PR_SET_SECCOMP = 22
SECCOMP_MODE_FILTER = 2


def statement(code: int, k: int, jt: int = 0, jf: int = 0) -> SockFilter:
    return SockFilter(code=code, jt=jt, jf=jf, k=k)


def install_filter() -> None:
    if platform.machine() not in {"x86_64", "AMD64"}:
        raise RuntimeError(f"unsupported architecture: {platform.machine()}")

    # seccomp_data offsets: nr=0, arch=4, args[0]=16. Every syscall is
    # allowed except socket(domain, ...), where only AF_UNIX is permitted.
    rules = (
        SockFilter * 9
    )(
        statement(BPF_LD_W_ABS, 4),
        statement(BPF_JMP_JEQ_K, AUDIT_ARCH_X86_64, jt=1),
        statement(BPF_RET_K, SECCOMP_RET_KILL_PROCESS),
        statement(BPF_LD_W_ABS, 0),
        statement(BPF_JMP_JEQ_K, SYS_SOCKET_X86_64, jf=3),
        statement(BPF_LD_W_ABS, 16),
        statement(BPF_JMP_JEQ_K, AF_UNIX, jt=1),
        statement(BPF_RET_K, SECCOMP_RET_ERRNO | errno.EPERM),
        statement(BPF_RET_K, SECCOMP_RET_ALLOW),
    )
    program = SockFprog(len=len(rules), filter=rules)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "PR_SET_NO_NEW_PRIVS failed")
    if libc.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ctypes.byref(program)) != 0:
        raise OSError(ctypes.get_errno(), "PR_SET_SECCOMP failed")


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: seccomp-exec.py COMMAND [ARG ...]")
    install_filter()
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)


if __name__ == "__main__":
    main()
