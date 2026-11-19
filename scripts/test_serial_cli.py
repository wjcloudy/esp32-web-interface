"""Host CLI tests: fragmented replies, correlation and no unsafe retries."""
import importlib.util
import json
import binascii
import hashlib
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


class SdDownloadTests(unittest.TestCase):
    def port(self, data, corrupt=None, changed=False):
        stats = 0
        def handler(command):
            nonlocal stats
            if command.startswith('sd stat '):
                stats += 1
                return True, json.dumps({'size': len(data), 'modified': 10 + (changed and stats > 1)})
            _, _, path, offset, count = command.split()
            self.assertEqual('/capture.bin', path)
            offset, count = int(offset), int(count)
            block = data[offset:offset + count]
            obj = {'size': len(data), 'offset': offset, 'eof': offset + len(block) == len(data),
                   'crc32': f'{binascii.crc32(block):08x}', 'hex': block.hex()}
            if corrupt:
                obj.update(corrupt)
            return True, json.dumps(obj)
        return FakePort(handler)

    def test_binary_download_exact_bytes_and_sha256(self):
        data = bytes(range(256)) * 10 + b'\x00\xff\r\n'
        port = self.port(data)
        with tempfile.TemporaryDirectory() as directory:
            dest = Path(directory) / 'capture.bin'
            reply = cli.Console(port).download('/capture.bin', dest)
            self.assertEqual(data, dest.read_bytes())
            self.assertEqual(hashlib.sha256(data).hexdigest(), json.loads(reply['result'])['sha256'])
            self.assertEqual([dest], list(Path(directory).iterdir()))
        self.assertEqual(3, sum(c.startswith('sd read ') for c in port.commands))

    def test_empty_file_download(self):
        with tempfile.TemporaryDirectory() as directory:
            dest = Path(directory) / 'empty.bin'
            cli.Console(self.port(b'')).download('/capture.bin', dest)
            self.assertEqual(b'', dest.read_bytes())

    def test_corruption_offset_and_truncation_leave_no_final_file(self):
        for corrupt in [{'crc32': '00000000'}, {'offset': 1}, {'hex': 'aa'}, {'eof': False}, {'hex': 'invalid'}]:
            with self.subTest(corrupt=corrupt), tempfile.TemporaryDirectory() as directory:
                dest = Path(directory) / 'capture.bin'
                with self.assertRaises(cli.CliError):
                    cli.Console(self.port(b'correct data', corrupt)).download('/capture.bin', dest)
                self.assertEqual([], list(Path(directory).iterdir()))

    def test_changed_sd_file_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            dest = Path(directory) / 'capture.bin'
            with self.assertRaisesRegex(cli.CliError, 'changed'):
                cli.Console(self.port(b'data', changed=True)).download('/capture.bin', dest)
            self.assertEqual([], list(Path(directory).iterdir()))

    def test_existing_destination_is_preserved_without_device_requests(self):
        port = self.port(b'data')
        with tempfile.TemporaryDirectory() as directory:
            dest = Path(directory) / 'capture.bin'; dest.write_bytes(b'keep')
            with self.assertRaisesRegex(cli.CliError, 'already exists'):
                cli.Console(port).download('/capture.bin', dest)
            self.assertEqual(b'keep', dest.read_bytes())
        self.assertEqual([], port.commands)

    def test_invalid_path_rejected_before_device_requests(self):
        port = self.port(b'data')
        for path in ['relative.bin', '/file\nreset', '/name with spaces']:
            with self.assertRaises(cli.CliError):
                cli.Console(port).download(path, 'unused.bin')
        self.assertEqual([], port.commands)


if __name__ == "__main__":
    unittest.main()
