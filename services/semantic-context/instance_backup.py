"""Offline backup/restore: validate both copies and publish a new file without overwrite."""
import os
from pathlib import Path
import sqlite3
import tempfile
from instance_store import InstanceStore


def verify_database(source, identity, validate_snapshot):
    store = InstanceStore(source, identity, read_only=True)
    try:
        validate_snapshot(store.load())
        return {"status": "verified", "tenantId": store.owner["tenantId"],
                "deploymentId": store.owner["deploymentId"], "revision": store.revision}
    finally:
        store.close()


def copy_verified_database(source, target, identity, validate_snapshot):
    target_path = Path(target)
    if not target_path.is_absolute() or target_path.is_symlink():
        raise ValueError("SEMANTIC_BACKUP_TARGET_INVALID")
    target_path = target_path.resolve()
    if target_path.exists() or not target_path.parent.is_dir():
        raise ValueError("SEMANTIC_BACKUP_TARGET_MUST_BE_NEW")
    store = InstanceStore(source, identity, read_only=True)
    temporary = None
    try:
        original = store.load()
        validate_snapshot(original)
        descriptor, temporary_name = tempfile.mkstemp(prefix=".semantic-copy-", suffix=".db", dir=target_path.parent)
        os.close(descriptor)
        temporary = Path(temporary_name)
        destination = sqlite3.connect(str(temporary))
        try:
            store.connection.backup(destination)
        finally:
            destination.close()
        copied = InstanceStore(str(temporary), identity, read_only=True)
        try:
            snapshot = copied.load()
            validate_snapshot(snapshot)
            if snapshot != original or copied.revision != store.revision:
                raise ValueError("SEMANTIC_BACKUP_VERIFICATION_FAILED")
        finally:
            copied.close()
        with temporary.open("r+b") as stream:
            os.fsync(stream.fileno())
        # Unlike replace/rename on POSIX, link cannot replace a concurrently created target.
        # Both files live on the same filesystem. Unsupported filesystems fail closed.
        os.link(temporary, target_path)
        return {"status": "completed", "tenantId": store.owner["tenantId"],
                "deploymentId": store.owner["deploymentId"], "revision": store.revision, "overwritten": False}
    finally:
        store.close()
        if temporary is not None:
            temporary.unlink(missing_ok=True)
            Path(str(temporary) + ".lock").unlink(missing_ok=True)
