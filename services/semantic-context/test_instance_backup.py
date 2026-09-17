"""Synthetic-only offline backup/restore and no-overwrite regression tests."""
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from instance_store import InstanceStore
from instance_backup import copy_verified_database, verify_database

IDENTITY = {"tenantId": "backup-test-a", "deploymentId": "backup-instance-a"}


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="semantic-backup-")
        self.root = Path(self.directory.name)
        self.source = str(self.root / "source.db")
        self.target = str(self.root / "backup.db")
        store = InstanceStore(self.source, IDENTITY)
        store.save({"version": 1, "synthetic": ["A", "B"]}); store.save({"version": 1, "synthetic": ["A", "B", "C"]})
        store.close()
        self.before = Path(self.source).read_bytes()

    def tearDown(self):
        self.directory.cleanup()

    @staticmethod
    def validate(value):
        if value != {"version": 1, "synthetic": ["A", "B", "C"]}:
            raise ValueError("Invalid synthetic fixture")

    def test_backup_restore_preserve_revision_data_and_original_bytes(self):
        result = copy_verified_database(self.source, self.target, IDENTITY, self.validate)
        self.assertEqual(result["revision"], 2); self.assertFalse(result["overwritten"])
        restored = str(self.root / "restored.db")
        copy_verified_database(self.target, restored, IDENTITY, self.validate)
        self.assertEqual(verify_database(restored, IDENTITY, self.validate)["revision"], 2)
        self.assertEqual(Path(self.source).read_bytes(), self.before)
        self.assertEqual(list(self.root.glob(".semantic-copy-*")), [])

    def test_existing_targets_and_same_file_cannot_be_overwritten(self):
        Path(self.target).write_bytes(b"preserve target")
        for target in [self.source, self.target]:
            with self.assertRaisesRegex(ValueError, "MUST_BE_NEW"):
                copy_verified_database(self.source, target, IDENTITY, self.validate)
        self.assertEqual(Path(self.target).read_bytes(), b"preserve target")
        self.assertEqual(Path(self.source).read_bytes(), self.before)

    def test_missing_source_never_creates_a_new_database(self):
        missing = str(self.root / "missing.db")
        with self.assertRaisesRegex(ValueError, "SOURCE_REQUIRED"):
            copy_verified_database(missing, self.target, IDENTITY, self.validate)
        self.assertFalse(Path(missing).exists()); self.assertFalse(Path(self.target).exists())

    def test_other_tenant_or_deployment_cannot_backup_or_restore(self):
        for identity in [{**IDENTITY, "tenantId": "other"}, {**IDENTITY, "deploymentId": "other"}]:
            with self.assertRaisesRegex(ValueError, "OWNER_MISMATCH"):
                copy_verified_database(self.source, self.target, identity, self.validate)
        self.assertFalse(Path(self.target).exists())
        self.assertEqual(Path(self.source).read_bytes(), self.before)

    def test_running_instance_blocks_offline_operation(self):
        active = InstanceStore(self.source, IDENTITY)
        try:
            with self.assertRaisesRegex(ValueError, "UNAVAILABLE"):
                copy_verified_database(self.source, self.target, IDENTITY, self.validate)
        finally:
            active.close()
        self.assertFalse(Path(self.target).exists())

    def test_checksum_and_semantic_validation_both_gate_output(self):
        with self.assertRaises(ValueError):
            copy_verified_database(self.source, self.target, IDENTITY, lambda _value: (_ for _ in ()).throw(ValueError("schema")))
        db = sqlite3.connect(self.source)
        try:
            with db:
                db.execute("UPDATE snapshot SET body=?", (json.dumps({}),))
        finally:
            db.close()
        with self.assertRaisesRegex(ValueError, "CHECKSUM_FAILED"):
            copy_verified_database(self.source, self.target, IDENTITY, self.validate)
        self.assertFalse(Path(self.target).exists())

    def test_publish_failure_leaves_source_unchanged_and_no_partial_target(self):
        with patch("instance_backup.os.link", side_effect=OSError("synthetic disk failure")) as publish:
            with self.assertRaises(OSError):
                copy_verified_database(self.source, self.target, IDENTITY, self.validate)
            publish.assert_called_once()
        self.assertFalse(Path(self.target).exists()); self.assertEqual(Path(self.source).read_bytes(), self.before)
        self.assertEqual(list(self.root.glob(".semantic-copy-*")), [])

    def test_concurrently_created_target_is_never_replaced(self):
        def collision(_source, target):
            Path(target).write_bytes(b"concurrent owner")
            raise FileExistsError()
        with patch("instance_backup.os.link", side_effect=collision):
            with self.assertRaises(FileExistsError):
                copy_verified_database(self.source, self.target, IDENTITY, self.validate)
        self.assertEqual(Path(self.target).read_bytes(), b"concurrent owner")
        self.assertEqual(list(self.root.glob(".semantic-copy-*")), [])

    def test_read_only_store_rejects_saving(self):
        store = InstanceStore(self.source, IDENTITY, read_only=True)
        try:
            with self.assertRaisesRegex(ValueError, "READ_ONLY"):
                store.save({})
        finally:
            store.close()


if __name__ == "__main__":
    unittest.main()
