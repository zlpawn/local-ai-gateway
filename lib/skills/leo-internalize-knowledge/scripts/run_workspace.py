#!/usr/bin/env python3
"""Create, update, audit, and safely clean an internalization run workspace."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


OWNER = "leo-internalize-knowledge"
SCHEMA_VERSION = 1
RUN_PARENT = Path("leo") / "internalize-knowledge"
RUN_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
STATUSES = (
    "initialized",
    "reading",
    "proposal-ready",
    "blocked",
    "approved",
    "publishing",
    "published",
    "failed",
    "rejected",
)


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"error: {message}")


def metadata_path(run_dir: Path) -> Path:
    return run_dir / "run.yaml"


def read_metadata(run_dir: Path) -> dict[str, Any]:
    path = metadata_path(run_dir)
    if not path.is_file():
        fail(f"missing run metadata: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot read run metadata: {exc}")
    if not isinstance(data, dict):
        fail("run metadata must be an object")
    return data


def write_metadata(run_dir: Path, data: dict[str, Any]) -> None:
    data["updated_at"] = now_iso()
    metadata_path(run_dir).write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def default_run_id() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def validate_run_id(run_id: str) -> None:
    if not RUN_ID_PATTERN.fullmatch(run_id):
        fail("run ID must contain only letters, digits, dot, underscore, or hyphen")
    if run_id in {".", ".."}:
        fail("invalid run ID")


def validate_owned_run(run_dir_arg: str) -> tuple[Path, dict[str, Any]]:
    run_dir = Path(run_dir_arg).expanduser().resolve()
    data = read_metadata(run_dir)
    if data.get("schema_version") != SCHEMA_VERSION:
        fail("unsupported run metadata schema")
    if data.get("owner") != OWNER:
        fail("run is not owned by this skill")

    recorded_run = Path(str(data.get("run_dir", ""))).expanduser().resolve()
    recorded_parent = Path(str(data.get("run_parent", ""))).expanduser().resolve()
    workspace_root = Path(str(data.get("workspace_root", ""))).expanduser().resolve()
    expected_parent = (workspace_root / RUN_PARENT).resolve()

    if run_dir != recorded_run:
        fail("run path does not match recorded ownership path")
    if run_dir.parent != recorded_parent or recorded_parent != expected_parent:
        fail("run is not directly inside its recorded workspace parent")
    if run_dir == recorded_parent or recorded_parent == workspace_root:
        fail("unsafe cleanup boundary")
    return run_dir, data


def cmd_init(args: argparse.Namespace) -> None:
    workspace_root = Path(args.workspace).expanduser().resolve()
    target_root = Path(args.target_root).expanduser().resolve()
    run_id = args.run_id or default_run_id()
    validate_run_id(run_id)

    run_parent = (workspace_root / RUN_PARENT).resolve()
    run_dir = (run_parent / run_id).resolve()
    if run_dir.parent != run_parent:
        fail("run path escaped its workspace parent")
    if run_dir.exists():
        fail(f"run already exists: {run_dir}")

    directories = (
        "source",
        "media/original",
        "media/previews",
        "extraction",
        "proposal",
    )
    for relative in directories:
        (run_dir / relative).mkdir(parents=True, exist_ok=False)

    created_at = now_iso()
    data: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "owner": OWNER,
        "run_id": run_id,
        "workspace_root": str(workspace_root),
        "run_parent": str(run_parent),
        "run_dir": str(run_dir),
        "source": args.source,
        "target_root": str(target_root),
        "verification_mode": args.verification,
        "status": "initialized",
        "created_at": created_at,
        "updated_at": created_at,
        "artifacts": [],
        "audit": {"result": "not-run", "notes": []},
    }
    write_metadata(run_dir, data)
    print(run_dir)


def cmd_set_status(args: argparse.Namespace) -> None:
    run_dir, data = validate_owned_run(args.run_dir)
    data["status"] = args.status
    if args.artifact:
        artifacts = data.setdefault("artifacts", [])
        for artifact in args.artifact:
            if artifact not in artifacts:
                artifacts.append(artifact)
    write_metadata(run_dir, data)
    print(f"{run_dir}: {args.status}")


def cmd_record_audit(args: argparse.Namespace) -> None:
    run_dir, data = validate_owned_run(args.run_dir)
    notes = list(args.note or [])
    data["audit"] = {
        "result": args.result,
        "checked_at": now_iso(),
        "notes": notes,
    }
    write_metadata(run_dir, data)
    print(f"{run_dir}: audit={args.result}")


def cmd_show(args: argparse.Namespace) -> None:
    run_dir, data = validate_owned_run(args.run_dir)
    print(json.dumps(data, ensure_ascii=False, indent=2))


def cmd_cleanup(args: argparse.Namespace) -> None:
    run_dir, data = validate_owned_run(args.run_dir)
    if data.get("status") != "published":
        fail("cleanup requires status=published")
    audit = data.get("audit")
    if not isinstance(audit, dict) or audit.get("result") != "pass":
        fail("cleanup requires a passing audit")
    if not run_dir.is_dir() or run_dir.is_symlink():
        fail("run directory is missing or is a symlink")

    shutil.rmtree(run_dir)
    print(f"removed owned run: {run_dir}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser("init", help="create a new run workspace")
    init_parser.add_argument("--source", required=True)
    init_parser.add_argument("--target-root", required=True)
    init_parser.add_argument("--workspace", default=".")
    init_parser.add_argument("--run-id")
    init_parser.add_argument(
        "--verification",
        choices=("none", "light", "targeted"),
        default="light",
    )
    init_parser.set_defaults(func=cmd_init)

    status_parser = subparsers.add_parser("set-status", help="update run status")
    status_parser.add_argument("--run-dir", required=True)
    status_parser.add_argument("--status", choices=STATUSES, required=True)
    status_parser.add_argument("--artifact", action="append")
    status_parser.set_defaults(func=cmd_set_status)

    audit_parser = subparsers.add_parser("record-audit", help="record audit result")
    audit_parser.add_argument("--run-dir", required=True)
    audit_parser.add_argument("--result", choices=("pass", "fail"), required=True)
    audit_parser.add_argument("--note", action="append")
    audit_parser.set_defaults(func=cmd_record_audit)

    show_parser = subparsers.add_parser("show", help="show run metadata")
    show_parser.add_argument("--run-dir", required=True)
    show_parser.set_defaults(func=cmd_show)

    cleanup_parser = subparsers.add_parser(
        "cleanup",
        help="remove an owned, published, audited run",
    )
    cleanup_parser.add_argument("--run-dir", required=True)
    cleanup_parser.set_defaults(func=cmd_cleanup)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
