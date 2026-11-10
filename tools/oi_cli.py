#!/usr/bin/env python3
"""Physical serial CANopen CLI. Requires pyserial; no GUI, Wi-Fi or HTTP."""
import argparse
import binascii
import json
from pathlib import Path
import secrets
import sys
import time


class CliError(Exception):
    pass


class DeviceError(CliError):
    pass


class Console:
    def __init__(self, port, timeout=60):
        self.port = port
        self.timeout = timeout
        self.buffer = bytearray()

    def request(self, command):
        request_id = secrets.randbits(32) or 1
        wire = f"@oi {request_id} {command}".encode("ascii")
        if len(wire) > 1024 or any(c < 32 or c > 126 for c in wire):
            raise CliError("Command must be a single ASCII line, at most 1024 bytes including framing")
        self.port.write(wire + b"\n")
        self.port.flush()
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            self.buffer.extend(self.port.read(256))
            if len(self.buffer) > 1024 * 1024:
                raise CliError("Console response exceeded 1 MiB")
            while b"\n" in self.buffer:
                line, _, rest = self.buffer.partition(b"\n")
                self.buffer = bytearray(rest)
                if not line.startswith(b"@oi "):
                    continue  # unrelated boot/debug output
                try:
                    reply = json.loads(line[4:])
                except (ValueError, UnicodeError):
                    continue
                if not isinstance(reply, dict) or reply.get("id") != request_id:
                    continue
                if type(reply.get("ok")) is not bool or not isinstance(reply.get("result"), str):
                    raise CliError("Malformed console reply")
                return reply
        # Never retry a timed-out write/reset/flash automatically.
        raise CliError("Serial response timeout; outcome unknown. Command was NOT retried")

    def checked(self, command):
        reply = self.request(command)
        if not reply["ok"]:
            raise DeviceError(reply["result"])
        return reply

    def upload(self, path):
        data = Path(path).read_bytes()
        if not 0 < len(data) <= 255 * 1024:
            raise CliError("CAN bootloader firmware must be 1..261120 bytes")
        self.checked(f"file begin {len(data)} 0x{binascii.crc32(data):08x}")
        try:
            for offset in range(0, len(data), 256):
                end = min(offset + 256, len(data))
                reply = self.checked("file chunk " + data[offset:end].hex())
                if reply["result"] != str(end):
                    raise CliError("Unexpected upload position")
            return self.checked("file finish")
        except Exception:
            # Abort only the temporary upload; never retry the failed chunk.
            try:
                self.request("file abort")
            except Exception:
                pass
            raise

    def wait_flash(self, timeout=600):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            reply = self.checked("flash-status")
            state = json.loads(reply["result"])
            if state["state"] == 3:
                return reply
            if state["state"] in (0, 4):
                raise DeviceError(state.get("message") or "No CAN firmware update running")
            time.sleep(0.5)
        raise CliError("Firmware update wait timed out; query flash-status before further actions")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True, help="e.g. COM27 or /dev/ttyUSB0")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("--json", action="store_true", help="emit the complete machine-readable response")
    parser.add_argument("--wait", action="store_true", help="wait for flash/flash-local completion")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="help, get NAME, set NAME VALUE, upload FILE, flash-local FILE, ...")
    args = parser.parse_args(argv)
    if not args.command:
        parser.error("a command is required (try help)")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    if args.wait and args.command[0] not in ("flash", "flash-local"):
        parser.error("--wait is only supported for flash and flash-local")
    try:
        import serial
        # Configure control lines BEFORE opening; don't intentionally reset the
        # ESP32 each time an automation reads or writes a parameter.
        with serial.Serial(port=None, baudrate=args.baud, timeout=0.1, write_timeout=5) as port:
            port.dtr = False
            port.rts = False
            port.port = args.port
            port.open()
            cli = Console(port, args.timeout)
            if args.command[0] in ("upload", "flash-local"):
                if len(args.command) != 2:
                    raise CliError("upload/flash-local require exactly one local firmware path")
                reply = cli.upload(args.command[1])
                if args.command[0] == "flash-local":
                    reply = cli.request("flash")
            else:
                reply = cli.request(" ".join(args.command))
            if args.wait and reply["ok"]:
                reply = cli.wait_flash()
            print(json.dumps(reply, ensure_ascii=False) if args.json else reply["result"])
            return 0 if reply["ok"] else 1
    except DeviceError as exc:
        print(f"oi-cli: {exc}", file=sys.stderr)
        return 1
    except (CliError, OSError, ImportError, ValueError) as exc:
        print(f"oi-cli: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
