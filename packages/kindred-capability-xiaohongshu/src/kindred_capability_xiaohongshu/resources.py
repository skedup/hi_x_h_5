"""Package-owned Kindred resources."""

from pathlib import Path


def resource_root() -> Path:
    return Path(__file__).with_name("life_assets")


__all__ = ["resource_root"]
