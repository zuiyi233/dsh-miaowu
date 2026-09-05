#!/usr/bin/env python3
"""Self-contained ComfyUI executor: the only entry point for ComfyUI calls.

Stdlib only. Two modes: `drama` (production_tool.py payload, exactly one
output target written to <output_root>/result<suffix>) and `tool` (direct
payload, products to <output_dir>/<prefix>-<seq>.<ext>). Placeholders are
replaced only when a JSON string value wholly equals the placeholder; a
needed placeholder without a value is an explicit error, never sent raw.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import secrets
import socket
import stat
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any
from unittest import mock

MINIMUM_PYTHON = (3, 9)
if sys.version_info < MINIMUM_PYTHON:
    raise SystemExit("comfyui_runner.py requires Python 3.9 or newer")

PROVIDER = "comfyui"
DEFAULT_BASE_URL = "http://127.0.0.1:8188"
DEFAULT_TIMEOUT_SECONDS = 600
MAX_TIMEOUT_SECONDS = 3600
POLL_INTERVAL_SECONDS = 1
REQUEST_TIMEOUT_SECONDS = 60
TRANSFER_TIMEOUT_SECONDS = 300
MAX_JSON_BYTES = 16 * 1024 * 1024
MAX_OUTPUT_BYTES = 512 * 1024 * 1024
MAX_STDIN_BYTES = 1024 * 1024

TEXT_PLACEHOLDERS = {"__PROMPT__": "prompt", "__NEGATIVE__": "negative"}
NUMERIC_PLACEHOLDERS = {
    "__WIDTH__": "width",
    "__HEIGHT__": "height",
    "__SEED__": "seed",
    "__STEPS__": "steps",
    "__CFG__": "cfg",
    "__FPS__": "fps",
    "__DURATION_SECONDS__": "duration_seconds",
}
INPUT_IMAGE_PLACEHOLDER = "__INPUT_IMAGE__"
INPUT_IMAGE_KEY = "input_image"
DRAMA_MODALITIES = {"image", "video", "music"}
# Parameters consumed by drama mode (_drama_values + workflow lookup in
# _normalize_drama). Anything else with a non-empty value is ignored with a
# stderr warning, never silently.
DRAMA_KNOWN_PARAMETERS = frozenset({
    "negative", "width", "height", "steps", "cfg", "fps",
    "duration_seconds", "duration", "seed", INPUT_IMAGE_KEY, "workflow",
})
# Top-level fields consumed by tool mode (_normalize_tool). Unknown non-empty
# fields are reported in the stdout "warnings" array (plus a stderr line).
TOOL_KNOWN_FIELDS = frozenset({
    "prompt", "negative", "workflow", "count", "output_dir", "filename_prefix",
    "seed", "width", "height", "steps", "cfg", "fps", "duration_seconds",
    "timeout_seconds", INPUT_IMAGE_KEY,
})


class ComfyFailure(RuntimeError):
    """Safe-to-report failure; the message never carries credentials."""

    def __init__(self, message: str, *, category: str = "provider",
                 code: str = "adapter_failure", http_status: int | None = None,
                 request_id: str | None = None, retryable: bool = False) -> None:
        super().__init__(message)
        self.category = category
        self.code = code
        self.http_status = http_status
        self.request_id = request_id
        self.retryable = retryable

    def public(self) -> dict[str, Any]:
        result: dict[str, Any] = {"provider": PROVIDER, "category": self.category,
                                  "code": self.code, "retryable": self.retryable}
        if self.http_status is not None:
            result["http_status"] = self.http_status
        if self.request_id is not None:
            result["request_id"] = self.request_id
        return result


def _fail(message: str, **kwargs: Any) -> ComfyFailure:
    return ComfyFailure(message, **kwargs)


def _base_url() -> str:
    value = os.environ.get("COMFYUI_BASE_URL", DEFAULT_BASE_URL).strip().rstrip("/")
    parsed = urllib.parse.urlparse(value)
    # Plain http is legal: ComfyUI is a localhost service by default.
    if (parsed.scheme not in ("http", "https") or not parsed.netloc
            or parsed.username or parsed.password):
        raise _fail("ComfyUI base URL is invalid", category="configuration",
                    code="invalid_base_url")
    return value


def _timeout_seconds(value: Any, *, default: int) -> int:
    if value is None:
        return default
    if (isinstance(value, bool) or not isinstance(value, int)
            or not 1 <= value <= MAX_TIMEOUT_SECONDS):
        raise ValueError(f"timeout must be 1-{MAX_TIMEOUT_SECONDS} seconds")
    return value


def _env_timeout_seconds() -> int:
    raw = os.environ.get("COMFYUI_TIMEOUT_SECONDS")
    if raw is None:
        return DEFAULT_TIMEOUT_SECONDS
    try:
        return _timeout_seconds(int(raw), default=DEFAULT_TIMEOUT_SECONDS)
    except (TypeError, ValueError) as exc:
        raise _fail("ComfyUI timeout configuration is invalid",
                    category="configuration", code="invalid_timeout") from exc


def _do_request(url: str, *, method: str = "GET", data: bytes | None = None,
                content_type: str | None = None, timeout: int, limit: int) -> bytes:
    request = urllib.request.Request(url, data=data, method=method)
    key = os.environ.get("COMFYUI_API_KEY")
    if key:
        request.add_header("Authorization", "Bearer " + key)
    if content_type is not None:
        request.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(limit + 1)
    except urllib.error.HTTPError as exc:
        raise _fail(f"comfyui HTTP request failed with status {exc.code}",
                    category="provider", code=f"http_{exc.code}",
                    http_status=exc.code,
                    retryable=exc.code == 429 or 500 <= exc.code <= 599) from exc
    except (TimeoutError, socket.timeout) as exc:
        raise _fail("comfyui HTTP request timed out", category="timeout",
                    code="request_timeout", retryable=True) from exc
    except (urllib.error.URLError, OSError) as exc:
        raise _fail("comfyui is unreachable", category="network",
                    code="comfyui_unreachable", retryable=True) from exc
    if len(body) > limit:
        raise _fail("comfyui response is too large", code="response_too_large")
    return body


def _parse_json_object(body: bytes) -> dict[str, Any]:
    try:
        document = json.loads(body.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise _fail("comfyui returned invalid JSON", code="invalid_response") from exc
    if not isinstance(document, dict):
        raise _fail("comfyui returned an invalid response", code="invalid_response")
    return document


def _resolve_workflow_file(explicit: str | None) -> Path:
    # Priority: explicit workflow param > COMFYUI_WORKFLOW file >
    # COMFYUI_WORKFLOW_DIR looked up by bare workflow name.
    if explicit:
        candidate = Path(explicit)
        if (candidate.suffix.casefold() == ".json" or candidate.is_absolute()
                or "/" in explicit or "\\" in explicit):
            resolved = candidate if candidate.is_absolute() else Path.cwd() / candidate
            if not resolved.is_file():
                raise _fail("comfyui workflow file is missing",
                            category="configuration", code="workflow_not_found")
            return resolved
        workflow_dir = os.environ.get("COMFYUI_WORKFLOW_DIR")
        if not workflow_dir:
            raise _fail("comfyui workflow name has no lookup directory",
                        category="configuration", code="workflow_not_found")
        resolved = Path(workflow_dir) / (explicit + ".json")
        if not resolved.is_file():
            raise _fail("comfyui workflow file is missing",
                        category="configuration", code="workflow_not_found")
        return resolved
    configured = os.environ.get("COMFYUI_WORKFLOW")
    if configured:
        resolved = Path(configured)
        resolved = resolved if resolved.is_absolute() else Path.cwd() / resolved
        if not resolved.is_file():
            raise _fail("comfyui workflow file is missing",
                        category="configuration", code="workflow_not_found")
        return resolved
    raise _fail("comfyui workflow is not configured", category="configuration",
                code="workflow_not_configured")


def _load_workflow(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise _fail("comfyui workflow file is unreadable",
                    category="configuration", code="workflow_not_found") from exc
    try:
        document = json.loads(text)
    except json.JSONDecodeError as exc:
        raise _fail("comfyui workflow is not valid JSON",
                    category="configuration", code="workflow_invalid_json") from exc
    if not isinstance(document, dict):
        raise _fail("comfyui workflow must be a JSON object",
                    category="configuration", code="workflow_invalid_json")
    return document


def _inject_placeholders(node: Any, values: dict[str, Any]) -> Any:
    """Replace whole-value placeholders; keys and substrings are untouched."""
    if isinstance(node, dict):
        return {key: _inject_placeholders(value, values) for key, value in node.items()}
    if isinstance(node, list):
        return [_inject_placeholders(item, values) for item in node]
    if isinstance(node, str):
        if node in TEXT_PLACEHOLDERS:
            key = TEXT_PLACEHOLDERS[node]
            value = values.get(key)
            if value is None:
                raise _fail(f"workflow placeholder {node} has no value",
                            category="invalid_request", code="missing_placeholder_value")
            if not isinstance(value, str):
                raise ValueError(f"parameter {key} must be a string")
            return value
        if node in NUMERIC_PLACEHOLDERS:
            key = NUMERIC_PLACEHOLDERS[node]
            value = values.get(key)
            if value is None:
                raise _fail(f"workflow placeholder {node} has no value",
                            category="invalid_request", code="missing_placeholder_value")
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"parameter {key} must be a number")
            return value
        if node == INPUT_IMAGE_PLACEHOLDER:
            value = values.get(INPUT_IMAGE_KEY)
            if not isinstance(value, str) or not value:
                raise _fail(f"workflow placeholder {node} has no value",
                            category="invalid_request", code="missing_placeholder_value")
            return value
    return node


def _media_ok(suffix: str, content: bytes) -> bool:
    if not content:
        return False
    if suffix == ".png":
        return content.startswith(b"\x89PNG\r\n\x1a\n")
    if suffix in {".jpg", ".jpeg"}:
        return content.startswith(b"\xff\xd8\xff")
    if suffix == ".webp":
        return len(content) >= 12 and content.startswith(b"RIFF") and content[8:12] == b"WEBP"
    if suffix == ".mp4":
        return len(content) >= 8 and content[4:8] == b"ftyp"
    if suffix == ".wav":
        return len(content) >= 12 and content.startswith(b"RIFF") and content[8:12] == b"WAVE"
    return False


def _check_media_or_raise(suffix: str, content: bytes) -> None:
    if not _media_ok(suffix, content):  # checked before any write: no residue
        raise _fail("comfyui output does not match the target media type",
                    code="output_invalid_media")


def _submit_prompt(base: str, workflow: dict[str, Any], timeout: int) -> str:
    body = json.dumps({"prompt": workflow, "client_id": uuid.uuid4().hex},
                      ensure_ascii=False).encode("utf-8")
    document = _parse_json_object(_do_request(
        base + "/prompt", method="POST", data=body, content_type="application/json",
        timeout=timeout, limit=MAX_JSON_BYTES))
    node_errors = document.get("node_errors")
    if isinstance(node_errors, dict) and node_errors:
        raise _fail(f"comfyui rejected the prompt nodes: {sorted(node_errors)[:5]}",
                    code="node_error")
    prompt_id = document.get("prompt_id")
    if not isinstance(prompt_id, str) or not prompt_id:
        raise _fail("comfyui did not return a prompt id", code="missing_prompt_id")
    return prompt_id


def _poll_history(base: str, prompt_id: str, timeout_seconds: int) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    url = base + "/history/" + urllib.parse.quote(prompt_id, safe="")
    while True:
        entry = _parse_json_object(_do_request(
            url, timeout=REQUEST_TIMEOUT_SECONDS, limit=MAX_JSON_BYTES)).get(prompt_id)
        if isinstance(entry, dict):
            status = entry.get("status")
            status_str = status.get("status_str") if isinstance(status, dict) else None
            if status_str == "error":
                try:
                    detail = json.dumps(status.get("messages"), ensure_ascii=False)[:500]
                except (TypeError, ValueError):
                    detail = "unavailable"
                raise _fail(f"comfyui node failed: {detail}",
                            code="node_error", request_id=prompt_id)
            if status_str == "success" or "outputs" in entry:
                outputs = entry.get("outputs") or {}
                if not isinstance(outputs, dict):
                    raise _fail("comfyui history outputs are invalid",
                                code="invalid_response", request_id=prompt_id)
                return outputs
        if time.monotonic() >= deadline:
            raise _fail("comfyui polling timed out", category="timeout",
                        code="comfyui_timeout", retryable=True, request_id=prompt_id)
        time.sleep(POLL_INTERVAL_SECONDS)


def _collect_media(outputs: dict[str, Any]) -> list[dict[str, str]]:
    """Collect images/gifs across all nodes; type output wins, else keep all."""
    found = [{"filename": item["filename"], "subfolder": str(item.get("subfolder", "")),
              "type": str(item.get("type", "output"))}
             for node_output in outputs.values() if isinstance(node_output, dict)
             for key in ("images", "gifs") if isinstance(node_output.get(key), list)
             for item in node_output[key]
             if isinstance(item, dict) and isinstance(item.get("filename"), str)]
    preferred = [item for item in found if item["type"] == "output"]
    return preferred or found


def _download_view(base: str, entry: dict[str, str], timeout: int) -> bytes:
    query = urllib.parse.urlencode(
        {"filename": entry["filename"], "subfolder": entry["subfolder"], "type": entry["type"]})
    content = _do_request(base + "/view?" + query, timeout=timeout, limit=MAX_OUTPUT_BYTES)
    if not content:
        raise _fail("comfyui returned an empty file", code="output_invalid_media")
    return content


def _upload_image(base: str, path: Path, timeout: int) -> str:
    try:
        content = path.read_bytes()
    except OSError as exc:
        raise ValueError(f"input image is unreadable: {path}") from exc
    if not content or len(content) > MAX_OUTPUT_BYTES:
        raise ValueError("input image is empty or too large")
    boundary = "comfyui-" + secrets.token_hex(16)
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    body = b"".join([
        f'--{boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n'.encode("ascii"),
        f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{path.name}"\r\nContent-Type: {media_type}\r\n\r\n'.encode("utf-8"),
        content, b"\r\n", f"--{boundary}--\r\n".encode("ascii")])
    name = _parse_json_object(_do_request(
        base + "/upload/image", method="POST", data=body,
        content_type=f"multipart/form-data; boundary={boundary}",
        timeout=timeout, limit=MAX_JSON_BYTES)).get("name")
    if not isinstance(name, str) or not name:
        raise _fail("comfyui upload did not return a filename", code="upload_failed")
    return name


def _resolve_input_file(value: str, base_dir: Path | None) -> Path:
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = (base_dir if base_dir is not None else Path.cwd()) / candidate
    if not candidate.is_file() or candidate.is_symlink():
        raise ValueError(f"input image is not a regular file: {value}")
    return candidate


def _checked_int(name: str, value: Any, *, minimum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValueError(f"parameter {name} is out of range")
    return value


def _checked_float(name: str, value: Any) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not value > 0:
        raise ValueError(f"parameter {name} is out of range")
    return value


def _normalize_dimensions(values: dict[str, Any]) -> None:
    for key in ("width", "height", "steps"):
        if values.get(key) is not None:
            values[key] = _checked_int(key, values[key], minimum=1)
    for key in ("cfg", "fps", "duration_seconds"):
        if values.get(key) is not None:
            values[key] = _checked_float(key, values[key])


def _output_root(raw: Any) -> Path:
    if not isinstance(raw, str):
        raise ValueError("output_root is invalid")
    root = Path(raw)
    if not root.is_absolute():
        raise ValueError("output_root is invalid")
    try:
        details = root.lstat()
    except OSError as exc:
        raise ValueError("output_root is missing") from exc
    if stat.S_ISLNK(details.st_mode) or not stat.S_ISDIR(details.st_mode):
        raise ValueError("output_root is unsafe")
    return root


def _normalize_drama(document: Any) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise ValueError("adapter input must be an object")
    if document.get("modality") not in DRAMA_MODALITIES:
        raise ValueError("modality must be image, video, or music")
    prompt = document.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("job prompt must be non-empty")
    parameters = document.get("parameters", {})
    if not isinstance(parameters, dict):
        raise ValueError("job parameters must be an object")
    outputs = document.get("outputs")
    if (not isinstance(outputs, list) or len(outputs) != 1
            or not isinstance(outputs[0], str) or not outputs[0]):
        raise ValueError("provider adapter requires exactly one output")
    workflow = document.get("workflow", parameters.get("workflow"))
    if workflow is not None and not isinstance(workflow, str):
        raise ValueError("workflow must be a preset name or file path")
    project_root = document.get("project_root")
    return {"prompt": prompt, "parameters": parameters, "target": outputs[0],
            "output_root": _output_root(document.get("output_root")),
            "project_root": Path(project_root) if isinstance(project_root, str) else None,
            "workflow": workflow}


def _is_empty_value(value: Any) -> bool:
    """Values that carry no information: never counted as ignored."""
    return value is None or (isinstance(value, str) and value == "")


def _ignored_names(document: dict[str, Any], known: frozenset[str]) -> list[str]:
    return sorted(key for key, value in document.items()
                  if key not in known and not _is_empty_value(value))


def _warn_ignored(names: list[str]) -> None:
    if names:
        print(f"comfyui-runner: ignored parameters: {', '.join(names)}",
              file=sys.stderr)


def _drama_values(prompt: str, parameters: dict[str, Any]) -> dict[str, Any]:
    values: dict[str, Any] = {"prompt": prompt}
    for key in ("negative", "width", "height", "steps", "cfg", "fps"):
        if parameters.get(key) is not None:
            values[key] = parameters[key]
    duration = parameters.get("duration_seconds", parameters.get("duration"))
    if duration is not None:
        values["duration_seconds"] = duration
    seed = parameters.get("seed")
    values["seed"] = secrets.randbelow(2**32) if seed is None else _checked_int(
        "seed", seed, minimum=0)
    _normalize_dimensions(values)
    if "negative" in values and not isinstance(values["negative"], str):
        raise ValueError("parameter negative must be a string")
    if parameters.get(INPUT_IMAGE_KEY) is not None:
        if not isinstance(parameters[INPUT_IMAGE_KEY], str):
            raise ValueError("parameter input_image must be a file path")
        values[INPUT_IMAGE_KEY] = parameters[INPUT_IMAGE_KEY]
    return values


def _generate(base: str, template: dict[str, Any], values: dict[str, Any],
              timeout: int) -> tuple[str, dict[str, Any]]:
    prompt_id = _submit_prompt(base, _inject_placeholders(template, values),
                               REQUEST_TIMEOUT_SECONDS)
    return prompt_id, _poll_history(base, prompt_id, timeout)


def _run_drama(document: Any) -> dict[str, Any]:
    job = _normalize_drama(document)
    _warn_ignored(_ignored_names(job["parameters"], DRAMA_KNOWN_PARAMETERS))
    timeout = _env_timeout_seconds()
    deadline = time.monotonic() + timeout
    base = _base_url()
    template = _load_workflow(_resolve_workflow_file(job["workflow"]))
    values = _drama_values(job["prompt"], job["parameters"])
    if values.get(INPUT_IMAGE_KEY) is not None:
        values[INPUT_IMAGE_KEY] = _upload_image(
            base, _resolve_input_file(values[INPUT_IMAGE_KEY], job["project_root"]),
            TRANSFER_TIMEOUT_SECONDS)
    prompt_id, outputs = _generate(base, template, values, max(1, int(deadline - time.monotonic())))
    entries = _collect_media(outputs)
    if not entries:
        raise _fail("comfyui returned no output files", code="empty_output",
                    request_id=prompt_id)
    content = _download_view(base, entries[0], TRANSFER_TIMEOUT_SECONDS)
    suffix = Path(job["target"]).suffix.casefold()
    _check_media_or_raise(suffix, content)
    destination = job["output_root"] / ("result" + suffix)
    try:
        with destination.open("xb") as handle:
            handle.write(content)
    except FileExistsError as exc:
        raise _fail("comfyui output already exists", category="configuration",
                    code="output_exists", request_id=prompt_id) from exc
    return {"outputs": [{"target": job["target"], "source": str(destination)}],
            "provider_job_id": prompt_id}


def _normalize_tool(document: Any) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise ValueError("tool input must be an object")
    prompt = document.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("prompt must be non-empty")
    negative = document.get("negative")
    if negative is not None and not isinstance(negative, str):
        raise ValueError("negative must be a string")
    workflow = document.get("workflow")
    if workflow is not None and not isinstance(workflow, str):
        raise ValueError("workflow must be a preset name or file path")
    count = _checked_int("count", document.get("count", 1), minimum=1)
    if count > 8:
        raise ValueError("count must be between 1 and 8")
    output_dir = document.get("output_dir")
    if not isinstance(output_dir, str) or not output_dir or Path(output_dir).is_absolute():
        raise ValueError("output_dir must be a relative directory")
    root = Path.cwd().resolve()
    try:
        (root / output_dir).resolve().relative_to(root)
    except ValueError as exc:
        raise ValueError("output_dir escapes the working directory") from exc
    prefix = document.get("filename_prefix", "comfyui")
    if (not isinstance(prefix, str) or not prefix or prefix != Path(prefix).name
            or prefix.startswith(".")):
        raise ValueError("filename_prefix must be a plain file name")
    seed = document.get("seed")
    input_image = document.get(INPUT_IMAGE_KEY)
    if input_image is not None and not isinstance(input_image, str):
        raise ValueError("input_image must be a file path")
    values: dict[str, Any] = {"prompt": prompt}
    if negative is not None:
        values["negative"] = negative
    for key in ("width", "height", "steps", "cfg", "fps", "duration_seconds"):
        if document.get(key) is not None:
            values[key] = document[key]
    _normalize_dimensions(values)
    return {"workflow": workflow, "values": values,
            "seed": None if seed is None else _checked_int("seed", seed, minimum=0),
            "count": count, "output_dir": output_dir, "filename_prefix": prefix,
            "timeout_seconds": _timeout_seconds(document.get("timeout_seconds"),
                                                default=DEFAULT_TIMEOUT_SECONDS),
            "input_image": input_image,
            "warnings": _ignored_names(document, TOOL_KNOWN_FIELDS)}


def _run_tool(document: Any) -> dict[str, Any]:
    job = _normalize_tool(document)
    started = time.monotonic()
    deadline = started + job["timeout_seconds"]
    base = _base_url()
    template = _load_workflow(_resolve_workflow_file(job["workflow"]))
    out_dir = (Path.cwd() / job["output_dir"]).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    server_image = (_upload_image(base, _resolve_input_file(job["input_image"], Path.cwd()),
                                  TRANSFER_TIMEOUT_SECONDS)
                    if job["input_image"] is not None else None)
    base_seed = job["seed"] if job["seed"] is not None else secrets.randbelow(2**32)
    files: list[dict[str, Any]] = []
    prompt_ids: list[str] = []
    sequence = 0
    _warn_ignored(job["warnings"])
    for index in range(job["count"]):
        values = dict(job["values"])
        values["seed"] = base_seed + index  # count>1: seeds step by 1
        if server_image is not None:
            values[INPUT_IMAGE_KEY] = server_image
        prompt_id, outputs = _generate(
            base, template, values, max(1, int(deadline - time.monotonic())))
        prompt_ids.append(prompt_id)
        entries = _collect_media(outputs)
        if not entries:
            raise _fail("comfyui returned no output files", code="empty_output",
                        request_id=prompt_id)
        for entry in entries:
            content = _download_view(base, entry, TRANSFER_TIMEOUT_SECONDS)
            suffix = Path(entry["filename"]).suffix.casefold()
            _check_media_or_raise(suffix, content)
            sequence += 1
            destination = out_dir / f"{job['filename_prefix']}-{sequence}{suffix}"
            with destination.open("wb") as handle:
                handle.write(content)
            files.append({"path": str(destination), "bytes": len(content)})
    return {"files": files, "prompt_ids": prompt_ids,
            "duration_ms": int((time.monotonic() - started) * 1000),
            "warnings": job["warnings"]}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", nargs="?", choices=("drama", "tool"))
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args(argv)
    if args.selftest:
        suite = unittest.TestLoader().loadTestsFromModule(sys.modules[__name__])
        result = unittest.TextTestRunner(stream=sys.stderr, verbosity=2).run(suite)
        return 0 if result.wasSuccessful() else 1
    if args.mode is None:
        parser.error("mode is required unless --selftest is used")
    try:
        raw = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
        if len(raw) > MAX_STDIN_BYTES:
            raise ValueError("input is too large")
        document = json.loads(raw.decode("utf-8"))
        response = _run_drama(document) if args.mode == "drama" else _run_tool(document)
        json.dump(response, sys.stdout, ensure_ascii=True)
        return 0
    except ComfyFailure as exc:
        json.dump({"error": exc.public()}, sys.stdout, ensure_ascii=True)
        print(f"comfyui {args.mode} failed safely: {exc.code}", file=sys.stderr)
        return 1
    except (ValueError, KeyError, TypeError, json.JSONDecodeError, UnicodeError):
        code = "invalid_job" if args.mode == "drama" else "invalid_payload"
        json.dump({"error": {"provider": PROVIDER, "category": "invalid_request",
                             "code": code, "retryable": False}}, sys.stdout, ensure_ascii=True)
        print(f"comfyui {args.mode} failed safely", file=sys.stderr)
        return 1


PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


class _FakeResponse:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self, size: int = -1) -> bytes:
        return self._body if size < 0 else self._body[:size]

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc: Any) -> bool:
        return False


def _fake_urlopen_factory(history: dict[str, Any]):  # type: ignore[no-untyped-def]
    def _fake(request: Any, timeout: Any = None) -> _FakeResponse:
        url = request.full_url if isinstance(request, urllib.request.Request) else str(request)
        if url.endswith("/prompt"):
            return _FakeResponse(json.dumps({"prompt_id": "pid-1"}).encode("utf-8"))
        if "/history/" in url:
            return _FakeResponse(json.dumps(history).encode("utf-8"))
        if "/view" in url:
            return _FakeResponse(PNG_BYTES)
        raise AssertionError(f"unexpected URL: {url}")

    return _fake


def _write_workflow(directory: Path, name: str, document: Any) -> Path:
    path = directory / name
    path.write_text(json.dumps(document), encoding="utf-8", newline="\n")
    return path


class SelfTests(unittest.TestCase):
    def test_placeholders(self) -> None:
        workflow = {"3": {"inputs": {"text": "__PROMPT__", "width": "__WIDTH__",
                                     "seed": "__SEED__"}}, "label": "__PROMPT__"}
        result = _inject_placeholders(workflow, {"prompt": "a cat", "width": 512, "seed": 7})
        self.assertEqual(result["3"]["inputs"]["text"], "a cat")
        self.assertEqual(result["3"]["inputs"]["width"], 512)
        self.assertIs(type(result["3"]["inputs"]["width"]), int)
        self.assertEqual(result["label"], "a cat")
        untouched = {"__PROMPT__": "key-stays", "text": "prefix __PROMPT__ suffix"}
        self.assertEqual(_inject_placeholders(untouched, {"prompt": "x"}), untouched)
        with self.assertRaises(ComfyFailure) as ctx:
            _inject_placeholders({"text": "__NEGATIVE__"}, {"prompt": "x"})
        self.assertEqual(ctx.exception.public()["code"], "missing_placeholder_value")
        self.assertFalse(ctx.exception.public()["retryable"])
        with self.assertRaises(ValueError):
            _inject_placeholders({"seed": "__SEED__"}, {"seed": True})

    def test_workflow_resolution(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            explicit = _write_workflow(directory, "a.json", {"node": "a"})
            configured = _write_workflow(directory, "b.json", {"node": "b"})
            subdir = directory / "workflows"
            subdir.mkdir()
            named = _write_workflow(subdir, "cinematic.json", {"node": "c"})
            broken = directory / "broken.json"
            broken.write_text("{not json", encoding="utf-8", newline="\n")
            env = {"COMFYUI_WORKFLOW": str(configured),
                   "COMFYUI_WORKFLOW_DIR": str(subdir)}
            with mock.patch.dict(os.environ, env, clear=True):
                self.assertEqual(_resolve_workflow_file(str(explicit)), explicit)
                self.assertEqual(_resolve_workflow_file(None).resolve(),
                                 configured.resolve())
                self.assertEqual(_resolve_workflow_file("cinematic"), named)
                with self.assertRaises(ComfyFailure) as ctx:
                    _resolve_workflow_file(str(directory / "absent.json"))
                self.assertEqual(ctx.exception.public()["code"], "workflow_not_found")
                with self.assertRaises(ComfyFailure) as ctx:
                    _load_workflow(broken)
                self.assertEqual(ctx.exception.public()["code"], "workflow_invalid_json")
            with mock.patch.dict(os.environ, {}, clear=True):
                with self.assertRaises(ComfyFailure) as ctx:
                    _resolve_workflow_file(None)
                self.assertEqual(ctx.exception.public()["code"], "workflow_not_configured")

    def test_payload_normalization(self) -> None:
        base = {"modality": "image", "prompt": "p", "parameters": {},
                "output_root": "/tmp"}
        for outputs in ([], ["a.png", "b.png"], "a.png", [42]):
            with self.assertRaises(ValueError):
                _normalize_drama({**base, "outputs": outputs})
        tool_base = {"prompt": "p", "output_dir": "outs"}
        for count in (0, 9, -1, "2", True):
            with self.assertRaises(ValueError):
                _normalize_tool({**tool_base, "count": count})
        self.assertEqual(_normalize_tool(tool_base)["count"], 1)
        with self.assertRaises(ValueError):
            _normalize_tool({"prompt": "  ", "output_dir": "outs"})
        with self.assertRaises(ValueError):
            _normalize_tool({"prompt": "p", "output_dir": "/tmp/outs"})

    def test_media_signatures(self) -> None:
        valid = {".png": b"\x89PNG\r\n\x1a\n" + b"\x00" * 8,
                 ".jpg": b"\xff\xd8\xff\xe0" + b"\x00" * 8,
                 ".jpeg": b"\xff\xd8\xff\xe1" + b"\x00" * 8,
                 ".webp": b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 4,
                 ".mp4": b"\x00\x00\x00\x18ftypisom" + b"\x00" * 4,
                 ".wav": b"RIFF\x00\x00\x00\x00WAVE" + b"\x00" * 4}
        for suffix, content in valid.items():
            self.assertTrue(_media_ok(suffix, content), suffix)
        for suffix, content in [(".png", b"not a png file...."), (".mp4", b"\x00" * 16),
                                (".mp3", b"ID3" + b"\x00" * 8), ("", PNG_BYTES),
                                (".png", b"")]:
            self.assertFalse(_media_ok(suffix, content), suffix)

    def test_error_envelope(self) -> None:
        failure = ComfyFailure("node blew up", code="node_error", http_status=400,
                               request_id="pid-1")
        self.assertEqual(failure.public(),
                         {"provider": "comfyui", "category": "provider",
                          "code": "node_error", "retryable": False,
                          "http_status": 400, "request_id": "pid-1"})
        self.assertNotIn("message", failure.public())

    def _drama_job(self, out_root: Path) -> dict[str, Any]:
        return {"modality": "image", "prompt": "a cat", "parameters": {"width": 512},
                "outputs": ["result/a.png"], "output_root": str(out_root)}

    def _success_history(self) -> dict[str, Any]:
        return {"pid-1": {"status": {"status_str": "success"},
                          "outputs": {"7": {"images": [
                              {"filename": "a_00001_.png", "subfolder": "",
                               "type": "output"}]}}}}

    def test_drama_success(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            workflow = _write_workflow(
                directory, "wf.json",
                {"3": {"inputs": {"text": "__PROMPT__", "width": "__WIDTH__",
                                  "seed": "__SEED__"}}})
            out_root = directory / "out"
            out_root.mkdir()
            with mock.patch.dict(os.environ, {"COMFYUI_WORKFLOW": str(workflow)},
                                 clear=True):
                with mock.patch("urllib.request.urlopen",
                                side_effect=_fake_urlopen_factory(self._success_history())):
                    response = _run_drama(self._drama_job(out_root))
            self.assertEqual(response["outputs"][0]["target"], "result/a.png")
            self.assertEqual(response["provider_job_id"], "pid-1")
            source = Path(response["outputs"][0]["source"])
            self.assertEqual(source, out_root / "result.png")
            self.assertEqual(source.read_bytes(), PNG_BYTES)

    def test_drama_failures(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            workflow = _write_workflow(
                directory, "wf.json", {"3": {"inputs": {"text": "__PROMPT__"}}})
            out_root = directory / "out"
            out_root.mkdir()
            node_error = {"pid-1": {"status": {"status_str": "error",
                                               "messages": [["exception", "boom"]]},
                                    "outputs": {}}}
            with mock.patch.dict(os.environ, {"COMFYUI_WORKFLOW": str(workflow)},
                                 clear=True):
                with mock.patch("urllib.request.urlopen",
                                side_effect=_fake_urlopen_factory(node_error)):
                    with self.assertRaises(ComfyFailure) as ctx:
                        _run_drama(self._drama_job(out_root))
                self.assertEqual(ctx.exception.public()["code"], "node_error")
                self.assertFalse(ctx.exception.public()["retryable"])
            env = {"COMFYUI_WORKFLOW": str(workflow), "COMFYUI_TIMEOUT_SECONDS": "1"}
            with mock.patch.dict(os.environ, env, clear=True):
                with mock.patch("urllib.request.urlopen",
                                side_effect=_fake_urlopen_factory({})):
                    with self.assertRaises(ComfyFailure) as ctx:
                        _run_drama(self._drama_job(out_root))
                self.assertEqual(ctx.exception.public()["code"], "comfyui_timeout")
                self.assertTrue(ctx.exception.public()["retryable"])

    def test_ignored_parameter_names(self) -> None:
        self.assertEqual(
            _ignored_names({"ratio": "9:16", "size": "large", "width": 512,
                            "mystery": None, "blank": ""}, DRAMA_KNOWN_PARAMETERS),
            ["ratio", "size"])
        self.assertEqual(_ignored_names({"prompt": "p", "output_dir": "o"},
                                        TOOL_KNOWN_FIELDS), [])
        with self.assertRaises(ValueError):
            _normalize_tool({"prompt": "p", "output_dir": "outs",
                             "filename_prefix": ".hidden"})

    def test_tool_count_two(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            workflow = _write_workflow(directory, "wf.json",
                                       {"3": {"inputs": {"seed": "__SEED__"}}})
            previous = os.getcwd()
            os.chdir(directory)
            try:
                with mock.patch.dict(os.environ, {"COMFYUI_WORKFLOW": str(workflow)},
                                     clear=True):
                    with mock.patch("urllib.request.urlopen", side_effect=
                                    _fake_urlopen_factory(self._success_history())):
                        response = _run_tool({"prompt": "p", "count": 2,
                                              "output_dir": "outs"})
            finally:
                os.chdir(previous)
            self.assertEqual(response["prompt_ids"], ["pid-1", "pid-1"])
            self.assertEqual(len(response["files"]), 2)
            self.assertIs(type(response["duration_ms"]), int)
            paths = [entry["path"] for entry in response["files"]]
            self.assertTrue(paths[0].endswith("-1.png"))
            self.assertTrue(paths[1].endswith("-2.png"))


if __name__ == "__main__":
    raise SystemExit(main())
