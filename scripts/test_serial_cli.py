"""Host CLI tests: fragmented replies, correlation and no unsafe retries."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("oi_cli", Path(__file__).parents[1] / "tools/oi_cli.py")
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class FakePort:
    def __init__(self, handler=None):
        self.commands = []
        self.rx = bytearray()
        self.handler = handler or (lambda command: (True, "hello\nworld\t\"quoted\""))

    def write(self, wire):
        _, request_id, command = wire.decode().strip().split(" ", 2)
        self.commands.append(command)
        ok, result = self.handler(command)
        for line in [b"CAN: debug output\n", b"@oi not json\n",
                     b'@oi {"id":0,"ok":true,"result":"unrelated"}\n',
                     b"@oi " + json.dumps({"id": int(request_id), "ok": ok, "result": result}).encode() + b"\r\n"]:
            self.rx.extend(line)

    def flush(self):
        pass

    def read(self, size):
        # The serial read can split JSON and UTF-8 at arbitrary boundaries.
        data = bytes(self.rx[:7])
        del self.rx[:7]
        return data


class SerialCliTests(unittest.TestCase):
    def test_fragmented_correlated_reply(self):
        port = FakePort()
        result = cli.Console(port).request("status")
        self.assertTrue(result["ok"])
        self.assertEqual('hello\nworld\t"quoted"', result["result"])
        self.assertEqual(["status"], port.commands)

    def test_error_remains_error(self):
        port = FakePort(lambda cmd: (False, "sdo_abort 0x06090030"))
        with self.assertRaisesRegex(cli.DeviceError, "sdo_abort"):
            cli.Console(port).checked("set udcmin 123")
        self.assertEqual(1, len(port.commands))

    def test_large_database_reply(self):
        database = json.dumps({"param": {"unit": "V", "description": "x" * 120000}})
        result = cli.Console(FakePort(lambda command: (True, database))).request("db")
        self.assertEqual(database, result["result"])

    def test_timeout_never_retries_write(self):
        port = FakePort()
        with self.assertRaisesRegex(cli.CliError, "NOT retried"):
            cli.Console(port, timeout=0).request("reset")
        self.assertEqual(["reset"], port.commands)

    def test_rejects_injection_before_write(self):
        port = FakePort()
        for command in ["status\nreset", "x" * 1024, "status\r"]:
            with self.assertRaises(cli.CliError):
                cli.Console(port).request(command)
        self.assertEqual([], port.commands)

    def test_upload_checks_offsets_and_does_not_flash(self):
        data = bytes(range(256)) * 3
        received = bytearray()

        def handler(command):
            if command.startswith("file chunk "):
                received.extend(bytes.fromhex(command.split()[2]))
                return True, str(len(received))
            return True, "/cli-firmware.bin"

        port = FakePort(handler)
        with tempfile.TemporaryDirectory() as directory:
            firmware = Path(directory) / "test.bin"
            firmware.write_bytes(data)
            result = cli.Console(port).upload(firmware)
        self.assertTrue(result["ok"])
        self.assertEqual(data, received)
        self.assertTrue(port.commands[0].startswith("file begin 768 0x"))
        self.assertEqual("file finish", port.commands[-1])
        self.assertNotIn("flash", port.commands)

    def test_failed_upload_aborts_without_resending_chunk(self):
        def handler(command):
            return (False, "write failed") if command.startswith("file chunk") else (True, "ready")
        port = FakePort(handler)
        with tempfile.TemporaryDirectory() as directory:
            firmware = Path(directory) / "test.bin"
            firmware.write_bytes(b"firmware")
            with self.assertRaisesRegex(cli.CliError, "write failed"):
                cli.Console(port).upload(firmware)
        self.assertEqual("file abort", port.commands[-1])
        self.assertEqual(1, sum(c.startswith("file chunk") for c in port.commands))


if __name__ == "__main__":
    unittest.main()
