"""Instance configuration and HTTP guard tests; never touches a running user service."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from threading import Thread
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer

spec = importlib.util.spec_from_file_location("instance_security_app", Path(__file__).with_name("app.py"))
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


class InstanceSecurityTests(unittest.TestCase):
    def test_required_configuration_has_no_demo_fallback(self):
        for env in [{"NODE_ENV": "production"}, {"SEMANTIC_REQUIRE_INSTANCE_AUTH": "true"}]:
            with self.assertRaisesRegex(ValueError, "CONFIG_REQUIRED"):
                app.read_instance_configuration(env)
        self.assertIsNone(app.read_instance_configuration({}))

    def test_invalid_or_missing_files_fail_closed_without_exposing_values(self):
        for location in ["relative.json", str(Path(tempfile.gettempdir()) / "nonexistent-instance-config.json")]:
            with self.assertRaisesRegex(ValueError, "^SEMANTIC_INSTANCE_CONFIG_INVALID$"):
                app.read_instance_configuration({"SEMANTIC_INSTANCE_CONFIG_FILE": location})

    def test_valid_configuration_and_invalid_fields(self):
        value = {"version": 1, "tenantId": "synthetic-a", "deploymentId": "instance-a", "token": "a" * 43}
        with tempfile.TemporaryDirectory(prefix="semantic-instance-test-") as directory:
            path = Path(directory) / "instance.json"
            path.write_text(json.dumps(value), encoding="utf-8")
            self.assertEqual(app.read_instance_configuration({"SEMANTIC_INSTANCE_CONFIG_FILE": str(path)})["tenantId"], "synthetic-a")
            for patch in [{"version": 2}, {"tenantId": "a\nb"}, {"deploymentId": ""}, {"token": "short"}, {"token": "密" * 43}]:
                path.write_text(json.dumps({**value, **patch}), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "CONFIG_INVALID"):
                    app.read_instance_configuration({"SEMANTIC_INSTANCE_CONFIG_FILE": str(path)})

    def test_duplicate_identity_headers_and_wrong_deployment_are_rejected(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        server.instance_config = {"tenantId": "a", "deploymentId": "deployment-a", "token": "a" * 43}
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for duplicate in [True, False]:
                client = HTTPConnection("127.0.0.1", server.server_address[1])
                client.putrequest("POST", "/demo/reset")
                client.putheader("Authorization", "Bearer " + "a" * 43)
                client.putheader("X-Semantic-Tenant", "a")
                client.putheader("X-Semantic-Deployment", "deployment-a" if duplicate else "deployment-b")
                if duplicate:
                    client.putheader("X-Semantic-Tenant", "a")
                client.endheaders()
                response = client.getresponse()
                self.assertEqual(response.status, 403)
                self.assertEqual(json.loads(response.read()), {"error": "instance_access_denied"})
                client.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
