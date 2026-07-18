from __future__ import annotations

import json
import queue
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from typing import Any, Callable


PROTOCOL_VERSION = 1
MAX_MESSAGE_BYTES = 1024 * 1024
ROOT = Path(__file__).resolve().parents[2]
MOCK_SIDECAR = ROOT / "resources" / "sidecar" / "mock_sidecar.py"


class SidecarSession:
    def __init__(self) -> None:
        self.process = subprocess.Popen(
            [sys.executable, str(MOCK_SIDECAR), "--stdio"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.messages: queue.Queue[dict[str, Any]] = queue.Queue()
        self.raw_lines: list[bytes] = []
        self.reader = threading.Thread(target=self._read_messages, daemon=True)
        self.reader.start()

    def _read_messages(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            self.raw_lines.append(line)
            self.messages.put(json.loads(line.decode("utf-8")))

    def send(self, request_id: str, action: str, payload: dict[str, Any]) -> None:
        envelope = {
            "v": PROTOCOL_VERSION,
            "kind": "request",
            "id": request_id,
            "action": action,
            "payload": payload,
        }
        encoded = json.dumps(envelope, separators=(",", ":")).encode("utf-8")
        self.send_raw(encoded + b"\n")

    def send_raw(self, value: bytes) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(value)
        self.process.stdin.flush()

    def wait_for(
        self,
        predicate: Callable[[dict[str, Any]], bool],
        timeout: float = 3.0,
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self.fail_with_messages("Timed out waiting for a sidecar message.")
            try:
                message = self.messages.get(timeout=remaining)
            except queue.Empty:
                self.fail_with_messages("Timed out waiting for a sidecar message.")
            if predicate(message):
                return message

    def fail_with_messages(self, message: str) -> None:
        raise AssertionError(f"{message} Received: {self.raw_lines!r}")

    def close(self) -> None:
        if self.process.poll() is None:
            try:
                self.send("request_shutdown", "session.shutdown", {})
            except (BrokenPipeError, OSError):
                pass
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=3)
        self.reader.join(timeout=1)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            if stream is not None:
                stream.close()


class MockSidecarTests(unittest.TestCase):
    def test_approval_binding_cancellation_and_credential_non_echo(self) -> None:
        session = SidecarSession()
        credential_marker = "example-credential-marker-never-echo"
        try:
            ready = session.wait_for(lambda item: item.get("event") == "ready")
            self.assertEqual(ready["payload"]["protocol"], PROTOCOL_VERSION)

            session.send(
                "request_endpoint",
                "endpoint.bind",
                {
                    "endpointId": "endpoint_demo",
                    "consentId": "consent_demo",
                    "baseUrl": "https://example.invalid/v1",
                    "apiKey": credential_marker,
                },
            )
            endpoint_response = session.wait_for(
                lambda item: item.get("kind") == "response"
                and item.get("id") == "request_endpoint"
            )
            self.assertTrue(endpoint_response["ok"])

            session.send(
                "request_turn_one",
                "turn.start",
                {
                    "turnId": "turn_one",
                    "endpointId": "endpoint_demo",
                    "mode": "agent",
                    "model": "mock-model",
                    "permissionMode": "ask",
                    "subagentMode": "off",
                    "messages": [{"role": "user", "content": "demo"}],
                },
            )
            approval = session.wait_for(
                lambda item: item.get("event") == "approval.required"
                and item.get("turnId") == "turn_one"
            )
            binding = approval["payload"]["binding"]
            self.assertEqual(len(binding["callDigest"]), 64)

            session.send(
                "request_approve",
                "approval.resolve",
                {"binding": binding, "decision": "allow_once"},
            )
            approval_response = session.wait_for(
                lambda item: item.get("kind") == "response"
                and item.get("id") == "request_approve"
            )
            self.assertTrue(approval_response["ok"])
            session.wait_for(
                lambda item: item.get("event") == "turn.completed"
                and item.get("turnId") == "turn_one"
            )

            session.send(
                "request_turn_two",
                "turn.start",
                {
                    "turnId": "turn_two",
                    "endpointId": "endpoint_demo",
                    "mode": "agent",
                    "model": "mock-model",
                    "permissionMode": "ask",
                    "subagentMode": "off",
                    "messages": [{"role": "user", "content": "cancel demo"}],
                },
            )
            second_approval = session.wait_for(
                lambda item: item.get("event") == "approval.required"
                and item.get("turnId") == "turn_two"
            )
            session.send(
                "request_cancel",
                "turn.cancel",
                {"turnId": "turn_two", "reason": "selftest"},
            )
            cancel_response = session.wait_for(
                lambda item: item.get("kind") == "response"
                and item.get("id") == "request_cancel"
            )
            self.assertTrue(cancel_response["result"]["cancelled"])
            session.wait_for(
                lambda item: item.get("event") == "turn.cancelled"
                and item.get("turnId") == "turn_two"
            )

            session.send(
                "request_late_approval",
                "approval.resolve",
                {
                    "binding": second_approval["payload"]["binding"],
                    "decision": "allow_once",
                },
            )
            late_response = session.wait_for(
                lambda item: item.get("kind") == "response"
                and item.get("id") == "request_late_approval"
            )
            self.assertFalse(late_response["ok"])
            self.assertEqual(late_response["error"]["code"], "approval_binding_mismatch")
            self.assertNotIn(
                credential_marker.encode("utf-8"),
                b"".join(session.raw_lines),
            )
        finally:
            session.close()

    def test_oversized_input_fails_closed(self) -> None:
        session = SidecarSession()
        try:
            session.wait_for(lambda item: item.get("event") == "ready")
            session.send_raw(b"{" + b" " * (MAX_MESSAGE_BYTES + 1) + b"\n")
            failure = session.wait_for(lambda item: item.get("event") == "turn.failed")
            self.assertEqual(failure["payload"]["code"], "message_too_large")
            self.assertEqual(session.process.wait(timeout=3), 2)
        finally:
            session.close()


if __name__ == "__main__":
    unittest.main()
