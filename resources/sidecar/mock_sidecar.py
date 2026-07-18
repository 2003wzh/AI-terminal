from __future__ import annotations

import hashlib
import json
import sys
import threading
import time
import uuid
from typing import Any


PROTOCOL_VERSION = 1
MAX_MESSAGE_BYTES = 1024 * 1024
ALLOWED_ACTIONS = {
    "session.initialize",
    "workspace.bind",
    "endpoint.bind",
    "turn.start",
    "turn.cancel",
    "approval.resolve",
    "session.shutdown",
}


class MockSidecar:
    def __init__(self) -> None:
        self._write_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._sequence = -1
        self._stopping = threading.Event()
        self._endpoints: set[str] = set()
        self._workspaces: set[str] = set()
        self._turns: dict[str, dict[str, Any]] = {}
        self._approvals: dict[str, dict[str, Any]] = {}

    def _write(self, message: dict[str, Any]) -> None:
        payload = json.dumps(
            message,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        if len(payload) > MAX_MESSAGE_BYTES:
            raise ValueError("protocol output exceeded the message limit")
        with self._write_lock:
            sys.stdout.buffer.write(payload + b"\n")
            sys.stdout.buffer.flush()

    def _event(
        self,
        name: str,
        payload: dict[str, Any],
        *,
        request_id: str = "",
        turn_id: str = "",
    ) -> None:
        with self._state_lock:
            self._sequence += 1
            sequence = self._sequence
        message: dict[str, Any] = {
            "v": PROTOCOL_VERSION,
            "kind": "event",
            "event": name,
            "seq": sequence,
            "payload": payload,
        }
        if request_id:
            message["requestId"] = request_id
        if turn_id:
            message["turnId"] = turn_id
        self._write(message)

    def _response(
        self,
        request_id: str,
        *,
        result: Any = None,
        error_code: str = "",
    ) -> None:
        if error_code:
            self._write(
                {
                    "v": PROTOCOL_VERSION,
                    "kind": "response",
                    "id": request_id,
                    "ok": False,
                    "error": {
                        "code": error_code,
                        "message": "The mock sidecar rejected the request.",
                        "retryable": False,
                    },
                }
            )
            return
        self._write(
            {
                "v": PROTOCOL_VERSION,
                "kind": "response",
                "id": request_id,
                "ok": True,
                "result": result if result is not None else {},
            }
        )

    @staticmethod
    def _valid_id(value: Any) -> bool:
        if not isinstance(value, str) or not 1 <= len(value) <= 64:
            return False
        return value[0].isalnum() and all(
            character.isalnum() or character in "._:-" for character in value
        )

    @staticmethod
    def _approval_digest(tool_call: dict[str, Any]) -> str:
        canonical = json.dumps(
            tool_call,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        return hashlib.sha256(canonical).hexdigest()

    def _turn_is_cancelled(self, turn_id: str) -> bool:
        with self._state_lock:
            state = self._turns.get(turn_id)
            return state is None or bool(state["cancelled"].is_set())

    def _finish_turn(self, turn_id: str, status: str) -> bool:
        with self._state_lock:
            state = self._turns.get(turn_id)
            if state is None or state["finished"] or state["cancelled"].is_set():
                return False
            state["finished"] = True
        self._event("turn.completed", {"status": status}, turn_id=turn_id)
        return True

    def _run_turn(self, request_id: str, payload: dict[str, Any]) -> None:
        turn_id = str(payload["turnId"])
        self._event("turn.started", {"accepted": True}, request_id=request_id, turn_id=turn_id)
        if self._turn_is_cancelled(turn_id):
            return
        self._event(
            "assistant.delta",
            {"text": "Mock sidecar connected."},
            turn_id=turn_id,
        )
        if payload.get("mode") != "agent" or payload.get("permissionMode") != "ask":
            self._finish_turn(turn_id, "completed")
            return

        tool_call = {
            "arguments": {"path": "README.md"},
            "name": "read_file",
        }
        binding = {
            "approvalId": f"approval_{uuid.uuid4()}",
            "turnId": turn_id,
            "toolCallId": "mock_call_1",
            "callDigest": self._approval_digest(tool_call),
            "expiresAt": int(time.time() * 1000) + 120_000,
        }
        with self._state_lock:
            state = self._turns.get(turn_id)
            if state is None or state["cancelled"].is_set():
                return
            self._approvals[binding["approvalId"]] = {
                "binding": binding,
                "turnId": turn_id,
            }
        self._event(
            "tool.proposed",
            {
                "binding": binding,
                "tool": {"name": "read_file", "summary": "Read README.md"},
            },
            turn_id=turn_id,
        )
        self._event(
            "approval.required",
            {
                "binding": binding,
                "tool": {"name": "read_file", "summary": "Read README.md"},
            },
            turn_id=turn_id,
        )

    def _cancel_turn(self, request_id: str, payload: dict[str, Any]) -> None:
        turn_id = str(payload.get("turnId") or "")
        cancelled = False
        with self._state_lock:
            state = self._turns.get(turn_id)
            if state is not None and not state["finished"] and not state["cancelled"].is_set():
                state["cancelled"].set()
                state["finished"] = True
                cancelled = True
            approval_ids = [
                approval_id
                for approval_id, pending in self._approvals.items()
                if pending["turnId"] == turn_id
            ]
            for approval_id in approval_ids:
                self._approvals.pop(approval_id, None)
        self._response(request_id, result={"cancelled": cancelled})
        if cancelled:
            self._event("turn.cancelled", {"cancelled": True}, turn_id=turn_id)

    def _resolve_approval(self, request_id: str, payload: dict[str, Any]) -> None:
        binding = payload.get("binding")
        decision = payload.get("decision")
        if not isinstance(binding, dict) or decision not in {"allow_once", "deny"}:
            self._response(request_id, error_code="invalid_approval_resolution")
            return
        approval_id = binding.get("approvalId")
        with self._state_lock:
            pending = self._approvals.get(str(approval_id or ""))
            if pending is None or pending["binding"] != binding:
                pending = None
            elif int(binding.get("expiresAt") or 0) < int(time.time() * 1000):
                self._approvals.pop(str(approval_id), None)
                pending = None
            else:
                self._approvals.pop(str(approval_id), None)
        if pending is None:
            self._response(request_id, error_code="approval_binding_mismatch")
            return

        turn_id = str(pending["turnId"])
        if self._turn_is_cancelled(turn_id):
            self._response(request_id, error_code="turn_cancelled")
            return
        self._response(request_id, result={"accepted": True, "decision": decision})
        self._event(
            "tool.started",
            {"toolCallId": binding["toolCallId"]},
            turn_id=turn_id,
        )
        if decision == "allow_once":
            self._event(
                "tool.completed",
                {
                    "toolCallId": binding["toolCallId"],
                    "ok": True,
                    "output": "Mock read completed.",
                },
                turn_id=turn_id,
            )
            self._event(
                "assistant.delta",
                {"text": " The approved mock tool completed."},
                turn_id=turn_id,
            )
            self._finish_turn(turn_id, "completed")
            return
        self._event(
            "tool.completed",
            {
                "toolCallId": binding["toolCallId"],
                "ok": False,
                "output": "The operation was denied.",
            },
            turn_id=turn_id,
        )
        self._finish_turn(turn_id, "denied")

    def handle_request(self, envelope: dict[str, Any]) -> None:
        request_id = envelope.get("id")
        action = envelope.get("action")
        payload = envelope.get("payload")
        if (
            envelope.get("v") != PROTOCOL_VERSION
            or envelope.get("kind") != "request"
            or not self._valid_id(request_id)
            or action not in ALLOWED_ACTIONS
            or not isinstance(payload, dict)
        ):
            if self._valid_id(request_id):
                self._response(str(request_id), error_code="invalid_request")
            else:
                self._event("turn.failed", {"code": "invalid_request"})
            return

        request_id = str(request_id)
        if action == "session.initialize":
            self._response(request_id, result={"initialized": True})
            return
        if action == "workspace.bind":
            workspace_id = payload.get("workspaceId")
            if not self._valid_id(workspace_id) or not isinstance(payload.get("absolutePath"), str):
                self._response(request_id, error_code="invalid_workspace_binding")
                return
            self._workspaces.add(str(workspace_id))
            self._response(request_id, result={"workspaceId": workspace_id, "bound": True})
            return
        if action == "endpoint.bind":
            endpoint_id = payload.get("endpointId")
            api_key = payload.get("apiKey")
            if (
                not self._valid_id(endpoint_id)
                or not self._valid_id(payload.get("consentId"))
                or not isinstance(payload.get("baseUrl"), str)
                or not isinstance(api_key, str)
                or not api_key
            ):
                self._response(request_id, error_code="invalid_endpoint_binding")
                return
            # The mock records only the opaque endpoint identifier. It never logs,
            # echoes, persists, or retains the credential value.
            self._endpoints.add(str(endpoint_id))
            payload["apiKey"] = ""
            self._response(request_id, result={"endpointId": endpoint_id, "bound": True})
            return
        if action == "turn.start":
            turn_id = payload.get("turnId")
            endpoint_id = payload.get("endpointId")
            if not self._valid_id(turn_id) or endpoint_id not in self._endpoints:
                self._response(request_id, error_code="invalid_turn")
                return
            with self._state_lock:
                if turn_id in self._turns:
                    self._response(request_id, error_code="duplicate_turn")
                    return
                self._turns[str(turn_id)] = {
                    "cancelled": threading.Event(),
                    "finished": False,
                }
            self._response(request_id, result={"accepted": True, "turnId": turn_id})
            threading.Thread(
                target=self._run_turn,
                args=(request_id, dict(payload)),
                daemon=True,
            ).start()
            return
        if action == "turn.cancel":
            self._cancel_turn(request_id, payload)
            return
        if action == "approval.resolve":
            self._resolve_approval(request_id, payload)
            return
        if action == "session.shutdown":
            self._response(request_id, result={"shuttingDown": True})
            self._stopping.set()

    def run(self) -> int:
        self._event(
            "ready",
            {
                "protocol": PROTOCOL_VERSION,
                "capabilities": ["approval-demo", "cancellation-demo"],
            },
        )
        while not self._stopping.is_set():
            line = sys.stdin.buffer.readline(MAX_MESSAGE_BYTES + 2)
            if not line:
                break
            has_newline = line.endswith(b"\n")
            body = line[:-1] if has_newline else line
            if body.endswith(b"\r"):
                body = body[:-1]
            if len(body) > MAX_MESSAGE_BYTES or not has_newline:
                self._event("turn.failed", {"code": "message_too_large"})
                return 2
            if not body:
                continue
            try:
                envelope = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._event("turn.failed", {"code": "invalid_json"})
                continue
            if not isinstance(envelope, dict):
                self._event("turn.failed", {"code": "invalid_request"})
                continue
            self.handle_request(envelope)
            envelope.clear()
        return 0


def main() -> int:
    # Do not use argparse here: it may echo an accidentally supplied credential
    # argument to stderr. The production sidecar accepts only this fixed switch.
    if sys.argv[1:] != ["--stdio"]:
        return 2
    return MockSidecar().run()


if __name__ == "__main__":
    raise SystemExit(main())
