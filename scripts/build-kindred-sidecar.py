"""Build one immutable Kindred XHS sidecar bundle on its target platform."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path
from typing import Any

NODE_VERSION = "22.18.0"
NODE_LICENSE_SHA256 = "de8f7d08b164a5b05d815cefdcdb332d38846379649b53956071522f63a5e777"
NODE_LICENSE_URL = (
    f"https://raw.githubusercontent.com/nodejs/node/v{NODE_VERSION}/LICENSE"
)
SERVICE_API_VERSION = "1"
NATIVE_PACKAGES = ("better-sqlite3", "canvas", "sharp")
CANVAS_BUILD_METADATA = (
    "Makefile",
    "binding.Makefile",
    "canvas.target.mk",
    "config.gypi",
    "gyp-mac-tool",
)
TARGETS = {
    ("Darwin", "arm64"): "macos-arm64",
    ("Linux", "x86_64"): "ubuntu-24.04-x86_64",
}


def run(*args: str, cwd: Path, capture: bool = False) -> str:
    result = subprocess.run(args, cwd=cwd, check=True, text=True, capture_output=capture)
    return result.stdout if capture else ""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def detect_target() -> str:
    target = TARGETS.get((platform.system(), platform.machine()))
    if not target:
        raise SystemExit(f"unsupported build host: {platform.system()} {platform.machine()}")
    if target.startswith("ubuntu"):
        release = Path("/etc/os-release").read_text(encoding="utf-8")
        if 'VERSION_ID="24.04"' not in release and "VERSION_ID=24.04" not in release:
            raise SystemExit("Linux release bundles must be built on Ubuntu 24.04")
    return target


def package_notices(stage: Path, node_version: str) -> list[dict[str, str]]:
    notices: dict[tuple[str, str], dict[str, str]] = {}
    for metadata in (stage / "node_modules").rglob("package.json"):
        try:
            package = json.loads(metadata.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        name, version = package.get("name"), package.get("version")
        if isinstance(name, str) and isinstance(version, str):
            license_value = package.get("license", "UNKNOWN")
            if not isinstance(license_value, str):
                license_value = "UNKNOWN"
            notices[(name, version)] = {"name": name, "version": version, "license": license_value}
    notices[("node", node_version)] = {
        "name": "node",
        "version": node_version,
        "license": "MIT and bundled third-party licenses",
        "notice": "node/LICENSE",
    }
    return [notices[key] for key in sorted(notices)]


def write_node_license(destination: Path) -> None:
    try:
        with urllib.request.urlopen(NODE_LICENSE_URL, timeout=30) as response:
            content = response.read()
    except OSError as error:
        raise SystemExit(
            "bundled Node runtime license could not be obtained"
        ) from error
    if hashlib.sha256(content).hexdigest() != NODE_LICENSE_SHA256:
        raise SystemExit("bundled Node runtime license checksum mismatch")
    destination.write_bytes(content)


def augment_sbom(raw: str, node_version: str) -> str:
    sbom = json.loads(raw)
    components = sbom.get("components")
    if not isinstance(components, list):
        raise SystemExit("npm SBOM has no component list")

    names = {item.get("name") for item in components if isinstance(item, dict)}
    missing = sorted(set(NATIVE_PACKAGES) - names)
    if missing:
        raise SystemExit(f"npm SBOM omits native packages: {', '.join(missing)}")
    components.append(
        {
            "type": "application",
            "bom-ref": f"pkg:generic/node@{node_version}",
            "name": "node",
            "version": node_version,
            "licenses": [{"license": {"name": "MIT and bundled third-party licenses"}}],
            "purl": f"pkg:generic/node@{node_version}",
            "properties": [{"name": "kindred:license-path", "value": "node/LICENSE"}],
        }
    )
    return json.dumps(sbom, ensure_ascii=False, indent=2) + "\n"


def members(stage: Path) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for path in sorted(stage.rglob("*")):
        if path.is_symlink():
            raise SystemExit(f"release member may not be a symlink: {path.relative_to(stage)}")
        if path.is_file() and path.name != "manifest.json":
            output.append(
                {
                    "path": path.relative_to(stage).as_posix(),
                    "bytes": path.stat().st_size,
                    "sha256": sha256(path),
                }
            )
    return output


def remove_native_build_metadata(stage: Path) -> None:
    build_dir = stage / "node_modules" / "canvas" / "build"
    for name in CANVAS_BUILD_METADATA:
        (build_dir / name).unlink(missing_ok=True)


def write_archive(stage: Path, destination: Path) -> None:
    with tempfile.NamedTemporaryFile(suffix=".tar", delete=False) as raw:
        raw_path = Path(raw.name)
    try:
        with tarfile.open(raw_path, "w") as archive:
            archive.add(
                stage,
                arcname=stage.name,
                recursive=True,
                filter=lambda info: _normalize_tar_info(info),
            )
        with raw_path.open("rb") as source, destination.open("wb") as target:
            with gzip.GzipFile(filename="", mode="wb", fileobj=target, mtime=0) as compressed:
                shutil.copyfileobj(source, compressed)
    finally:
        raw_path.unlink(missing_ok=True)


def _normalize_tar_info(info: tarfile.TarInfo) -> tarfile.TarInfo:
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mtime = 0
    return info


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=Path("release"))
    parser.add_argument("--target", choices=sorted(TARGETS.values()))
    args = parser.parse_args()

    repo = Path(__file__).resolve().parents[1]
    target = detect_target()
    if args.target and args.target != target:
        raise SystemExit(f"requested {args.target}, current host is {target}")
    node_version = run("node", "--version", cwd=repo, capture=True).strip().removeprefix("v")
    if node_version != NODE_VERSION:
        raise SystemExit(f"Node {NODE_VERSION} is required, found {node_version}")
    package = json.loads((repo / "package.json").read_text(encoding="utf-8"))
    version = package["version"]
    source_sha = run("git", "rev-parse", "HEAD", cwd=repo, capture=True).strip()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    stage = output_dir / f"kindred-xhs-sidecar-{version}-{target}"
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir()

    shutil.copytree(repo / "dist", stage / "dist")
    release_package = dict(package)
    release_package.pop("devDependencies", None)
    release_package["scripts"] = {}
    (stage / "package.json").write_text(json.dumps(release_package, indent=2) + "\n", encoding="utf-8")
    shutil.copy2(repo / "package-lock.json", stage / "package-lock.json")
    shutil.copy2(repo / "LICENSE", stage / "LICENSE")
    shutil.copy2(repo / "NOTICE", stage / "NOTICE")
    run("npm", "ci", "--omit=dev", "--ignore-scripts", cwd=stage)
    run("npm", "rebuild", *NATIVE_PACKAGES, cwd=stage)
    remove_native_build_metadata(stage)
    for bin_dir in (stage / "node_modules").rglob(".bin"):
        shutil.rmtree(bin_dir)

    node_executable = shutil.which("node")
    if not node_executable:
        raise SystemExit("Node executable was not found")
    node_binary = Path(node_executable).resolve()
    node_dir = stage / "node" / "bin"
    node_dir.mkdir(parents=True)
    shutil.copy2(node_binary, node_dir / "node")
    write_node_license(stage / "node" / "LICENSE")
    wrapper = stage / "bin" / "kindred-xhs"
    wrapper.parent.mkdir()
    wrapper.write_text(
        '#!/bin/sh\nROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\n'
        'exec "$ROOT/node/bin/node" "$ROOT/dist/kindred-operator.js" "$@"\n',
        encoding="utf-8",
    )
    wrapper.chmod(0o755)
    run(
        str(node_dir / "node"),
        "-e",
        "require('better-sqlite3');require('canvas');require('sharp')",
        cwd=stage,
    )

    (stage / "THIRD_PARTY_NOTICES.json").write_text(
        json.dumps(package_notices(stage, node_version), ensure_ascii=False, indent=2)
        + "\n",
        encoding="utf-8",
    )
    raw_sbom = run("npm", "sbom", "--omit=dev", "--sbom-format=cyclonedx", cwd=stage, capture=True)
    (stage / "sbom.cdx.json").write_text(augment_sbom(raw_sbom, node_version), encoding="utf-8")
    manifest = {
        "schema": 1,
        "name": "kindred-xhs-sidecar",
        "version": version,
        "source_sha": source_sha,
        "target": target,
        "node_version": node_version,
        "service_api_version": SERVICE_API_VERSION,
        "members": members(stage),
    }
    (stage / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    archive = output_dir / f"{stage.name}.tar.gz"
    archive.unlink(missing_ok=True)
    write_archive(stage, archive)
    (output_dir / f"{archive.name}.sha256").write_text(f"{sha256(archive)}  {archive.name}\n", encoding="utf-8")
    print(archive)


if __name__ == "__main__":
    main()
