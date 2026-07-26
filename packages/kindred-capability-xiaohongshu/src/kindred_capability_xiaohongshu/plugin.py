"""Kindred Portable 小红书能力入口。"""

from __future__ import annotations

import hashlib
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from kindred_capability_sdk import (
    CapabilityContribution,
    CapabilityResult,
    InvocationContext,
    SecretResolver,
    ToolBinding,
    ToolCall,
    ToolDef,
    ToolResult,
)

from .artifacts import FACT, PROFILE, InvalidArtifact, read_compose_bundle
from .client import McpClient, ProviderError, UnknownSideEffect
from .session import (
    MAX_RESULTS,
    THIRD_PARTY_NOTICE,
    InvalidRef,
    TickRuntime,
    project_detail,
    project_feeds,
    project_my_posts,
    project_notifications,
    project_profile,
)

WriteMode = Literal["none", "dry_run", "live"]
DEFAULT_DISCOVERY_LIMIT = 5
MAX_COMMENT_CHARS = 180

READ_TOOLS = (
    "xiaohongshu_list_feeds",
    "xiaohongshu_search",
    "xiaohongshu_feed_detail",
    "xiaohongshu_user_profile",
    "xiaohongshu_my_posts",
    "xiaohongshu_notifications",
)
WRITE_TOOLS = (
    "xiaohongshu_publish_post",
    "xiaohongshu_comment_post",
    "xiaohongshu_reply_comment",
    "xiaohongshu_like_post",
    "xiaohongshu_favorite_post",
    "xiaohongshu_like_comment",
)


@dataclass(frozen=True)
class Settings:
    mcp_url: str
    timeout: float
    write_mode: WriteMode

    @classmethod
    def parse(cls, raw: Mapping[str, Any]) -> Settings:
        unknown = set(raw) - {"mcp_url", "timeout", "write_mode"}
        if unknown:
            raise ValueError(f"unknown xiaohongshu settings: {sorted(unknown)}")
        url = raw.get("mcp_url")
        if not isinstance(url, str) or not url.strip():
            raise ValueError("xiaohongshu mcp_url must be configured")
        parsed = urlsplit(url.strip())
        if (
            parsed.scheme != "http"
            or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("xiaohongshu mcp_url must be a loopback HTTP URL")
        timeout = raw.get("timeout", 45.0)
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
            raise ValueError("xiaohongshu timeout must be numeric")
        if not 0 < float(timeout) <= 120:
            raise ValueError("xiaohongshu timeout is outside the supported range")
        mode = raw.get("write_mode", "none")
        if mode not in {"none", "dry_run", "live"}:
            raise ValueError("xiaohongshu write_mode is invalid")
        return cls(url.strip(), float(timeout), mode)


def _object(
    properties: Mapping[str, Any],
    *,
    required: tuple[str, ...] = (),
) -> dict[str, Any]:
    return {
        "type": "OBJECT",
        "properties": dict(properties),
        "required": list(required),
        "additionalProperties": False,
    }


def _tool(
    name: str,
    description: str,
    properties: Mapping[str, Any],
    *,
    required: tuple[str, ...] = (),
    write: bool = False,
) -> ToolDef:
    return ToolDef(
        name,
        description,
        _object(properties, required=required),
        "external_side_effect" if write else "read_only",
    )


_LIMIT_5 = {"type": "INTEGER", "description": "Maximum result count, 1-10. Defaults to 5."}
_LIMIT_10 = {"type": "INTEGER", "description": "Maximum result count, 1-10. Defaults to 10."}
_FEED_REF = {"type": "STRING", "description": "Opaque feed_ref returned in this tool loop."}
_COMMENT_REF = {"type": "STRING", "description": "Opaque comment_ref returned in this tool loop."}
_ARTIFACT_REF = {
    "type": "STRING",
    "description": "Committed Xiaohongshu compose artifact_ref from the current activity.",
}

_DESCRIPTIONS = {
    READ_TOOLS[0]: "Read the current Xiaohongshu feed with opaque short-lived refs.",
    READ_TOOLS[1]: "Search Xiaohongshu and return compact facts with opaque refs.",
    READ_TOOLS[2]: "Read one feed by a feed_ref returned in this tool loop.",
    READ_TOOLS[3]: "Read one profile by a user_ref returned in this tool loop.",
    READ_TOOLS[4]: "Read posts published by the current Xiaohongshu account.",
    READ_TOOLS[5]: "Read Xiaohongshu notifications; private messages are unsupported.",
    WRITE_TOOLS[0]: "Publish a committed compose artifact; raw content is rejected.",
    WRITE_TOOLS[1]: "Comment on a selected post using a committed compose artifact.",
    WRITE_TOOLS[2]: "Reply to a selected comment using a committed compose artifact.",
    WRITE_TOOLS[3]: "Like a post selected earlier in this tool loop.",
    WRITE_TOOLS[4]: "Favorite a post selected earlier in this tool loop.",
    WRITE_TOOLS[5]: "Like a comment selected earlier in this tool loop.",
}
_PROPERTIES: dict[str, Mapping[str, Any]] = {
    READ_TOOLS[0]: {"limit": _LIMIT_5},
    READ_TOOLS[1]: {"keyword": {"type": "STRING"}, "limit": _LIMIT_5},
    READ_TOOLS[2]: {"feed_ref": _FEED_REF},
    READ_TOOLS[3]: {"user_ref": {"type": "STRING"}},
    READ_TOOLS[4]: {"limit": _LIMIT_10},
    READ_TOOLS[5]: {
        "kind": {"type": "STRING", "enum": ["all", "mentions", "likes", "connections"]},
        "limit": _LIMIT_10,
    },
    WRITE_TOOLS[0]: {"artifact_ref": _ARTIFACT_REF},
    WRITE_TOOLS[1]: {"feed_ref": _FEED_REF, "artifact_ref": _ARTIFACT_REF},
    WRITE_TOOLS[2]: {
        "feed_ref": _FEED_REF,
        "comment_ref": _COMMENT_REF,
        "artifact_ref": _ARTIFACT_REF,
    },
    WRITE_TOOLS[3]: {"feed_ref": _FEED_REF},
    WRITE_TOOLS[4]: {"feed_ref": _FEED_REF},
    WRITE_TOOLS[5]: {"feed_ref": _FEED_REF, "comment_ref": _COMMENT_REF},
}
_REQUIRED = {
    READ_TOOLS[1]: ("keyword",),
    READ_TOOLS[2]: ("feed_ref",),
    READ_TOOLS[3]: ("user_ref",),
    WRITE_TOOLS[0]: ("artifact_ref",),
    WRITE_TOOLS[1]: ("feed_ref", "artifact_ref"),
    WRITE_TOOLS[2]: ("feed_ref", "comment_ref", "artifact_ref"),
    WRITE_TOOLS[3]: ("feed_ref",),
    WRITE_TOOLS[4]: ("feed_ref",),
    WRITE_TOOLS[5]: ("feed_ref", "comment_ref"),
}
_TOOL_DEFS = tuple(
    _tool(
        name,
        _DESCRIPTIONS[name],
        _PROPERTIES[name],
        required=_REQUIRED.get(name, ()),
        write=name in WRITE_TOOLS,
    )
    for name in READ_TOOLS + WRITE_TOOLS
)


def create_capability(
    *,
    settings: Mapping[str, Any],
    secrets: SecretResolver,
) -> CapabilityContribution:
    parsed = Settings.parse(settings)
    client = McpClient(
        base_url=parsed.mcp_url,
        timeout=parsed.timeout,
        read_token=secrets.get("readonly_bearer_token"),
        write_token=secrets.get("bearer_token"),
    )

    def handle(call: ToolCall, context: InvocationContext) -> CapabilityResult:
        result = (
            _handle_read(call, context, client)
            if call.name in READ_TOOLS
            else _handle_write(call, context, client, parsed.write_mode)
        )
        return CapabilityResult(result)

    definitions = _TOOL_DEFS if parsed.write_mode != "none" else _TOOL_DEFS[: len(READ_TOOLS)]
    services = frozenset({"artifact_reader"}) if parsed.write_mode != "none" else frozenset()
    facts = frozenset({FACT}) if parsed.write_mode != "none" else frozenset()
    profiles = frozenset({PROFILE}) if parsed.write_mode != "none" else frozenset()
    return CapabilityContribution(
        tuple(ToolBinding(tool_def, handle) for tool_def in definitions),
        required_host_services=services,
        required_fact_views=facts,
        consumed_artifact_profiles=profiles,
        close=client.close,
    )


def _handle_read(call: ToolCall, context: InvocationContext, client: McpClient) -> ToolResult:
    runtime = _runtime(context)
    try:
        if call.name == READ_TOOLS[0]:
            _require_keys(call, {"limit"})
            runtime.consume_read(detail=False)
            limit = _limit(call.args.get("limit"), DEFAULT_DISCOVERY_LIMIT)
            feeds = project_feeds(client.call_tool("xhs_list_feeds", {}), runtime, limit)
            return _ok_read(call, "feeds", feeds, count=len(feeds))
        if call.name == READ_TOOLS[1]:
            _require_keys(call, {"keyword", "limit"})
            keyword = call.args.get("keyword")
            if not isinstance(keyword, str) or not keyword.strip():
                return _error(call, "InvalidArgs", "keyword must be a non-empty string")
            runtime.consume_read(detail=False)
            limit = _limit(call.args.get("limit"), DEFAULT_DISCOVERY_LIMIT)
            payload = client.call_tool(
                "xhs_search",
                {"keyword": keyword.strip(), "count": limit, "timeout": 60_000},
            )
            feeds = project_feeds(payload, runtime, limit)
            return _ok_read(call, "feeds", feeds, count=len(feeds))
        if call.name == READ_TOOLS[2]:
            _require_keys(call, {"feed_ref"})
            feed_ref = call.args.get("feed_ref")
            feed = runtime.feed(feed_ref)
            runtime.consume_read(detail=True)
            payload = client.call_tool(
                "xhs_get_note",
                {"noteId": feed.identifier, "xsecToken": feed.token, "describeImages": False},
            )
            projected = project_detail(
                payload,
                runtime=runtime,
                feed_ref=str(feed_ref),
                feed_id=feed.identifier,
            )
            return _ok_read(call, "feed", projected)
        if call.name == READ_TOOLS[3]:
            _require_keys(call, {"user_ref"})
            user_ref = call.args.get("user_ref")
            user = runtime.user(user_ref)
            runtime.consume_read(detail=True)
            args = {"userId": user.identifier}
            if user.token:
                args["xsecToken"] = user.token
            profile = project_profile(
                client.call_tool("xhs_user_profile", args),
                runtime=runtime,
                user_ref=str(user_ref),
            )
            return _ok_read(call, "profile", profile)
        if call.name == READ_TOOLS[4]:
            _require_keys(call, {"limit"})
            runtime.consume_read(detail=False)
            limit = _limit(call.args.get("limit"), MAX_RESULTS)
            payload = client.call_tool(
                "xhs_get_my_notes",
                {"tab": 0, "limit": limit, "timeout": 60_000},
            )
            return _ok_read(
                call,
                "my_posts",
                project_my_posts(payload, runtime=runtime, limit=limit),
            )
        if call.name == READ_TOOLS[5]:
            _require_keys(call, {"kind", "limit"})
            kind = call.args.get("kind", "all")
            if kind not in {"all", "mentions", "likes", "connections"}:
                return _error(call, "InvalidArgs", "notification kind is invalid")
            runtime.consume_read(detail=False)
            limit = _limit(call.args.get("limit"), MAX_RESULTS)
            payload = client.call_tool("xhs_get_notifications", {"type": kind, "limit": limit})
            return _ok_read(
                call,
                "notifications",
                project_notifications(payload, runtime=runtime, limit=limit),
            )
    except InvalidRef as exc:
        return _error(call, "InvalidRef", str(exc))
    except ProviderError:
        return _error(call, "ProviderError", "xiaohongshu provider request failed")
    except RuntimeError:
        return _error(call, "BudgetExceeded", "xiaohongshu read budget is exhausted")
    except (TypeError, ValueError):
        return _error(call, "ProviderChanged", "xiaohongshu provider response is incompatible")
    return _error(call, "Unsupported", "xiaohongshu tool is unsupported")


def _handle_write(
    call: ToolCall,
    context: InvocationContext,
    client: McpClient,
    mode: WriteMode,
) -> ToolResult:
    runtime = _runtime(context)
    try:
        operation, invoke = _prepare_write(call, context, runtime, client, mode == "live")
        fingerprint = hashlib.sha256("|".join(operation).encode()).hexdigest()
        previous = runtime.operations.get(fingerprint)
        if previous is True:
            return ToolResult.ok(
                call,
                {"ok": True, "mode": mode, "status": "already_done", "already_done": True},
            )
        if previous is False:
            return _error(call, "UnknownSideEffect", "write outcome is unknown")
        if mode == "dry_run":
            return ToolResult.ok(
                call,
                {"ok": True, "mode": mode, "status": "dry_run", "dry_run": True},
            )
        try:
            result = invoke()
        except UnknownSideEffect:
            runtime.operations[fingerprint] = False
            raise
        runtime.operations[fingerprint] = True
        return ToolResult.ok(call, {"ok": True, "mode": mode, **result})
    except InvalidRef as exc:
        return _error(call, "InvalidRef", str(exc))
    except InvalidArtifact as exc:
        return _error(call, "InvalidArtifact", str(exc))
    except UnknownSideEffect:
        return _error(call, "UnknownSideEffect", "write outcome is unknown")
    except ProviderError:
        return _error(call, "ProviderError", "xiaohongshu provider request failed")
    except RuntimeError:
        return _error(call, "BudgetExceeded", "xiaohongshu interaction budget is exhausted")
    except (TypeError, ValueError):
        return _error(call, "InvalidArgs", "xiaohongshu write arguments are invalid")


def _prepare_write(
    call: ToolCall,
    context: InvocationContext,
    runtime: TickRuntime,
    client: McpClient,
    reserve_interaction: bool,
) -> tuple[tuple[str, ...], Callable[[], dict[str, Any]]]:
    if call.name == WRITE_TOOLS[0]:
        _require_keys(call, {"artifact_ref"}, exact=True)
        bundle = read_compose_bundle(
            context,
            call.args.get("artifact_ref"),
            require_title=True,
            include_assets=True,
        )
        if not bundle.assets:
            raise InvalidArtifact("publish artifact has no indexed image")

        def publish() -> dict[str, Any]:
            with tempfile.TemporaryDirectory(prefix="kindred-xhs-") as directory:
                image_paths: list[str] = []
                for name, content in bundle.assets:
                    target = Path(directory) / name
                    target.write_bytes(content)
                    image_paths.append(str(target))
                draft = client.call_tool(
                    "xhs_create_draft",
                    {"title": bundle.title, "content": bundle.content, "images": image_paths},
                )
                draft_id = draft.get("draftId")
                if draft.get("success") is not True or not isinstance(draft_id, str):
                    raise ProviderError("draft creation failed")
                published = _successful_write(
                    _call_side_effect(client, "xhs_publish_draft", {"draftId": draft_id})
                )
                note_id = published.get("noteId")
                return {
                    "status": "published",
                    "post_ref": _opaque_result("post", note_id),
                    "image_count": len(bundle.assets),
                }

        return ("publish", bundle.artifact_ref), publish

    if call.name in {WRITE_TOOLS[1], WRITE_TOOLS[2]}:
        expected = (
            {"feed_ref", "artifact_ref"}
            if call.name == WRITE_TOOLS[1]
            else {"feed_ref", "comment_ref", "artifact_ref"}
        )
        _require_keys(call, expected, exact=True)
        feed = runtime.feed(call.args.get("feed_ref"))
        comment = (
            runtime.comment(call.args.get("comment_ref"), feed_id=feed.identifier)
            if call.name == WRITE_TOOLS[2]
            else None
        )
        bundle = read_compose_bundle(
            context,
            call.args.get("artifact_ref"),
            require_title=False,
            include_assets=False,
        )
        if len(bundle.content) > MAX_COMMENT_CHARS:
            raise InvalidArtifact(f"comment content exceeds {MAX_COMMENT_CHARS} characters")
        target = comment.identifier if comment else feed.identifier
        if reserve_interaction:
            runtime.reserve_interaction(target)
        upstream = "xhs_reply_comment" if comment else "xhs_post_comment"

        def comment_write() -> dict[str, Any]:
            args = {
                "noteId": feed.identifier,
                "xsecToken": feed.token,
                "content": bundle.content,
            }
            if comment:
                args["commentId"] = comment.identifier
            result = _successful_write(_call_side_effect(client, upstream, args))
            created = result.get("commentId")
            return {
                "status": "completed",
                "comment_ref": (
                    runtime.remember_comment(str(created), feed.identifier) if created else ""
                ),
            }

        operation = (
            "reply" if comment else "comment",
            feed.identifier,
            target,
            bundle.artifact_ref,
        )
        return operation, comment_write

    expected = {"feed_ref", "comment_ref"} if call.name == WRITE_TOOLS[5] else {"feed_ref"}
    _require_keys(call, expected, exact=True)
    feed = runtime.feed(call.args.get("feed_ref"))
    comment = (
        runtime.comment(call.args.get("comment_ref"), feed_id=feed.identifier)
        if call.name == WRITE_TOOLS[5]
        else None
    )
    target = comment.identifier if comment else feed.identifier
    if reserve_interaction:
        runtime.reserve_interaction(target)
    upstream = {
        WRITE_TOOLS[3]: "xhs_like_feed",
        WRITE_TOOLS[4]: "xhs_favorite_feed",
        WRITE_TOOLS[5]: "xhs_like_comment",
    }[call.name]

    def toggle() -> dict[str, Any]:
        args = {"noteId": feed.identifier, "xsecToken": feed.token}
        if comment:
            args["commentId"] = comment.identifier
        result = _successful_write(_call_side_effect(client, upstream, args))
        already = result.get("alreadyDone") is True
        return {
            "status": "already_done" if already else "completed",
            "already_done": already,
        }

    return (call.name, feed.identifier, target), toggle


def _runtime(context: InvocationContext) -> TickRuntime:
    value = context.transient.setdefault("runtime", TickRuntime())
    if not isinstance(value, TickRuntime):
        raise ValueError("xiaohongshu transient runtime is incompatible")
    return value


def _successful_write(payload: dict[str, Any]) -> dict[str, Any]:
    result = payload.get("result")
    if payload.get("success") is not True:
        if payload.get("sideEffectPossible") is True:
            raise UnknownSideEffect("write outcome is unknown")
        raise ProviderError("write failed")
    if isinstance(result, dict):
        if result.get("success") is not True:
            if result.get("sideEffectPossible") is True:
                raise UnknownSideEffect("write outcome is unknown")
            raise ProviderError("write failed")
        return result
    return payload


def _call_side_effect(
    client: McpClient,
    tool_name: str,
    args: Mapping[str, Any],
) -> dict[str, Any]:
    try:
        return client.call_tool(tool_name, args)
    except ProviderError:
        raise UnknownSideEffect("write outcome is unknown") from None


def _opaque_result(kind: str, value: object) -> str:
    if not isinstance(value, str) or not value:
        return ""
    digest = hashlib.sha256(value.encode()).hexdigest()[:16]
    return f"xhs-{kind}:{digest}"


def _require_keys(call: ToolCall, allowed: set[str], *, exact: bool = False) -> None:
    keys = set(call.args)
    if not keys <= allowed or (exact and keys != allowed):
        raise ValueError("unexpected tool arguments")


def _limit(value: object, default: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return default
    return max(1, min(value, MAX_RESULTS))


def _ok_read(
    call: ToolCall,
    key: str,
    value: Any,
    *,
    count: int | None = None,
) -> ToolResult:
    response = {
        "ok": True,
        "source": "xiaohongshu",
        key: value,
        "third_party_content_notice": THIRD_PARTY_NOTICE,
    }
    if count is not None:
        response["count"] = count
    return ToolResult.ok(call, response)


def _error(call: ToolCall, error_type: str, message: str) -> ToolResult:
    return ToolResult.error(call, error_type=error_type, message=message)


__all__ = ["READ_TOOLS", "WRITE_TOOLS", "create_capability"]
