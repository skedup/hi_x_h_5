"""XHS compose bundle 的窄读取协议。"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any

from kindred_capability_sdk import InvocationContext

PROFILE = "kindred.compose.xiaohongshu.v1"
FACT = "artifact.explicit_refs.v1"
_IMAGE_SUFFIXES = frozenset({".jpg", ".jpeg", ".png", ".webp"})


class InvalidArtifact(ValueError):
    pass


@dataclass(frozen=True)
class ComposeBundle:
    artifact_ref: str
    title: str
    content: str
    assets: tuple[tuple[str, bytes], ...]


def read_compose_bundle(
    context: InvocationContext,
    artifact_ref: object,
    *,
    require_title: bool,
    include_assets: bool,
) -> ComposeBundle:
    if not isinstance(artifact_ref, str) or not artifact_ref.strip():
        raise InvalidArtifact("artifact_ref must be a non-empty string")
    ref = artifact_ref.strip()
    fact = context.fact(FACT)
    artifacts = fact.value.get("artifacts") if fact is not None else None
    if not isinstance(artifacts, (tuple, list)):
        raise InvalidArtifact("artifact fact is unavailable")
    visible = any(
        isinstance(item, Mapping)
        and item.get("artifact_ref") == ref
        and item.get("profile") == PROFILE
        for item in artifacts
    )
    if not visible:
        raise InvalidArtifact("artifact_ref is not committed for the current activity")
    reader = context.artifact_reader
    if reader is None:
        raise InvalidArtifact("artifact reader is unavailable")
    try:
        descriptor = reader.describe_committed(ref)
        if descriptor.artifact_ref != ref or descriptor.profile != PROFILE:
            raise InvalidArtifact("artifact profile is incompatible")
        content = _read_text(reader.read_file(ref, "content.md", size_limit=64_000), "content.md")
        if not content.strip():
            raise InvalidArtifact("content.md is empty")
        title = ""
        if require_title:
            title = _read_text(reader.read_file(ref, "title.txt", size_limit=1_000), "title.txt")
            if not title.strip():
                raise InvalidArtifact("title.txt is empty")
        assets = _read_assets(reader, ref) if include_assets else ()
    except InvalidArtifact:
        raise
    except Exception:
        raise InvalidArtifact("artifact bundle is unavailable") from None
    return ComposeBundle(ref, title.strip(), content.strip(), assets)


def _read_assets(reader: Any, ref: str) -> tuple[tuple[str, bytes], ...]:
    try:
        raw_index = reader.read_file(ref, "assets/index.json", size_limit=4_000)
    except Exception:
        return ()
    try:
        index = json.loads(raw_index.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise InvalidArtifact("assets/index.json is invalid") from None
    files = index.get("files") if isinstance(index, dict) else None
    if not isinstance(files, list) or len(files) > 9:
        raise InvalidArtifact("assets index files are invalid")
    assets: list[tuple[str, bytes]] = []
    seen: set[str] = set()
    for item in files:
        if not isinstance(item, str) or item in seen:
            raise InvalidArtifact("assets index contains an invalid member")
        path = PurePosixPath(item)
        if (
            len(path.parts) != 2
            or path.parts[0] != "assets"
            or path.name in {"", ".", ".."}
            or path.suffix.lower() not in _IMAGE_SUFFIXES
        ):
            raise InvalidArtifact("assets index member is outside the profile contract")
        seen.add(item)
        assets.append((path.name, reader.read_file(ref, item, size_limit=20 * 1024 * 1024)))
    return tuple(assets)


def _read_text(value: bytes, label: str) -> str:
    try:
        return value.decode("utf-8")
    except UnicodeDecodeError:
        raise InvalidArtifact(f"{label} is not UTF-8") from None
