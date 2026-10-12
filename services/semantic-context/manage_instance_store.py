"""Operator-only CLI. This is not an API endpoint and never switches a running service."""
import argparse
import json
import sys
from app import read_instance_configuration, restore_state
from instance_backup import copy_verified_database, verify_database


def main():
    parser = argparse.ArgumentParser(description="Offline Semantica tenant database verification, backup and new-file restore")
    parser.add_argument("operation", choices=["verify", "backup", "restore"])
    parser.add_argument("--config", required=True, help="Absolute path to the instance identity configuration")
    parser.add_argument("--source", required=True, help="Existing absolute database path")
    parser.add_argument("--target", help="New absolute database path; existing files are never overwritten")
    args = parser.parse_args()
    if (args.operation == "verify") == bool(args.target):
        parser.error("verify takes no target; backup and restore require a new target")
    try:
        identity = read_instance_configuration({"SEMANTIC_INSTANCE_CONFIG_FILE": args.config})
        validate_snapshot = lambda snapshot: restore_state(snapshot, identity)
        if args.operation == "verify":
            result = verify_database(args.source, identity, validate_snapshot)
        else:
            result = copy_verified_database(args.source, args.target, identity, validate_snapshot)
        print(json.dumps({"operation": args.operation, **result}, ensure_ascii=False))
        return 0
    except Exception:
        print(json.dumps({"operation": args.operation, "status": "failed", "error": "SEMANTIC_OFFLINE_OPERATION_REJECTED",
                          "detail": "检查源文件、实例归属、服务是否已停止、快照完整性及新目标路径权限；未自动切换服务或覆盖已有文件。"}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
