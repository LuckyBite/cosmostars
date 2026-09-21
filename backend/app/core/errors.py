"""Service errors that map to an explanation the operator can act on.

Rejecting a malformed event must never damage a running shift, so every failure
path here is raised before the session is touched and carries the reason back to
the interface unchanged.
"""
from __future__ import annotations


class ServiceError(Exception):
    """Base for failures that are the caller's to fix."""

    status_code = 400

    def __init__(self, message: str, detail: dict | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail or {}

    def payload(self) -> dict:
        return {'error': type(self).__name__, 'message': self.message, 'detail': self.detail}


class BadRequest(ServiceError):
    status_code = 400


class NotFound(ServiceError):
    status_code = 404


class EventRejected(ServiceError):
    """The event was refused; the shift continues from its untouched state."""

    status_code = 409
