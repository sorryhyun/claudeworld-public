"""
Custom error types for tool handlers.

This module defines a hierarchy of exceptions for tool-related errors,
enabling consistent error handling and appropriate user-facing messages.
"""


class ToolError(Exception):
    """Base exception for tool errors.

    All tool-specific errors should inherit from this class.

    Attributes:
        message: Human-readable error description.
        recoverable: Whether the operation can be retried.
    """

    def __init__(self, message: str, recoverable: bool = True):
        self.message = message
        self.recoverable = recoverable
        super().__init__(message)


class ValidationError(ToolError):
    """Input validation failed.

    Raised when tool arguments fail Pydantic validation or custom validation rules.
    These errors are typically recoverable if the user provides corrected input.
    """

    def __init__(self, message: str):
        super().__init__(message, recoverable=True)


class ResourceNotFoundError(ToolError):
    """Requested resource not found.

    Raised when a requested entity (memory, character, location, etc.)
    cannot be found in the database or filesystem.
    """

    def __init__(self, message: str, resource_type: str = "resource", resource_id: str = ""):
        self.resource_type = resource_type
        self.resource_id = resource_id
        super().__init__(message, recoverable=True)


class ConfigurationError(ToolError):
    """Tool misconfiguration or missing context.

    Raised when a tool is invoked without required dependencies
    (e.g., database session, world context) being configured.
    These are not recoverable without code changes.
    """

    def __init__(self, message: str):
        super().__init__(message, recoverable=False)


class PermissionError(ToolError):
    """Operation not permitted.

    Raised when an operation is not allowed due to permissions,
    ownership, or access control restrictions.
    """

    def __init__(self, message: str):
        super().__init__(message, recoverable=False)


class DuplicateResourceError(ToolError):
    """Resource already exists.

    Raised when attempting to create a resource that already exists
    (e.g., character with same name, location already present).
    """

    def __init__(self, message: str, resource_type: str = "resource", resource_id: str = ""):
        self.resource_type = resource_type
        self.resource_id = resource_id
        super().__init__(message, recoverable=True)
