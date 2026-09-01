"""hi_x_h_5 Streamable HTTP 的最小客户端。"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

import httpx

SERVICE_API_VERSION = "1"
MCP_PROTOCOL_VERSION = "2025-06-18"
PACKAGE_VERSION = "0.3.2"
PUBLISH_DRAFT_TIMEOUT_SECONDS = 240.0

_READ_TOOLS = frozenset(
    {
        "xhs_list_feeds",
        "xhs_search",
        "xhs_get_note",
        "xhs_user_profile",
        "xhs_get_my_notes",
        "xhs_get_notifications",
    }
)
_WRITE_TOOLS = frozenset(
    {
        "xhs_create_draft",
        "xhs_publish_draft",
        "xhs_post_comment",
        "xhs_reply_comment",
        "xhs_like_feed",
        "xhs_favorite_feed",
        "xhs_like_comment",
    }
)


class ProviderError(RuntimeError):
    """上游明确失败，调用方可以安全停止。"""


class UnknownSideEffect(ProviderError):
    """写请求断连或超时，结果未知且不得自动重试。"""


class McpClient:
    def __init__(
        self,
        *,
        base_url: str,
        timeout: float,
        read_token: str | None,
        write_token: str | None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        root = base_url.rstrip("/")
        self._health_url = f"{root}/health"
        self._mcp_url = f"{root}/mcp"
        self._read_token = read_token or write_token
        self._write_token = write_token
        self._timeout = timeout
        self._client = httpx.Client(timeout=timeout, transport=transport, trust_env=False)
        self._request_id = 0
        self._ready = False

    def close(self) -> None:
        self._client.close()

    def call_tool(self, name: str, arguments: Mapping[str, Any]) -> dict[str, Any]:
        if name not in _READ_TOOLS | _WRITE_TOOLS:
            raise ProviderError("MCP tool is not allowlisted")
        self._ensure_ready()
        write = name in _WRITE_TOOLS
        try:
            result = self._rpc(
                "tools/call",
                {"name": name, "arguments": dict(arguments)},
                token=self._write_token if write else self._read_token,
                timeout=(
                    PUBLISH_DRAFT_TIMEOUT_SECONDS if name == "xhs_publish_draft" else self._timeout
                ),
            )
        except (httpx.TimeoutException, httpx.TransportError):
            error: ProviderError = (
                UnknownSideEffect("write outcome is unknown")
                if write
                else ProviderError("MCP transport failed")
            )
            raise error from None
        if result.get("isError") is True:
            raise ProviderError("MCP tool returned an error")
        content = result.get("content")
        if not isinstance(content, list) or not content:
            raise ProviderError("MCP tool response has no content")
        first = content[0]
        if not isinstance(first, dict) or first.get("type") != "text":
            raise ProviderError("MCP tool response has unsupported content")
        text = first.get("text")
        if not isinstance(text, str):
            raise ProviderError("MCP tool text is missing")
        try:
            payload = json.loads(text)
        except (TypeError, ValueError):
            raise ProviderError("MCP tool text is not JSON") from None
        if not isinstance(payload, dict):
            raise ProviderError("MCP tool payload is not an object")
        return payload

    def _ensure_ready(self) -> None:
        if self._ready:
            return
        try:
            response = self._client.get(self._health_url)
        except (httpx.TimeoutException, httpx.TransportError):
            raise ProviderError("health request failed") from None
        if response.status_code != 200:
            raise ProviderError(f"health returned status {response.status_code}")
        try:
            health = response.json()
        except ValueError:
            raise ProviderError("health response is not JSON") from None
        if not isinstance(health, dict) or health.get("status") != "ok":
            raise ProviderError("health response is malformed")
        if health.get("service_api_version") != SERVICE_API_VERSION:
            raise ProviderError("service API version is incompatible")
        try:
            initialized = self._rpc(
                "initialize",
                {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {
                        "name": "kindred-capability-xiaohongshu",
                        "version": PACKAGE_VERSION,
                    },
                },
                token=self._read_token or self._write_token,
                timeout=self._timeout,
            )
        except (httpx.TimeoutException, httpx.TransportError):
            raise ProviderError("MCP initialize failed") from None
        if initialized.get("protocolVersion") != MCP_PROTOCOL_VERSION:
            raise ProviderError("MCP initialize response is incompatible")
        self._ready = True

    def _rpc(
        self,
        method: str,
        params: Mapping[str, Any],
        *,
        token: str | None,
        timeout: float,
    ) -> dict[str, Any]:
        self._request_id += 1
        request_id = self._request_id
        headers = {
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        response = self._client.post(
            self._mcp_url,
            headers=headers,
            json={
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": dict(params),
            },
            timeout=timeout,
        )
        if response.status_code != 200:
            raise ProviderError(f"MCP returned status {response.status_code}")
        payload = _decode_response(response, request_id)
        response_id = payload.get("id")
        if (
            payload.get("jsonrpc") != "2.0"
            or type(response_id) is not int
            or response_id != request_id
        ):
            raise ProviderError("MCP response envelope is incompatible")
        error = payload.get("error")
        if error is not None:
            code = error.get("code") if isinstance(error, dict) else None
            safe_code = code if type(code) is int else "unknown"
            raise ProviderError(f"MCP JSON-RPC error code={safe_code}")
        result = payload.get("result")
        if not isinstance(result, dict):
            raise ProviderError("MCP response has no result object")
        return result


def _decode_response(response: httpx.Response, request_id: int) -> dict[str, Any]:
    media_type = response.headers.get("content-type", "").partition(";")[0].strip().lower()
    try:
        if media_type == "application/json":
            payload: Any = response.json()
        elif media_type == "text/event-stream":
            matches: list[dict[str, Any]] = []
            for line in response.text.splitlines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data or data == "[DONE]":
                    continue
                event = json.loads(data)
                if isinstance(event, dict) and event.get("id") == request_id:
                    matches.append(event)
            payload = matches[0] if len(matches) == 1 else None
        else:
            raise ProviderError("MCP response content type is unsupported")
    except (TypeError, ValueError):
        raise ProviderError("MCP response is malformed") from None
    if not isinstance(payload, dict):
        raise ProviderError("MCP response root is not an object")
    return payload
