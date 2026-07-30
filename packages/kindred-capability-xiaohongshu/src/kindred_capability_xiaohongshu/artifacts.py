"""XHS 发布所需 Artifact 的窄读取协议。"""

from __future__ import annotations

import zlib
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from kindred_capability_sdk import InvocationContext

COMPOSE_PROFILE = "kindred.compose.xiaohongshu.v1"
DRAW_PROFILE = "kindred.draw.image.v1"
FACT = "artifact.explicit_refs.v1"
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_IMAGES = 9
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class InvalidArtifact(ValueError):
    pass


@dataclass(frozen=True)
class ComposeBundle:
    artifact_ref: str
    title: str
    content: str


@dataclass(frozen=True)
class DrawImage:
    artifact_ref: str
    content: bytes


def read_compose_bundle(
    context: InvocationContext,
    artifact_ref: object,
    *,
    require_title: bool,
) -> ComposeBundle:
    ref = _artifact_ref(artifact_ref)
    reader = _reader(context, ref, COMPOSE_PROFILE)
    try:
        content = _read_text(reader.read_file(ref, "content.md", size_limit=64_000), "content.md")
        if not content.strip():
            raise InvalidArtifact("content.md is empty")
        title = ""
        if require_title:
            title = _read_text(reader.read_file(ref, "title.txt", size_limit=1_000), "title.txt")
            if not title.strip():
                raise InvalidArtifact("title.txt is empty")
    except InvalidArtifact:
        raise
    except Exception:
        raise InvalidArtifact("artifact bundle is unavailable") from None
    return ComposeBundle(ref, title.strip(), content.strip())


def read_draw_images(context: InvocationContext, artifact_refs: object) -> tuple[DrawImage, ...]:
    if not isinstance(artifact_refs, list) or not 1 <= len(artifact_refs) <= MAX_IMAGES:
        raise InvalidArtifact("image_artifact_refs must contain 1-9 items")
    refs = tuple(_artifact_ref(value) for value in artifact_refs)
    if len(set(refs)) != len(refs):
        raise InvalidArtifact("image_artifact_refs must be unique")
    images: list[DrawImage] = []
    for ref in refs:
        reader = _reader(context, ref, DRAW_PROFILE)
        try:
            content = reader.read_file(ref, "image.png", size_limit=MAX_IMAGE_BYTES)
        except Exception:
            raise InvalidArtifact("image artifact is unavailable") from None
        _validate_png(content)
        images.append(DrawImage(ref, content))
    return tuple(images)


def _artifact_ref(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise InvalidArtifact("artifact ref must be a non-empty string")
    return value.strip()


def _reader(context: InvocationContext, ref: str, profile: str) -> Any:
    fact = context.fact(FACT)
    artifacts = fact.value.get("artifacts") if fact is not None else None
    if not isinstance(artifacts, (tuple, list)):
        raise InvalidArtifact("artifact fact is unavailable")
    if not any(
        isinstance(item, Mapping)
        and item.get("artifact_ref") == ref
        and item.get("profile") == profile
        for item in artifacts
    ):
        raise InvalidArtifact("artifact ref is not committed for the current activity")
    reader = context.artifact_reader
    if reader is None:
        raise InvalidArtifact("artifact reader is unavailable")
    try:
        descriptor = reader.describe_committed(ref)
    except Exception:
        raise InvalidArtifact("artifact bundle is unavailable") from None
    if descriptor.artifact_ref != ref or descriptor.profile != profile:
        raise InvalidArtifact("artifact profile is incompatible")
    return reader


def _validate_png(value: bytes) -> None:
    if not value.startswith(_PNG_SIGNATURE):
        raise InvalidArtifact("image.png is invalid")
    cursor = len(_PNG_SIGNATURE)
    first = True
    seen_idat = False
    while cursor < len(value):
        if cursor + 12 > len(value):
            break
        length = int.from_bytes(value[cursor : cursor + 4], "big")
        end = cursor + 12 + length
        if end > len(value):
            break
        chunk_type = value[cursor + 4 : cursor + 8]
        chunk_data = value[cursor + 8 : cursor + 8 + length]
        expected_crc = int.from_bytes(value[cursor + 8 + length : end], "big")
        if zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF != expected_crc:
            break
        if first and (chunk_type != b"IHDR" or length != 13):
            break
        if first:
            width = int.from_bytes(chunk_data[:4], "big")
            height = int.from_bytes(chunk_data[4:8], "big")
            bit_depth, color_type, compression, filter_method, interlace = chunk_data[8:]
            valid_depths = {
                0: {1, 2, 4, 8, 16},
                2: {8, 16},
                3: {1, 2, 4, 8},
                4: {8, 16},
                6: {8, 16},
            }
            if (
                width == 0
                or height == 0
                or bit_depth not in valid_depths.get(color_type, set())
                or compression != 0
                or filter_method != 0
                or interlace not in {0, 1}
            ):
                break
        if chunk_type == b"IDAT" and length > 0:
            seen_idat = True
        if chunk_type == b"IEND":
            if length == 0 and seen_idat and end == len(value):
                return
            break
        first = False
        cursor = end
    raise InvalidArtifact("image.png is invalid")


def _read_text(value: bytes, label: str) -> str:
    try:
        return value.decode("utf-8")
    except UnicodeDecodeError:
        raise InvalidArtifact(f"{label} is not UTF-8") from None
