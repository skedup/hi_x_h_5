from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from kindred_capability_xiaohongshu.client import (
    MCP_PROTOCOL_VERSION,
    McpClient,
    ProviderError,
    UnknownSideEffect,
)


def _response(request_id: int, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _transport(
    *,
    content_type: str = "application/json",
    service_version: object = "1",
    tool_result: dict[str, Any] | None = None,
    calls: list[str] | None = None,
) -> httpx.MockTransport:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "status": "ok",
                    "service_api_version": service_version,
                },
            )
        body = json.loads(request.content)
        if calls is not None:
            calls.append(body["method"])
        if body["method"] == "initialize":
            result = {"protocolVersion": MCP_PROTOCOL_VERSION}
        else:
            result = tool_result or {
                "content": [{"type": "text", "text": json.dumps({"count": 0, "items": []})}]
            }
        envelope = _response(body["id"], result)
        if content_type == "text/event-stream":
            return httpx.Response(
                200,
                text=f"event: message\ndata: {json.dumps(envelope)}\n\n",
                headers={"content-type": content_type},
            )
        return httpx.Response(200, json=envelope, headers={"content-type": content_type})

    return httpx.MockTransport(handle)


def _client(transport: httpx.BaseTransport) -> McpClient:
    return McpClient(
        base_url="http://127.0.0.1:18060",
        timeout=1,
        read_token="read-secret",
        write_token="write-secret",
        transport=transport,
    )


@pytest.mark.parametrize("content_type", ["application/json", "text/event-stream"])
def test_json_and_sse_response(content_type: str) -> None:
    calls: list[str] = []
    client = _client(_transport(content_type=content_type, calls=calls))
    try:
        assert client.call_tool("xhs_list_feeds", {}) == {"count": 0, "items": []}
        assert calls == ["initialize", "tools/call"]
        client.call_tool("xhs_list_feeds", {})
        assert calls == ["initialize", "tools/call", "tools/call"]
    finally:
        client.close()


@pytest.mark.parametrize("service_version", [None, "", "2"])
def test_service_api_version_fails_before_mcp(service_version: object) -> None:
    calls: list[str] = []
    client = _client(_transport(service_version=service_version, calls=calls))
    try:
        with pytest.raises(ProviderError, match="service API version"):
            client.call_tool("xhs_list_feeds", {})
        assert calls == []
    finally:
        client.close()


def test_json_rpc_and_tool_errors_are_safe() -> None:
    def rpc_error(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json={"status": "ok", "service_api_version": "1"})
        body = json.loads(request.content)
        if body["method"] == "initialize":
            result = _response(body["id"], {"protocolVersion": MCP_PROTOCOL_VERSION})
        else:
            result = {
                "jsonrpc": "2.0",
                "id": body["id"],
                "error": {"code": -1, "message": "secret"},
            }
        return httpx.Response(200, json=result)

    client = _client(httpx.MockTransport(rpc_error))
    try:
        with pytest.raises(ProviderError, match="code=-1") as caught:
            client.call_tool("xhs_list_feeds", {})
        assert "secret" not in str(caught.value)
    finally:
        client.close()

    client = _client(
        _transport(
            tool_result={
                "isError": True,
                "content": [{"type": "text", "text": "raw secret response"}],
            }
        )
    )
    try:
        with pytest.raises(ProviderError, match="returned an error") as caught:
            client.call_tool("xhs_list_feeds", {})
        assert "raw secret" not in str(caught.value)
    finally:
        client.close()


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(500),
        httpx.Response(200, text="{", headers={"content-type": "application/json"}),
        httpx.Response(200, text="data: nope\n\n", headers={"content-type": "text/event-stream"}),
        httpx.Response(200, text="plain", headers={"content-type": "text/plain"}),
    ],
)
def test_malformed_and_http_failures(response: httpx.Response) -> None:
    initialized = False

    def handle(request: httpx.Request) -> httpx.Response:
        nonlocal initialized
        if request.method == "GET":
            return httpx.Response(200, json={"status": "ok", "service_api_version": "1"})
        body = json.loads(request.content)
        if not initialized:
            initialized = True
            return httpx.Response(
                200,
                json=_response(body["id"], {"protocolVersion": MCP_PROTOCOL_VERSION}),
            )
        return response

    client = _client(httpx.MockTransport(handle))
    try:
        with pytest.raises(ProviderError):
            client.call_tool("xhs_list_feeds", {})
    finally:
        client.close()


def test_read_timeout_and_write_timeout_are_distinct() -> None:
    call_count = 0

    def handle(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        if request.method == "GET":
            return httpx.Response(200, json={"status": "ok", "service_api_version": "1"})
        body = json.loads(request.content)
        call_count += 1
        if call_count == 1:
            return httpx.Response(
                200,
                json=_response(body["id"], {"protocolVersion": MCP_PROTOCOL_VERSION}),
            )
        raise httpx.ReadTimeout("synthetic timeout")

    client = _client(httpx.MockTransport(handle))
    try:
        with pytest.raises(ProviderError, match="transport failed"):
            client.call_tool("xhs_list_feeds", {})
    finally:
        client.close()

    call_count = 0
    client = _client(httpx.MockTransport(handle))
    try:
        with pytest.raises(UnknownSideEffect):
            client.call_tool("xhs_like_feed", {})
    finally:
        client.close()


def test_non_allowlisted_tool_is_rejected_without_transport() -> None:
    client = _client(_transport())
    try:
        with pytest.raises(ProviderError, match="allowlisted"):
            client.call_tool("model_supplied_tool", {"token": "synthetic-secret"})
    finally:
        client.close()
