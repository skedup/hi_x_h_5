from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass, field

import pytest
from kindred_capability_sdk import (
    ArtifactDescriptor,
    FactView,
    InvocationContext,
    TransientStore,
)

from kindred_capability_xiaohongshu.artifacts import (
    COMPOSE_PROFILE,
    DRAW_PROFILE,
    FACT,
    MAX_IMAGE_BYTES,
    InvalidArtifact,
    read_compose_bundle,
    read_draw_images,
)


@dataclass(frozen=True)
class Bundle:
    profile: str
    files: dict[str, bytes]
    producer: str = "test"


@dataclass
class Reader:
    bundles: dict[str, Bundle]
    unavailable: set[str] = field(default_factory=set)
    reads: list[tuple[str, str]] = field(default_factory=list)

    def describe_committed(self, artifact_ref: str) -> ArtifactDescriptor:
        if artifact_ref in self.unavailable:
            raise ValueError("not committed")
        bundle = self.bundles[artifact_ref]
        return ArtifactDescriptor(artifact_ref, bundle.producer, bundle.profile)

    def read_file(self, artifact_ref: str, relative_path: str, *, size_limit: int) -> bytes:
        self.reads.append((artifact_ref, relative_path))
        value = self.bundles[artifact_ref].files[relative_path]
        if len(value) > size_limit:
            raise ValueError("too large")
        return value


def _context(
    reader: Reader,
    *,
    visible_refs: tuple[str, ...] | None = None,
) -> InvocationContext:
    refs = tuple(reader.bundles) if visible_refs is None else visible_refs
    return InvocationContext(
        tick_id=1,
        triggered_at=None,
        facts=(
            FactView(
                FACT,
                {
                    "artifacts": [
                        {
                            "artifact_ref": ref,
                            "producer": reader.bundles[ref].producer,
                            "profile": reader.bundles[ref].profile,
                        }
                        for ref in refs
                    ]
                },
            ),
        ),
        transient=TransientStore(),
        artifact_reader=reader,
    )


def _png(
    red: int = 0,
    *,
    width: int = 1,
    height: int = 1,
    bit_depth: int = 8,
    color_type: int = 6,
    include_idat: bool = True,
) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, bit_depth, color_type, 0, 0, 0)
    pixels = zlib.compress(b"\x00" + bytes((red, 0, 0, 255)))
    body = chunk(b"IHDR", header)
    if include_idat:
        body += chunk(b"IDAT", pixels)
    return b"\x89PNG\r\n\x1a\n" + body + chunk(b"IEND", b"")


def test_reads_committed_compose_profile() -> None:
    reader = Reader(
        {
            "artifact:text": Bundle(
                COMPOSE_PROFILE,
                {"title.txt": "标题".encode(), "content.md": "正文".encode()},
            )
        }
    )
    bundle = read_compose_bundle(
        _context(reader),
        "artifact:text",
        require_title=True,
    )
    assert bundle.title == "标题"
    assert bundle.content == "正文"


@pytest.mark.parametrize(
    ("ref", "profile"),
    [
        ("artifact:other", COMPOSE_PROFILE),
        ("artifact:text", "kindred.compose.outbound.v1"),
    ],
)
def test_unknown_current_run_or_profile_is_rejected(ref: str, profile: str) -> None:
    reader = Reader({"artifact:text": Bundle(profile, {"content.md": b"text"})})
    with pytest.raises(InvalidArtifact):
        read_compose_bundle(
            _context(reader),
            ref,
            require_title=False,
        )


def test_comment_read_does_not_read_draw_artifacts() -> None:
    reader = Reader(
        {
            "artifact:text": Bundle(COMPOSE_PROFILE, {"content.md": b"comment"}),
            "artifact:image": Bundle(DRAW_PROFILE, {"image.png": _png()}),
        }
    )
    bundle = read_compose_bundle(
        _context(reader),
        "artifact:text",
        require_title=False,
    )
    assert bundle.title == ""
    assert reader.reads == [("artifact:text", "content.md")]


@pytest.mark.parametrize("files", [{}, {"content.md": b"content"}])
def test_missing_required_compose_file_is_invalid_artifact(files: dict[str, bytes]) -> None:
    reader = Reader({"artifact:text": Bundle(COMPOSE_PROFILE, files)})
    with pytest.raises(InvalidArtifact, match="unavailable"):
        read_compose_bundle(
            _context(reader),
            "artifact:text",
            require_title=True,
        )


def test_reads_one_to_nine_draw_images_in_input_order() -> None:
    refs = tuple(f"artifact:image-{index}" for index in range(1, 10))
    reader = Reader(
        {
            ref: Bundle(DRAW_PROFILE, {"image.png": _png(index)})
            for index, ref in enumerate(refs, start=1)
        }
    )
    images = read_draw_images(_context(reader), list(reversed(refs)))
    assert [image.artifact_ref for image in images] == list(reversed(refs))
    assert [image.content for image in images] == [_png(index) for index in reversed(range(1, 10))]


@pytest.mark.parametrize(
    "refs",
    [
        None,
        "artifact:image",
        [],
        ["artifact:image"] * 10,
        ["artifact:image", "artifact:image"],
        ["artifact:image", 1],
    ],
)
def test_invalid_draw_ref_list_is_rejected(refs: object) -> None:
    reader = Reader({"artifact:image": Bundle(DRAW_PROFILE, {"image.png": _png()})})
    with pytest.raises(InvalidArtifact):
        read_draw_images(_context(reader), refs)


def test_draw_ref_must_be_visible_committed_and_use_draw_profile() -> None:
    reader = Reader(
        {
            "artifact:image": Bundle(DRAW_PROFILE, {"image.png": _png()}),
            "artifact:text": Bundle(COMPOSE_PROFILE, {"image.png": _png()}),
        },
        unavailable={"artifact:image"},
    )
    with pytest.raises(InvalidArtifact):
        read_draw_images(_context(reader, visible_refs=("artifact:text",)), ["artifact:image"])
    with pytest.raises(InvalidArtifact):
        read_draw_images(_context(reader), ["artifact:text"])
    with pytest.raises(InvalidArtifact):
        read_draw_images(_context(reader), ["artifact:image"])


@pytest.mark.parametrize(
    "image",
    [
        b"",
        b"not-png",
        _png()[:-1],
        _png()[:-8] + b"\x00\x00\x00\x00IEND\x00\x00\x00\x00",
        _png(include_idat=False),
        _png(width=0),
        _png(height=0),
        _png(bit_depth=4, color_type=6),
    ],
)
def test_invalid_png_is_rejected(image: bytes) -> None:
    reader = Reader({"artifact:image": Bundle(DRAW_PROFILE, {"image.png": image})})
    with pytest.raises(InvalidArtifact):
        read_draw_images(_context(reader), ["artifact:image"])


def test_oversized_png_is_rejected() -> None:
    image = b"x" * (MAX_IMAGE_BYTES + 1)
    reader = Reader({"artifact:image": Bundle(DRAW_PROFILE, {"image.png": image})})
    with pytest.raises(InvalidArtifact):
        read_draw_images(_context(reader), ["artifact:image"])


def test_missing_image_member_is_rejected() -> None:
    reader = Reader({"artifact:image": Bundle(DRAW_PROFILE, {})})
    with pytest.raises(InvalidArtifact, match="unavailable"):
        read_draw_images(_context(reader), ["artifact:image"])
