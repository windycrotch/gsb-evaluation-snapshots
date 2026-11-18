"""FTPS client test against a minimal implicit-TLS FTP server (stand-in for the printer)."""
import datetime
import socket
import ssl
import tempfile
import threading
from pathlib import Path

import pytest

from impasto import printer

PORT = 2121


def _cert(dirpath: Path, cn: str = "BBL CA") -> tuple[str, str]:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=365))
            .sign(key, hashes.SHA256()))
    keyf, certf = dirpath / "k.pem", dirpath / "c.pem"
    keyf.write_bytes(key.private_bytes(serialization.Encoding.PEM,
                                       serialization.PrivateFormat.TraditionalOpenSSL,
                                       serialization.NoEncryption()))
    certf.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return str(certf), str(keyf)


class MiniFTPS:
    """Implicit TLS, single user, enough verbs for ftplib.storbinary / size / nlst."""

    def __init__(self, root: Path, user="bblp", pw="12345678"):
        self.root, self.user, self.pw = root, user, pw
        self.ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        certf, keyf = _cert(root)
        self.ctx.load_cert_chain(certf, keyf)
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", PORT))
        self.sock.listen(5)
        self.stop = False
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while not self.stop:
            try:
                c, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._client, args=(c,), daemon=True).start()

    def _client(self, raw):
        try:
            c = self.ctx.wrap_socket(raw, server_side=True)
        except Exception:
            raw.close()
            return
        f = c.makefile("rwb", buffering=0)

        def send(s):
            f.write((s + "\r\n").encode())

        def readline():
            line = f.readline()
            return line.decode().strip() if line else None

        send("220 BBL-P003 FTP Server")
        auth = False
        pasv = None
        prot = False
        while True:
            line = readline()
            if line is None:
                break
            cmd, _, arg = line.partition(" ")
            cmd = cmd.upper()
            if cmd == "USER":
                send("331 OK")
            elif cmd == "PASS":
                if arg == self.pw:
                    auth = True
                    send("230 OK")
                else:
                    send("530 Login incorrect")
            elif not auth:
                send("530 Login first")
            elif cmd == "PWD":
                send('257 "/"')
            elif cmd == "TYPE":
                send("200 OK")
            elif cmd == "PROT":
                prot = arg.upper() == "P"
                send("200 OK")
            elif cmd == "PASV":
                pasv = socket.socket()
                pasv.bind(("127.0.0.1", 0))
                pasv.listen(1)
                p = pasv.getsockname()[1]
                send(f"227 Entering Passive Mode (127,0,0,1,{p >> 8},{p & 255})")
            elif cmd == "STOR":
                send("150 Ready")
                d, _ = pasv.accept()
                if prot:
                    d = self.ctx.wrap_socket(d, server_side=True)
                buf = b""
                while True:
                    try:
                        chunk = d.recv(65536)
                    except Exception:      # TLS close without close_notify, same as the printer
                        break
                    if not chunk:
                        break
                    buf += chunk
                d.close()
                (self.root / arg).write_bytes(buf)
                send("226 Transfer complete")
            elif cmd == "SIZE":
                p = self.root / arg
                send(f"213 {p.stat().st_size}" if p.exists() else "550 no file")
            elif cmd == "NLST":
                send("150 Here")
                d, _ = pasv.accept()
                if prot:
                    d = self.ctx.wrap_socket(d, server_side=True)
                d.sendall("\r\n".join(p.name for p in self.root.iterdir() if p.name != "k.pem" and p.name != "c.pem").encode() + b"\r\n")
                d.close()
                send("226 Done")
            elif cmd == "QUIT":
                send("221 Bye")
                break
            else:
                send("200 OK")
        c.close()

    def close(self):
        self.stop = True
        try:
            self.sock.close()
        except Exception:
            pass


@pytest.fixture(scope="module")
def server():
    root = Path(tempfile.mkdtemp())
    srv = MiniFTPS(root)
    yield root
    srv.close()


def test_login_and_upload(server):
    res = printer.test("127.0.0.1", "12345678", PORT)
    assert res["ok"] and res["pwd"] == "/"
    data = b"PK\x03\x04" + bytes(range(256)) * 4000
    up = printer.upload("127.0.0.1", "12345678", "test.gcode.3mf", data, port=PORT)
    assert up["ok"] and up["size"] == len(data)
    assert (server / "test.gcode.3mf").read_bytes() == data


def test_wrong_code(server):
    with pytest.raises(Exception):
        printer.test("127.0.0.1", "wrong", PORT)


def test_settings_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(printer, "DATA", tmp_path)
    printer.save_settings(ip="10.0.0.5", code="ABCDEF1234567890", start_after_send=True)
    pub = printer.public_settings()
    assert pub == {"ip": "10.0.0.5", "serial": "", "has_code": True, "start_after_send": True}
    raw = (tmp_path / "printer.json").read_text()
    assert "ABCDEF1234567890" not in raw            # encrypted at rest
    printer.save_settings(serial="01P00A123456789")
    d = printer.load_settings()
    assert d["code"] == "ABCDEF1234567890" and d["serial"] == "01P00A123456789"
