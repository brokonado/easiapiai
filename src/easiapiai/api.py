"""The easiapiai HTTP API: JSON in, JSON out. No keys, no cookies."""
import http.client
import json
import socket
import urllib.error
import urllib.parse
import urllib.request

from . import CLIENT

DEFAULT_API = "https://easiapiai.com"
USER_AGENT = CLIENT + " (+https://easiapiai.com)"


class ApiError(Exception):
    """The API (or the network) said no. .status is the HTTP status (None for network errors); .data is the
    decoded JSON error body, if any."""

    def __init__(self, message, status=None, data=None):
        super().__init__(message)
        self.status = status
        self.data = data if isinstance(data, dict) else {}


def url(base, path, query=None):
    out = base.rstrip("/") + path
    return out + ("?" + urllib.parse.urlencode(query) if query else "")


def _loads(raw):
    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


def call(method, full_url, body=None, timeout=60):
    """Send one request to the easiapiai API and return the decoded JSON object."""
    host = urllib.parse.urlsplit(full_url).netloc or full_url
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(full_url, data=data, method=method,
                                 headers={"Accept": "application/json", "User-Agent": USER_AGENT})
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        obj = _loads(exc.read() or b"")
        msg = obj.get("error") if isinstance(obj, dict) else None
        raise ApiError(str(msg) if msg else "HTTP %d from %s" % (exc.code, host), exc.code, obj)
    except urllib.error.URLError as exc:
        raise ApiError("could not reach %s: %s" % (host, exc.reason))
    except (socket.timeout, OSError, http.client.HTTPException) as exc:
        raise ApiError("could not reach %s: %s" % (host, exc))
    obj = _loads(raw)
    if not isinstance(obj, dict):
        raise ApiError("unexpected answer from %s (not a JSON object)" % host)
    return obj
