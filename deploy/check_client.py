import json
import socket


def test_revision(sha,stage=None):
    request={"revision":sha}
    if stage: request["stage"]=stage
    with socket.socket(socket.AF_UNIX) as conn:
        conn.settimeout(110)
        conn.connect("/run/blueland-check.sock")
        conn.sendall(json.dumps(request).encode()+b"\n")
        with conn.makefile("rb") as handle:
            return json.loads(handle.readline(2000))
