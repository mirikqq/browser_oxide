import socket, ssl, struct, threading, json, sys
from hpack import Decoder
OUT = {}
def recv_exact(s, n):
    b = b''
    while len(b) < n:
        c = s.recv(n - len(b))
        if not c: raise EOFError
        b += c
    return b
def parse_client_hello(data):
    # record header 5, handshake header 4
    p = 5 + 4
    p += 2 + 32
    sid = data[p]; p += 1 + sid
    cl = struct.unpack('>H', data[p:p+2])[0]; p += 2
    ciphers = [struct.unpack('>H', data[p+i:p+i+2])[0] for i in range(0, cl, 2)]; p += cl
    cm = data[p]; p += 1 + cm
    el = struct.unpack('>H', data[p:p+2])[0]; p += 2
    end = p + el; exts = []
    while p < end:
        t, l = struct.unpack('>HH', data[p:p+4]); body = data[p+4:p+4+l]; p += 4 + l
        e = {'type': t, 'len': l, 'hex': body.hex() if l <= 256 else body[:64].hex()}
        if t == 10: e['groups'] = [struct.unpack('>H', body[2+i:4+i])[0] for i in range(0, struct.unpack('>H', body[:2])[0], 2)]
        if t == 13: e['sigalgs'] = [struct.unpack('>H', body[2+i:4+i])[0] for i in range(0, struct.unpack('>H', body[:2])[0], 2)]
        if t == 16: e['alpn'] = body.hex()
        if t == 17613 or t == 17513: e['alps'] = body.hex()
        if t == 27: e['cert_compression'] = body.hex()
        if t == 51: 
            ks=[]; q=2
            while q < len(body):
                g, kl = struct.unpack('>HH', body[q:q+4]); ks.append(g); q += 4 + kl
            e['key_shares'] = ks
        exts.append(e)
    return {'ciphers': ciphers, 'extensions': exts}
def pipe(a, b, first=None):
    try:
        while True:
            d = a.recv(65536)
            if not d: break
            b.sendall(d)
    except Exception: pass
    finally:
        try: b.shutdown(socket.SHUT_WR)
        except Exception: pass
def front(port_in, port_out):
    ls = socket.socket(); ls.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); ls.bind(('127.0.0.1', port_in)); ls.listen(8)
    while True:
        c, _ = ls.accept()
        hdr = recv_exact(c, 5); body = recv_exact(c, struct.unpack('>H', hdr[3:5])[0])
        if 'client_hello' not in OUT:
            OUT['client_hello'] = parse_client_hello(hdr + body)
        u = socket.create_connection(('127.0.0.1', port_out)); u.sendall(hdr + body)
        threading.Thread(target=pipe, args=(c, u), daemon=True).start()
        threading.Thread(target=pipe, args=(u, c), daemon=True).start()
def back(port):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain('cert.pem', 'key.pem'); ctx.set_alpn_protocols(['h2'])
    ls = socket.socket(); ls.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); ls.bind(('127.0.0.1', port)); ls.listen(8)
    while True:
        raw, _ = ls.accept()
        try:
            s = ctx.wrap_socket(raw, server_side=True)
            if s.selected_alpn_protocol() != 'h2': s.close(); continue
            recv_exact(s, 24)
            s.sendall(b'\x00\x00\x00\x04\x00\x00\x00\x00\x00')  # empty SETTINGS
            dec = Decoder(); frames = []
            while True:
                h = recv_exact(s, 9); ln = int.from_bytes(h[:3], 'big'); typ = h[3]; fl = h[4]; sid = int.from_bytes(h[5:9], 'big') & 0x7fffffff
                pl = recv_exact(s, ln)
                f = {'type': typ, 'flags': fl, 'stream': sid}
                if typ == 4 and not fl & 1: f['settings'] = [(int.from_bytes(pl[i:i+2],'big'), int.from_bytes(pl[i+2:i+6],'big')) for i in range(0, ln, 6)]
                if typ == 8: f['increment'] = int.from_bytes(pl[:4], 'big') & 0x7fffffff
                if typ == 2: f['priority'] = pl.hex()
                if typ == 1:
                    q = 0
                    if fl & 8: q += 1
                    if fl & 0x20:
                        dep = int.from_bytes(pl[q:q+4], 'big'); f['exclusive'] = bool(dep >> 31); f['depends_on'] = dep & 0x7fffffff; f['weight_byte'] = pl[q+4]; q += 5
                    f['headers'] = [k for k, v in dec.decode(pl[q:])]
                frames.append(f)
                if typ == 1:
                    OUT.setdefault('h2', frames); 
                    s.sendall(b'\x00\x00\x00\x04\x01\x00\x00\x00\x00')
                    body = b'<html>ok</html>'
                    from hpack import Encoder
                    hb = Encoder().encode([(':status','200'),('content-type','text/html')])
                    s.sendall(len(hb).to_bytes(3,'big') + b'\x01\x04' + sid.to_bytes(4,'big') + hb)
                    s.sendall(len(body).to_bytes(3,'big') + b'\x00\x01' + sid.to_bytes(4,'big') + body)
                    break
        except Exception as e:
            OUT.setdefault('errors', []).append(repr(e))
threading.Thread(target=back, args=(8444,), daemon=True).start()
threading.Thread(target=front, args=(8443, 8444), daemon=True).start()
import time
deadline = time.time() + float(sys.argv[1])
while time.time() < deadline and 'h2' not in OUT: time.sleep(0.2)
time.sleep(0.5)
print(json.dumps(OUT))
