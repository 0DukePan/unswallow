from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Union

from .types import ToolEnvelope, ToolValidationResult


def _is_object(value: Any) -> bool:
    return isinstance(value, dict)


def _schema_for(tool: Any) -> Optional[Dict[str, Any]]:
    if not _is_object(tool):
        return None
    function = tool.get("function")
    container = function if _is_object(function) else tool
    parameters = container.get("parameters")
    return parameters if _is_object(parameters) else None


def _name_for(tool: Any) -> Optional[str]:
    if not _is_object(tool):
        return None
    function = tool.get("function")
    container = function if _is_object(function) else tool
    name = container.get("name")
    return name.strip() if isinstance(name, str) and name.strip() else None


def _type_matches(value: Any, expected: str) -> bool:
    if expected == "object":
        return _is_object(value)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    if expected == "integer":
        return (
            isinstance(value, int)
            and not isinstance(value, bool)
            or isinstance(value, float)
            and math.isfinite(value)
            and value.is_integer()
        )
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "null":
        return value is None
    return True


def _same_json_value(left: Any, right: Any) -> bool:
    if (
        isinstance(left, (int, float))
        and not isinstance(left, bool)
        and isinstance(right, (int, float))
        and not isinstance(right, bool)
    ):
        return left == right or (
            isinstance(left, float)
            and isinstance(right, float)
            and math.isnan(left)
            and math.isnan(right)
        )
    return type(left) is type(right) and left == right


def _validate_value(value: Any, schema: Dict[str, Any], path: str, errors: List[str]) -> None:
    expected_type = schema.get("type")
    if isinstance(expected_type, str) and not _type_matches(value, expected_type):
        errors.append("{} must be {}".format(path, expected_type))
        return

    enum = schema.get("enum")
    if isinstance(enum, list) and not any(_same_json_value(candidate, value) for candidate in enum):
        errors.append("{} must be one of the allowed values".format(path))
    if "const" in schema and not _same_json_value(schema["const"], value):
        errors.append("{} must equal the required value".format(path))

    if _is_object(value):
        properties = schema.get("properties")
        if properties is not None and not _is_object(properties):
            errors.append("{} schema has non-object properties".format(path))
            return
        required = schema.get("required")
        if isinstance(required, list):
            for key in required:
                if isinstance(key, str) and key not in value:
                    errors.append("{}.{} is required".format(path, key))
        if isinstance(properties, dict):
            for key, child_schema in properties.items():
                if key in value and isinstance(child_schema, dict):
                    _validate_value(value[key], child_schema, "{}.{}".format(path, key), errors)
            if schema.get("additionalProperties") is False:
                for key in value:
                    if key not in properties:
                        errors.append("{}.{} is not allowed".format(path, key))

    items = schema.get("items")
    if isinstance(value, list) and isinstance(items, dict):
        for index, item in enumerate(value):
            _validate_value(item, items, "{}[{}]".format(path, index), errors)


def validate_envelope(
    envelope: Optional[Union[ToolEnvelope, Dict[str, Any]]],
    tool_schemas: Optional[List[Dict[str, Any]]] = None
) -> ToolValidationResult:
    """Validate a recovered envelope against a conservative JSON Schema subset.

    Malformed schemas are reported as unknown rather than as a validation
    failure, so callers never receive an unjustified validation claim.
    """
    if isinstance(envelope, dict):
        name = envelope.get("name")
        arguments = envelope.get("arguments")
    else:
        name = getattr(envelope, "name", None) if envelope is not None else None
        arguments = getattr(envelope, "arguments", None) if envelope is not None else None
    if not isinstance(name, str) or not name.strip() or not _is_object(arguments):
        return ToolValidationResult(
            False,
            "unknown",
            "unknown",
            ["tool envelope must have a name and object arguments"],
        )
    if not tool_schemas:
        return ToolValidationResult(True, "unknown", "unknown", [])

    matching = [tool for tool in tool_schemas if _name_for(tool) == name]
    if not matching:
        return ToolValidationResult(
            True,
            "no",
            "unknown",
            ['recovered tool name "{}" not found in provided toolSchemas'.format(name)],
        )

    schema = _schema_for(matching[0])
    if schema is None:
        return ToolValidationResult(
            True,
            "yes",
            "unknown",
            ['tool schema for "{}" has no object parameters schema'.format(name)],
        )
    if "properties" in schema and not _is_object(schema["properties"]):
        return ToolValidationResult(
            True,
            "yes",
            "unknown",
            ['tool schema for "{}" has non-object properties'.format(name)],
        )
    if "required" in schema and not isinstance(schema["required"], list):
        return ToolValidationResult(
            True,
            "yes",
            "unknown",
            ['tool schema for "{}" has non-array required'.format(name)],
        )

    errors: List[str] = []
    _validate_value(arguments, schema, "arguments", errors)
    return ToolValidationResult(True, "yes", "yes" if not errors else "no", errors)
