"""`easiapiai test`: ask a provider easiapiai's test questions with your own key, on your machine, and send the raw
answers (never the key) to easiapiai for grading.

The key is read only from the environment variable you name, and is sent only to --base-url: as an
Authorization header that is never forwarded on a redirect (redirects are refused outright)."""
import http.client
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from . import CLIENT, api

MAX_RESPONSE = 4000
ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect could carry the key to another address, so the provider call never follows one."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_provider = urllib.request.build_opener(_NoRedirect)


def config_dir(environ=None):
    environ = os.environ if environ is None else environ
    base = environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "easiapiai")


def install_id(directory=None):
    """A random id kept in ~/.config/easiapiai/install_id, created on first use. It lets easiapiai count distinct
    contributors (results publish only once 5 people have tested a seller); it says nothing about you."""
    path = os.path.join(directory or config_dir(), "install_id")
    try:
        with open(path, encoding="utf-8") as fh:
            return str(uuid.UUID(fh.read().strip()))
    except (OSError, ValueError):
        pass
    new = str(uuid.uuid4())
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(new + "\n")
    except OSError:
        print("note: could not save %s; this run uses a one-off install id" % path, file=sys.stderr)
    return new


def completions_url(base_url):
    base = base_url.rstrip("/")
    return base if base.endswith("/chat/completions") else base + "/chat/completions"


def _text(obj):
    try:
        content = obj["choices"][0]["message"].get("content")
    except (KeyError, IndexError, TypeError, AttributeError):
        return None
    if isinstance(content, list):  # some providers return content parts
        content = "".join(p.get("text") or "" for p in content if isinstance(p, dict))
    return content if isinstance(content, str) else ("" if content is None else None)


def ask(endpoint, provider_model, key, prompt, timeout=60.0):
    """One question to an OpenAI-compatible chat/completions endpoint.
    -> {"response", "latency_ms", "ttft_ms", "output_tokens", "error", "status"}. On an error the response is
    empty: a provider's error text can echo part of the key, so it is never kept."""
    body = json.dumps({"model": provider_model, "messages": [{"role": "user", "content": prompt}],
                       "temperature": 0, "max_tokens": 2048}).encode("utf-8")
    req = urllib.request.Request(endpoint, data=body, method="POST",
                                 headers={"Content-Type": "application/json", "Accept": "application/json",
                                          "User-Agent": CLIENT})
    req.add_unredirected_header("Authorization", "Bearer " + key)
    out = {"response": "", "latency_ms": 0, "ttft_ms": None, "output_tokens": None, "error": None, "status": None}
    t0 = time.monotonic()
    try:
        with _provider.open(req, timeout=timeout) as resp:
            out["status"] = resp.status
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        out["status"] = exc.code
        out["error"] = "http_429" if exc.code == 429 else "http_5xx" if 500 <= exc.code < 600 else "other"
    except urllib.error.URLError as exc:
        timed_out = isinstance(exc.reason, socket.timeout) or "timed out" in str(exc.reason)
        out["error"] = "timeout" if timed_out else "other"
    except socket.timeout:
        out["error"] = "timeout"
    except (OSError, http.client.HTTPException, ValueError):
        out["error"] = "other"
    out["latency_ms"] = int(round((time.monotonic() - t0) * 1000))
    if out["error"]:
        return out
    try:
        obj = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        obj = None
    text = _text(obj) if isinstance(obj, dict) else None
    if text is None:
        out["error"] = "other"
        return out
    out["response"] = text[:MAX_RESPONSE]
    usage = obj.get("usage") if isinstance(obj.get("usage"), dict) else {}
    ct = usage.get("completion_tokens")
    out["output_tokens"] = ct if isinstance(ct, int) and not isinstance(ct, bool) else None
    return out


def _fail(msg, code=1):
    print("easiapiai test: " + msg, file=sys.stderr)
    return code


def run(args, environ=None):
    environ = os.environ if environ is None else environ
    if not ENV_NAME.match(args.key_env or ""):
        # never echo the value: people sometimes paste the key itself here
        return _fail("--key-env takes the NAME of an environment variable (for example DEEPINFRA_API_KEY), "
                     "not the key itself.", 2)
    key = environ.get(args.key_env, "").strip()
    if not key:
        return _fail("the environment variable %s is empty or not set. Put your provider key in it first, "
                     "e.g.  export %s=...  (the key is read from there and sent only to --base-url)."
                     % (args.key_env, args.key_env), 2)
    parts = urllib.parse.urlsplit(args.base_url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return _fail("--base-url must be an http(s) URL, e.g. https://api.deepinfra.com/v1/openai", 2)
    if parts.netloc.lower() == urllib.parse.urlsplit(args.api).netloc.lower():
        return _fail("--base-url points at the easiapiai API itself; your key must go to your provider only.", 2)
    if parts.scheme == "http" and parts.hostname not in ("localhost", "127.0.0.1", "::1"):
        print("warning: --base-url is plain http, so your key travels unencrypted to %s" % parts.hostname,
              file=sys.stderr)
    if not 1 <= args.n <= 20:
        return _fail("-n must be between 1 and 20.", 2)

    try:
        qs = api.call("GET", api.url(args.api, "/api/test/questions", {"model": args.model, "n": args.n}),
                      timeout=args.timeout)
    except api.ApiError as exc:
        sug = exc.data.get("suggestions")
        return _fail("could not get test questions: %s%s" % (
            exc, "; did you mean %s?" % ", ".join(map(str, sug)) if sug else ""))
    questions = qs.get("questions") or []
    if not qs.get("run_id") or not questions:
        return _fail("the question server sent no questions.")
    model = qs.get("model") or {}
    endpoint = completions_url(args.base_url)
    print("Testing %s as served by %s (model id %r at %s)."
          % (model.get("name") or args.model, args.seller, args.provider_model, parts.hostname))
    print("%d questions from %s; your key comes from $%s and goes only to %s."
          % (len(questions), args.api.rstrip("/"), args.key_env, parts.hostname))

    answers = []
    for i, q in enumerate(questions, 1):
        a = ask(endpoint, args.provider_model, key, str(q.get("prompt") or ""), args.timeout)
        status = a.pop("status")
        if i == 1 and a["error"] == "other":
            # most likely a set-up problem (wrong key, URL or model id), not a provider failure: stop, send nothing
            return _fail("the first question failed (%s). Check the key, --base-url and --provider-model. "
                         "Nothing was sent to easiapiai."
                         % ("HTTP %d" % status if status and status >= 300
                            else "no usable answer from %s" % parts.hostname))
        tail = ("error: %s" % a["error"] + (" (HTTP %d)" % status if status else "")) if a["error"] else (
            "%s output tokens" % (a["output_tokens"] if a["output_tokens"] is not None else "?"))
        print("  %2d/%d  %-14s %6d ms  %s" % (i, len(questions), q.get("qid"), a["latency_ms"], tail))
        a["qid"] = q.get("qid")
        answers.append(a)

    body = {"run_id": qs["run_id"], "seller": args.seller, "base_url_host": parts.hostname,
            "model_requested": args.provider_model, "official": bool(args.official), "install_id": install_id(),
            "client": CLIENT,
            "answers": [{k: a[k] for k in ("qid", "response", "latency_ms", "ttft_ms", "output_tokens", "error")}
                        for a in answers]}
    print("Sending the raw answers for grading (no key, no URL path) ...")
    try:
        res = api.call("POST", api.url(args.api, "/api/test/submit"), body, timeout=args.timeout)
    except api.ApiError as exc:
        return _fail("could not submit the answers: %s" % exc)

    sc = res.get("score") or {}
    print("\nScore: %s of %s answers agree with the reference answers%s."
          % (sc.get("correct", "?"), sc.get("total", "?"),
             " (%s errors, not graded)" % sc["errors"] if sc.get("errors") else ""))
    if res.get("seller_matched"):
        print("Seller on easiapiai: %s" % res["seller_matched"])
    else:
        print("Seller %r did not match a seller on easiapiai, so this run counts under no seller. Use the name "
              "as it appears on easiapiai.com." % args.seller)
    if res.get("results_url"):
        print("Results: %s" % res["results_url"])
    print("One run is a small sample. easiapiai publishes a model/seller result only after 300 answers from at "
          "least 5 people, as measured agreement with an interval: https://easiapiai.com/accountability")
    return 0
