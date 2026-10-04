#!/usr/bin/env python3
"""ONECLICK sandbox port bridge.

The host publishes exactly one container port (8080). Apps listen on whatever port they like,
often on 127.0.0.1 only. This bridge listens on 0.0.0.0:8080 and, for every accepted connection,
looks at /proc/net/tcp{,6} to find the port the app is listening on and pipes the connection to it.
If nothing is listening yet the connection is closed immediately, which is what the host's
readiness probe relies on.
"""
import ipaddress
import os
import socket
import threading

BRIDGE_PORT = int(os.environ.get("SANDBOX_BRIDGE_PORT", "8080"))
PREFERRED = [3000, 5173, 8000, 5000, 8501, 4200, 4321, 3001, 8081, 7860, 8888, 9000]
IGNORED = {BRIDGE_PORT, 9229, 9222}


def _decode(addr_hex):
    raw = bytes.fromhex(addr_hex)
    if len(raw) == 4:
        return str(ipaddress.IPv4Address(raw[::-1]))
    if len(raw) == 16:
        fixed = b"".join(raw[i:i + 4][::-1] for i in range(0, 16, 4))
        ip = ipaddress.IPv6Address(fixed)
        return str(ip.ipv4_mapped) if ip.ipv4_mapped else str(ip)
    raise ValueError("bad address")


def listeners():
    """Return {port: [bound addresses]} for every TCP socket in LISTEN state."""
    found = {}
    for path in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            f = open(path)
        except OSError:
            continue
        with f:
            next(f, None)
            for line in f:
                parts = line.split()
                if len(parts) < 4 or parts[3] != "0A":
                    continue
                try:
                    host_hex, port_hex = parts[1].split(":")
                    host = _decode(host_hex)
                    port = int(port_hex, 16)
                except ValueError:
                    continue
                found.setdefault(port, []).append(host)
    return found


def choose_port(found):
    ports = [p for p in found if p not in IGNORED and p >= 1]
    env_port = os.environ.get("PORT", "")
    if env_port.isdigit() and int(env_port) in ports:
        return int(env_port)
    for p in PREFERRED:
        if p in ports:
            return p
    return min(ports) if ports else None


def targets_for(hosts):
    out = []
    for h in hosts:
        if h in ("0.0.0.0", "::"):
            out += ["127.0.0.1", "::1"]
        else:
            out.append(h)
    return list(dict.fromkeys(out))


def pipe(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def handle(client):
    upstream = None
    try:
        found = listeners()
        port = choose_port(found)
        if port is not None:
            for host in targets_for(found[port]):
                try:
                    upstream = socket.create_connection((host, port), timeout=5)
                    break
                except OSError:
                    continue
        if upstream is None:
            return
        upstream.settimeout(None)
        client.settimeout(None)
        t = threading.Thread(target=pipe, args=(upstream, client), daemon=True)
        t.start()
        pipe(client, upstream)
        t.join(timeout=60)
    finally:
        for s in (client, upstream):
            if s is not None:
                try:
                    s.close()
                except OSError:
                    pass


def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("0.0.0.0", BRIDGE_PORT))
    srv.listen(128)
    print("[bridge] listening on :%d" % BRIDGE_PORT, flush=True)
    while True:
        client, _ = srv.accept()
        threading.Thread(target=handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
