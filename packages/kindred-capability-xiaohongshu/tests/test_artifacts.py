from __future__ import annotations

from dataclasses import dataclass

import pytest
from kindred_capability_sdk import (
    ArtifactDescriptor,
    FactView,
    InvocationContext,
    TransientStore,
)

from kindred_capability_xiaohongshu.artifacts import (
    FACT,
    PROFILE,
    InvalidArtifact,
    read_compose_bundle,
)


@dataclass
class Reader:
    files: dict[str, bytes]
    profile: str = PROFILE

    def describe_committed(self, artifact_ref: str) -> ArtifactDescriptor:
        return ArtifactDescriptor(artifact_ref, "compose", self.profile)

    def read_file(self, artifact_ref: str, relative_path: str, *, size_limit: int) -> bytes:
        del artifact_ref
        value = self.files[relative_path]
        if len(value) > size_limit:
            raise ValueError("too large")
        return value


def _context(reader: Reader, *, ref: str = "artifact:one") -> InvocationContext:
    return InvocationContext(
        tick_id=1,
        triggered_at=None,
        facts=(
            FactView(
                FACT,
                {"artifacts": [{"artifact_ref": ref, "producer": "compose", "profile": PROFILE}]},
            ),
        ),
        transient=TransientStore(),
        artifact_reader=reader,
    )


def test_reads_committed_profile_and_indexed_assets() -> None:
    reader = Reader(
        {
            "title.txt": "标题".encode(),
            "content.md": "正文".encode(),
            "assets/index.json": b'{"files":["assets/one.png"]}',
            "assets/one.png": b"\x89PNG\r\n\x1a\n",
        }
    )
    bundle = read_compose_bundle(
        _context(reader),
        "artifact:one",
        require_title=True,
        include_assets=True,
    )
    assert bundle.title == "标题"
    assert bundle.content == "正文"
    assert bundle.assets == (("one.png", b"\x89PNG\r\n\x1a\n"),)


@pytest.mark.parametrize(
    ("ref", "profile"),
    [("artifact:other", PROFILE), ("artifact:one", "kindred.compose.outbound.v1")],
)
def test_unknown_current_run_or_profile_is_rejected(ref: str, profile: str) -> None:
    reader = Reader({"content.md": b"text"}, profile=profile)
    with pytest.raises(InvalidArtifact):
        read_compose_bundle(
            _context(reader),
            ref,
            require_title=False,
            include_assets=False,
        )


@pytest.mark.parametrize(
    "index",
    [
        b"not-json",
        b'{"files":"assets/one.png"}',
        b'{"files":["../one.png"]}',
        b'{"files":["assets/nested/one.png"]}',
        b'{"files":["assets/one.exe"]}',
        b'{"files":["assets/one.png","assets/one.png"]}',
        b'{"files":["assets/1.png","assets/2.png","assets/3.png","assets/4.png","assets/5.png","assets/6.png","assets/7.png","assets/8.png","assets/9.png","assets/10.png"]}',
    ],
)
def test_invalid_asset_index_is_rejected(index: bytes) -> None:
    reader = Reader(
        {
            "title.txt": b"title",
            "content.md": b"content",
            "assets/index.json": index,
            "assets/one.png": b"image",
        }
    )
    with pytest.raises(InvalidArtifact):
        read_compose_bundle(
            _context(reader),
            "artifact:one",
            require_title=True,
            include_assets=True,
        )


def test_comment_read_does_not_enumerate_or_read_assets() -> None:
    reader = Reader({"content.md": b"comment"})
    bundle = read_compose_bundle(
        _context(reader),
        "artifact:one",
        require_title=False,
        include_assets=False,
    )
    assert bundle.title == ""
    assert bundle.assets == ()


@pytest.mark.parametrize("files", [{}, {"content.md": b"content"}])
def test_missing_required_file_is_invalid_artifact(files: dict[str, bytes]) -> None:
    with pytest.raises(InvalidArtifact, match="unavailable"):
        read_compose_bundle(
            _context(Reader(files)),
            "artifact:one",
            require_title=True,
            include_assets=False,
        )
