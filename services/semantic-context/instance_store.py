"""Single-instance SQLite snapshot. No credentials, pickle or implicit recovery."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3

MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024


class InstanceStore:
    def __init__(self, location, identity, read_only=False):
        self.connection = None
        self.lock_file = None
        self.revision = 0
        self.read_only = read_only
        if not identity or not Path(location).is_absolute():
            raise ValueError("SEMANTIC_STORE_CONFIGURATION_INVALID")
        self.path = Path(location).resolve()
        if not self.path.parent.is_dir():
            raise ValueError("SEMANTIC_STORE_PARENT_REQUIRED")
        if read_only and not self.path.is_file():
            raise ValueError("SEMANTIC_STORE_SOURCE_REQUIRED")
        self.owner = {"version": 1, "tenantId": identity["tenantId"], "deploymentId": identity["deploymentId"]}
        try:
            self.lock_file = open(str(self.path) + ".lock", "a+b")
            self.lock_file.seek(0)
            if os.name == "nt":
                import msvcrt
                if not self.lock_file.read(1):
                    self.lock_file.write(b"0")
                    self.lock_file.flush()
                self.lock_file.seek(0)
                msvcrt.locking(self.lock_file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            existing = self.path.exists()
            self.connection = sqlite3.connect(self.path.as_uri() + "?mode=ro" if read_only else str(self.path),
                                              uri=read_only, timeout=2, check_same_thread=False)
            if self.connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("integrity")
            if not existing:
                with self.connection:
                    self.connection.execute("CREATE TABLE owner (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL)")
                    self.connection.execute("CREATE TABLE snapshot (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL)")
                    self.connection.execute("INSERT INTO owner VALUES (1, ?)", (json.dumps(self.owner, sort_keys=True),))
            row = self.connection.execute("SELECT identity FROM owner WHERE id=1").fetchone()
            if not row or json.loads(row[0]) != self.owner:
                raise ValueError("owner mismatch")
            if read_only:
                self.connection.execute("PRAGMA query_only=ON")
            else:
                self.connection.execute("PRAGMA journal_mode=DELETE")
                self.connection.execute("PRAGMA synchronous=FULL")
            self.existing = existing
        except Exception:
            self.close()
            raise ValueError("SEMANTIC_STORE_UNAVAILABLE_OR_OWNER_MISMATCH") from None

    def load(self):
        row = self.connection.execute("SELECT revision, body, digest FROM snapshot WHERE id=1").fetchone()
        if row is None:
            if self.existing:
                raise ValueError("SEMANTIC_SNAPSHOT_MISSING")
            return None
        revision, body, digest = row
        if not isinstance(revision, int) or revision < 1 or len(body.encode("utf-8")) > MAX_SNAPSHOT_BYTES:
            raise ValueError("SEMANTIC_SNAPSHOT_INVALID")
        if hashlib.sha256(body.encode("utf-8")).hexdigest() != digest:
            raise ValueError("SEMANTIC_SNAPSHOT_CHECKSUM_FAILED")
        self.revision = revision
        return json.loads(body)

    def save(self, value):
        if self.read_only:
            raise ValueError("SEMANTIC_STORE_READ_ONLY")
        body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
        encoded = body.encode("utf-8")
        if len(encoded) > MAX_SNAPSHOT_BYTES:
            raise ValueError("SEMANTIC_SNAPSHOT_CAPACITY")
        revision = self.revision + 1
        with self.connection:
            self.connection.execute("INSERT OR REPLACE INTO snapshot VALUES (1, ?, ?, ?)",
                                    (revision, body, hashlib.sha256(encoded).hexdigest()))
        self.revision = revision

    def close(self):
        if self.connection is not None:
            self.connection.close()
            self.connection = None
        if self.lock_file is not None:
            self.lock_file.close()  # OS releases the exclusive lock, including after a crash.
            self.lock_file = None
