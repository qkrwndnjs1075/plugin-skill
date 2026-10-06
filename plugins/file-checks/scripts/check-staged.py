# /// script
# requires-python = ">=3.10"
# dependencies = ["pre-commit-hooks==6.0.0"]
# ///
"""Check immutable staged blobs; third-party fixers only touch temporary copies."""

# How to run: uv run --script check-staged.py (inside a Git worktree).
from __future__ import annotations

import contextlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from pre_commit_hooks import (
    check_json,
    check_toml,
    check_yaml,
    end_of_file_fixer,
    mixed_line_ending,
    trailing_whitespace_fixer,
)


class CheckUnavailable(RuntimeError):
    """The staged input or a checker could not be read reliably."""


@dataclass(frozen=True, slots=True)
class Rule:
    name: str
    run: Callable[[Sequence[str]], int]
    args: tuple[str, ...] = ()
    extensions: frozenset[str] = frozenset()


RULE_GROUPS: Final = {
    "whitespace": (
        Rule("mixed-line-ending", mixed_line_ending.main, ("--fix=no",)),
        Rule(
            "trailing-whitespace",
            trailing_whitespace_fixer.main,
            ("--markdown-linebreak-ext=md,markdown,mdown,mkd",),
        ),
        Rule("end-of-file-fixer", end_of_file_fixer.main),
    ),
    "syntax": (
        Rule("check-json", check_json.main, extensions=frozenset({".json"})),
        # Syntax-only parsing accepts custom tags and multi-document YAML without
        # constructing application objects or imposing a YAML loader's tag policy.
        Rule("check-yaml", check_yaml.main, ("--unsafe",), frozenset({".yaml", ".yml"})),
        Rule("check-toml", check_toml.main, extensions=frozenset({".toml"})),
    ),
}


def git(args: Sequence[str]) -> bytes:
    """Preserve Git's hook/index environment, including partial-commit indexes."""
    result = subprocess.run(
        ["git", *args], capture_output=True, check=False, timeout=30,
    )
    if result.returncode != 0:
        raise CheckUnavailable("Git could not read the staged input; resolve index errors and retry.")
    return result.stdout


def changed_entries() -> tuple[tuple[str, str], ...]:
    raw = git([
        "diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-renames",
        "--no-ext-diff", "--no-textconv", "--diff-filter=ACMT",
    ])
    fields = raw.split(b"\0")
    if fields.pop() != b"" or len(fields) % 2:
        raise CheckUnavailable("Git returned an incomplete staged file list.")
    entries: list[tuple[str, str]] = []
    for index in range(0, len(fields), 2):
        metadata = re.fullmatch(
            rb":([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) [ACMT]",
            fields[index],
        )
        if metadata is None:
            raise CheckUnavailable("Git returned an unsupported staged entry.")
        if metadata[2] in {b"100644", b"100755"}:
            entries.append((os.fsdecode(fields[index + 1]), metadata[4].decode("ascii")))
    return tuple(entries)


@dataclass(frozen=True, slots=True)
class FileChecker:
    rules: tuple[Rule, ...]
    temporary: Path

    def check(self, path: str, content: bytes) -> tuple[str, ...]:
        extension = Path(path).suffix.lower()
        try:
            _ = content.decode("utf-8")
            is_text = b"\0" not in content
        except UnicodeDecodeError:
            is_text = False
        if not is_text:
            needs_syntax = any(extension in rule.extensions for rule in self.rules)
            return ("expected UTF-8 configuration text",) if needs_syntax else ()
        target = self.temporary / ("input" + extension)
        findings: list[str] = []
        for rule in self.rules:
            if rule.extensions and extension not in rule.extensions:
                continue
            _ = target.write_bytes(content)
            # Parser diagnostics can echo credentials from configuration values.
            # Only rule IDs and the original path leave this temporary inspection.
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                result = rule.run([*rule.args, str(target)])
            if result not in {0, 1}:
                raise CheckUnavailable(f"{rule.name} could not complete.")
            if result:
                findings.append(rule.name)
        return tuple(findings)


def main() -> int:
    if sys.argv[1:] == ["--probe"]:
        print("File Checks dependencies ready")
        return 0
    if sys.argv[1:]:
        raise CheckUnavailable("Usage: check-staged.py [--probe]")
    selected = tuple(
        rule
        for group, rules in RULE_GROUPS.items()
        if git(["config", "--type=bool", "--default=true", "--get", "file-checks." + group]).strip() == b"true"
        for rule in rules
    )
    if not selected:
        return 0
    before = git(["ls-files", "--stage", "-z"])
    findings: list[tuple[str, tuple[str, ...]]] = []
    with tempfile.TemporaryDirectory(prefix="file-checks-") as temporary:
        checker = FileChecker(selected, Path(temporary))
        for path, object_id in changed_entries():
            rules = checker.check(path, git(["cat-file", "blob", object_id]))
            if rules:
                findings.append((path, rules))
    if git(["ls-files", "--stage", "-z"]) != before:
        raise CheckUnavailable("The index changed during inspection; retry with stable staged content.")
    if findings:
        print("FILE_CHECKS_BLOCKED: fix the listed files and stage the corrections.", file=sys.stderr)
        for path, rules in findings:
            print(f"  {json.dumps(path, ensure_ascii=True)}: {', '.join(rules)}", file=sys.stderr)
        print("Working files and staged content were not modified.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (CheckUnavailable, OSError, subprocess.TimeoutExpired) as error:
        print(f"FILE_CHECKS_UNAVAILABLE: {error}", file=sys.stderr)
        raise SystemExit(2) from error
