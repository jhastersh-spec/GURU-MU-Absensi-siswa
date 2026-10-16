import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

_bootstrap_directory = tempfile.TemporaryDirectory(prefix="guru-mu-tests-")
os.environ.setdefault("ADMIN_USERNAME", "GURU MU")
os.environ.setdefault("ADMIN_PASSWORD", "MASUK AJA123")
os.environ.setdefault("DATABASE_PATH", str(Path(_bootstrap_directory.name) / "bootstrap.db"))
os.environ.setdefault("SECRET_KEY", "test-bootstrap-secret-key-that-is-at-least-32-characters")

from app import create_app


class AttendanceApplicationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="guru-mu-case-")
        self.app = create_app({
            "TESTING": True,
            "SECRET_KEY": "test-secret-key",
            "DATABASE_PATH": str(Path(self.directory.name) / "attendance.db"),
            "ADMIN_USERNAME": "GURU MU",
            "ADMIN_PASSWORD": "MASUK AJA123",
            "SESSION_COOKIE_SECURE": False,
        })
        self.client = self.app.test_client()
        self.csrf = self.client.get("/api/auth").get_json()["csrf_token"]
        self.headers = {"X-CSRF-Token": self.csrf}

    def tearDown(self):
        self.directory.cleanup()

    def login(self):
        response = self.client.post("/api/login", json={
            "username": "GURU MU",
            "password": "MASUK AJA123",
        }, headers=self.headers)
        self.assertEqual(response.status_code, 200)
        result = response.get_json()
        self.headers["X-CSRF-Token"] = result["csrf_token"]

    def add_student(self, nis="NIS-001", name="Andi Pratama"):
        return self.client.post("/api/students", json={
            "name": name,
            "nis": nis,
            "class_name": "7A",
            "photo_url": "",
        }, headers=self.headers)

    def test_admin_routes_require_login_and_password_is_hashed(self):
        self.assertEqual(self.client.get("/api/dashboard").status_code, 401)
        self.assertEqual(self.client.post("/api/login", json={
            "username": "GURU MU", "password": "salah",
        }, headers=self.headers).status_code, 401)
        self.login()
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as db:
            db.row_factory = sqlite3.Row
            user = db.execute("SELECT password_hash FROM users").fetchone()
            self.assertNotEqual(user["password_hash"], "MASUK AJA123")
            self.assertTrue(user["password_hash"].startswith("scrypt:"))
        self.assertTrue(self.client.get("/api/dashboard").get_json()["summary"]["total_students"] == 0)

    def test_secure_cookie_setting_and_unknown_report_period(self):
        secure_app = create_app({
            "TESTING": True,
            "SECRET_KEY": "secure-cookie-test-secret",
            "DATABASE_PATH": str(Path(self.directory.name) / "secure-cookie.db"),
            "ADMIN_USERNAME": "GURU MU",
            "ADMIN_PASSWORD": "MASUK AJA123",
            "SESSION_COOKIE_SECURE": True,
        })
        secure_client = secure_app.test_client()
        csrf = secure_client.get("/api/auth").get_json()["csrf_token"]
        response = secure_client.post("/api/login", json={
            "username": "GURU MU", "password": "MASUK AJA123",
        }, headers={"X-CSRF-Token": csrf})
        self.assertIn("Secure", response.headers["Set-Cookie"])
        self.assertIn("HttpOnly", response.headers["Set-Cookie"])
        self.assertIn("SameSite=Lax", response.headers["Set-Cookie"])
        self.assertIn("Expires=", response.headers["Set-Cookie"])

        self.login()
        invalid_period = self.client.get("/api/reports?period=yearly")
        self.assertEqual(invalid_period.status_code, 400)

    def test_default_password_opens_dashboard_and_optional_rotation_revokes_other_sessions(self):
        logged_in = self.client.post("/api/login", json={
            "username": "GURU MU", "password": "MASUK AJA123",
        }, headers=self.headers)
        self.assertEqual(logged_in.status_code, 200)
        self.assertFalse(logged_in.get_json()["must_change_password"])
        self.headers["X-CSRF-Token"] = logged_in.get_json()["csrf_token"]
        self.assertEqual(self.client.get("/api/dashboard").status_code, 200)

        second_client = self.app.test_client()
        second_csrf = second_client.get("/api/auth").get_json()["csrf_token"]
        second_login = second_client.post("/api/login", json={
            "username": "GURU MU", "password": "MASUK AJA123",
        }, headers={"X-CSRF-Token": second_csrf})
        self.assertEqual(second_login.status_code, 200)
        self.assertFalse(second_login.get_json()["must_change_password"])

        rotated = self.client.post("/api/settings/password", json={
            "current_password": "MASUK AJA123",
            "new_password": "SecureGuruPassword123!",
        }, headers=self.headers)
        self.assertEqual(rotated.status_code, 200)
        self.assertEqual(self.client.get("/api/dashboard").status_code, 200)
        self.assertEqual(second_client.get("/api/dashboard").status_code, 401)
        fresh_csrf = second_client.get("/api/auth").get_json()["csrf_token"]
        relogin = second_client.post("/api/login", json={
            "username": "GURU MU", "password": "SecureGuruPassword123!",
        }, headers={"X-CSRF-Token": fresh_csrf})
        self.assertEqual(relogin.status_code, 200)
        self.assertFalse(relogin.get_json()["must_change_password"])

    def test_login_attempts_are_rate_limited(self):
        statuses = []
        csrf = self.csrf
        for _ in range(5):
            response = self.client.post("/api/login", json={
                "username": "GURU MU", "password": "wrong-password",
            }, headers={"X-CSRF-Token": csrf})
            statuses.append(response.status_code)
        self.assertEqual(statuses, [401, 401, 401, 401, 429])
        blocked = self.client.post("/api/login", json={
            "username": "GURU MU", "password": "MASUK AJA123",
        }, headers={"X-CSRF-Token": csrf})
        self.assertEqual(blocked.status_code, 429)

    def test_sensitive_responses_use_strict_security_headers(self):
        response = self.client.get("/")
        csp = response.headers["Content-Security-Policy"]
        self.assertIn("script-src 'self'", csp)
        self.assertIn("style-src 'self'", csp)
        self.assertNotIn("unsafe-inline", csp)
        self.assertIn("frame-ancestors 'none'", csp)
        self.assertIn("camera=(self)", response.headers["Permissions-Policy"])
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_existing_user_database_migration_does_not_force_password_change(self):
        legacy_path = Path(self.directory.name) / "legacy.db"
        with sqlite3.connect(legacy_path) as db:
            db.execute(
                """CREATE TABLE users (
                    id INTEGER PRIMARY KEY,
                    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    password_hash TEXT NOT NULL,
                    auth_version INTEGER NOT NULL DEFAULT 0,
                    password_change_required INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )"""
            )
            from werkzeug.security import generate_password_hash
            db.execute(
                """INSERT INTO users (username, password_hash, password_change_required)
                   VALUES (?, ?, 1)""",
                ("GURU MU", generate_password_hash("MASUK AJA123")),
            )
        legacy_app = create_app({
            "TESTING": True,
            "SECRET_KEY": "legacy-migration-test-secret",
            "DATABASE_PATH": str(legacy_path),
            "SESSION_COOKIE_SECURE": False,
        })
        legacy_client = legacy_app.test_client()
        csrf = legacy_client.get("/api/auth").get_json()["csrf_token"]
        login = legacy_client.post("/api/login", json={
            "username": "GURU MU", "password": "MASUK AJA123",
        }, headers={"X-CSRF-Token": csrf})
        self.assertEqual(login.status_code, 200)
        self.assertFalse(login.get_json()["must_change_password"])
        self.assertEqual(legacy_client.get("/api/dashboard").status_code, 200)

    def test_student_session_scan_duplicate_protection_and_audit(self):
        self.login()
        created = self.add_student()
        self.assertEqual(created.status_code, 201)
        self.assertNotIn("qr_token", created.get_json()["student"])
        student_id = created.get_json()["student"]["id"]
        duplicate = self.add_student(name="Nama lain")
        self.assertEqual(duplicate.status_code, 409)

        opened = self.client.post("/api/sessions", json={
            "date": "2026-10-16", "class_name": "7A",
        }, headers=self.headers)
        self.assertEqual(opened.status_code, 201)
        session_id = opened.get_json()["session"]["id"]
        roster = self.client.get(f"/api/sessions/{session_id}/roster").get_json()["students"]
        self.assertEqual(roster[0]["status"], "BELUM ABSEN")

        invalid = self.client.post("/api/scan", json={
            "qr_token": "not-a-real-qr-code", "session_id": session_id,
        }, headers=self.headers)
        self.assertEqual(invalid.status_code, 404)
        with sqlite3.connect(self.app.config["DATABASE_PATH"]) as db:
            db.row_factory = sqlite3.Row
            student = db.execute("SELECT qr_token FROM students WHERE id = ?", (student_id,)).fetchone()
            token = student["qr_token"]
        scanned = self.client.post("/api/scan", json={
            "qr_token": token, "session_id": session_id,
        }, headers=self.headers)
        self.assertEqual(scanned.status_code, 200)
        self.assertIn("Andi Pratama berhasil dicatat HADIR", scanned.get_json()["message"])
        repeated = self.client.post("/api/scan", json={
            "qr_token": token, "session_id": session_id,
        }, headers=self.headers)
        self.assertEqual(repeated.status_code, 409)
        self.assertEqual(repeated.get_json()["error"], "Siswa sudah melakukan absensi hari ini.")

        summary = self.client.get("/api/dashboard").get_json()["summary"]
        self.assertEqual(summary["HADIR"], 1)
        self.assertEqual(summary["belum_absen"], 0)
        audit = self.client.get(f"/api/audit?session_id={session_id}").get_json()["logs"]
        self.assertEqual([entry["new_status"] for entry in audit], ["HADIR", "BELUM ABSEN"])

    def test_manual_status_and_database_backed_exports(self):
        self.login()
        self.add_student()
        session_id = self.client.post("/api/sessions", json={
            "date": "2026-10-16", "class_name": "7A",
        }, headers=self.headers).get_json()["session"]["id"]
        student_id = self.client.get(f"/api/sessions/{session_id}/roster").get_json()["students"][0]["id"]
        updated = self.client.put(f"/api/sessions/{session_id}/students/{student_id}", json={
            "status": "SAKIT", "note": "Demam",
        }, headers=self.headers)
        self.assertEqual(updated.status_code, 200)
        report = self.client.get("/api/reports?period=daily&date=2026-10-16").get_json()
        self.assertEqual(report["totals"]["SAKIT"], 1)
        self.assertEqual(report["students"][0]["SAKIT"], 1)
        excel = self.client.get("/api/reports/export.xlsx?period=daily&date=2026-10-16")
        self.assertEqual(excel.status_code, 200)
        self.assertIn("spreadsheetml", excel.content_type)
        pdf = self.client.get("/api/reports/export.pdf?period=daily&date=2026-10-16")
        self.assertEqual(pdf.status_code, 200)
        self.assertTrue(pdf.data.startswith(b"%PDF"))

    def test_closed_session_rejects_scans_but_keeps_roster_and_status(self):
        self.login()
        self.add_student()
        session_id = self.client.post("/api/sessions", json={
            "date": "2026-10-16", "class_name": "7A",
        }, headers=self.headers).get_json()["session"]["id"]
        self.assertEqual(self.client.post(f"/api/sessions/{session_id}/close", json={}, headers=self.headers).status_code, 200)
        scan = self.client.post("/api/scan", json={
            "qr_token": "some-qr", "session_id": session_id,
        }, headers=self.headers)
        self.assertEqual(scan.status_code, 409)
        self.assertEqual(scan.get_json()["error"], "Sesi absensi sudah ditutup.")


if __name__ == "__main__":
    unittest.main()
