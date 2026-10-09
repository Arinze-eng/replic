#!/usr/bin/env python3
import argparse
import json
import os
import sys
from typing import Any, Dict, Optional
from urllib.parse import quote

import requests

DEFAULT_BASE_URL = "https://open.feishu.cn/open-apis"


try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


JsonObject = Dict[str, Any]


def parse_kv(items: list[str]) -> Dict[str, str]:
    parsed: Dict[str, str] = {}
    for item in items:
        if "=" not in item:
            raise ValueError(f"Expected KEY=VALUE, got: {item}")
        key, value = item.split("=", 1)
        parsed[key] = value
    return parsed


def load_json_source(inline_value: Optional[str], file_path: Optional[str], label: str) -> Any:
    if inline_value and file_path:
        raise ValueError(f"Use either --{label}-json or --{label}-file, not both.")
    if inline_value:
        return json.loads(inline_value)
    if file_path:
        with open(file_path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    return None


def load_required_json_source(inline_value: Optional[str], file_path: Optional[str], label: str) -> Any:
    data = load_json_source(inline_value, file_path, label)
    if data is None:
        raise ValueError(f"Provide --{label}-json or --{label}-file.")
    return data


def load_json_payload(args: argparse.Namespace) -> Optional[JsonObject]:
    data = load_json_source(getattr(args, "body_json", None), getattr(args, "body_file", None), "body")
    if data is not None and not isinstance(data, dict):
        raise ValueError("Request body must be a JSON object.")
    return data


def load_fields(args: argparse.Namespace) -> JsonObject:
    data = load_required_json_source(getattr(args, "fields_json", None), getattr(args, "fields_file", None), "fields")
    if not isinstance(data, dict):
        raise ValueError("Fields payload must be a JSON object.")
    return data


def load_values(args: argparse.Namespace) -> list[Any]:
    data = load_required_json_source(getattr(args, "values_json", None), getattr(args, "values_file", None), "values")
    if not isinstance(data, list):
        raise ValueError("Values payload must be a JSON array.")
    return data


def load_records(args: argparse.Namespace) -> list[JsonObject]:
    data = load_required_json_source(getattr(args, "records_json", None), getattr(args, "records_file", None), "records")
    if not isinstance(data, list):
        raise ValueError("Records payload must be a JSON array.")
    return data


def load_tables(args: argparse.Namespace) -> list[JsonObject]:
    data = load_required_json_source(getattr(args, "tables_json", None), getattr(args, "tables_file", None), "tables")
    if not isinstance(data, list):
        raise ValueError("Tables payload must be a JSON array.")
    return data


def load_property(args: argparse.Namespace) -> Any:
    return load_json_source(getattr(args, "property_json", None), getattr(args, "property_file", None), "property")


def load_filter(args: argparse.Namespace) -> Any:
    return load_json_source(getattr(args, "filter_json", None), getattr(args, "filter_file", None), "filter")


def load_sort(args: argparse.Namespace) -> Any:
    return load_json_source(getattr(args, "sort_json", None), getattr(args, "sort_file", None), "sort")


def get_base_url() -> str:
    return os.environ.get("FEISHU_BASE_URL", DEFAULT_BASE_URL).rstrip("/")


def fetch_tenant_access_token(
    session: requests.Session,
    app_id: str,
    app_secret: str,
    base_url: str,
) -> JsonObject:
    response = session.post(
        f"{base_url}/auth/v3/tenant_access_token/internal",
        json={"app_id": app_id, "app_secret": app_secret},
        timeout=20,
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("code") != 0:
        raise RuntimeError(f"Token request failed: {payload}")
    return payload


def resolve_token(
    session: requests.Session,
    token: Optional[str],
    app_id: Optional[str],
    app_secret: Optional[str],
    base_url: str,
) -> str:
    if token:
        return token
    env_token = os.environ.get("FEISHU_TENANT_ACCESS_TOKEN")
    if env_token:
        return env_token

    app_id = app_id or os.environ.get("FEISHU_APP_ID")
    app_secret = app_secret or os.environ.get("FEISHU_APP_SECRET")
    if not app_id or not app_secret:
        raise ValueError(
            "Missing tenant token and app credentials. Set FEISHU_TENANT_ACCESS_TOKEN "
            "or provide --app-id/--app-secret or FEISHU_APP_ID/FEISHU_APP_SECRET."
        )

    return fetch_tenant_access_token(session, app_id, app_secret, base_url)["tenant_access_token"]


def request_api(
    session: requests.Session,
    method: str,
    path: str,
    token: str,
    query: Optional[Dict[str, str]],
    headers: Optional[Dict[str, str]],
    body: Optional[Any],
    base_url: str,
) -> JsonObject:
    merged_headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json; charset=utf-8",
    }
    if headers:
        merged_headers.update(headers)
    response = session.request(
        method=method,
        url=f"{base_url}/{path.lstrip('/')}",
        params=query or None,
        json=body,
        headers=merged_headers,
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    if isinstance(payload, dict) and "code" in payload and payload.get("code") != 0:
        raise RuntimeError(f"Feishu API returned an error: {payload}")
    return payload


def build_session_and_token(args: argparse.Namespace) -> tuple[requests.Session, str, str]:
    session = requests.Session()
    base_url = get_base_url()
    token = resolve_token(
        session=session,
        token=getattr(args, "token", None),
        app_id=getattr(args, "app_id", None),
        app_secret=getattr(args, "app_secret", None),
        base_url=base_url,
    )
    return session, token, base_url


def print_payload(payload: JsonObject) -> int:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0

def build_docx_urls(document_id: str) -> JsonObject:
    urls: JsonObject = {
        "generic_docx_url": f"https://feishu.cn/docx/{document_id}",
    }
    entry_host = os.environ.get("FEISHU_ENTRY_HOST")
    if entry_host:
        urls["entry_docx_url"] = f"https://{entry_host.strip('/')}/docx/{document_id}"
    web_host = os.environ.get("FEISHU_WEB_HOST")
    if web_host:
        urls["tenant_docx_url"] = f"https://{web_host.strip('/')}/docx/{document_id}"
    return urls


def build_bitable_urls(app_token: str, table_id: Optional[str] = None, view_id: Optional[str] = None) -> JsonObject:
    query_parts = []
    if table_id:
        query_parts.append(f"table={table_id}")
    if view_id:
        query_parts.append(f"view={view_id}")
    query = f"?{'&'.join(query_parts)}" if query_parts else ""
    urls: JsonObject = {
        "generic_bitable_url": f"https://feishu.cn/base/{app_token}{query}",
    }
    entry_host = os.environ.get("FEISHU_ENTRY_HOST")
    if entry_host:
        urls["entry_bitable_url"] = f"https://{entry_host.strip('/')}/base/{app_token}{query}"
    web_host = os.environ.get("FEISHU_WEB_HOST")
    if web_host:
        urls["tenant_bitable_url"] = f"https://{web_host.strip('/')}/base/{app_token}{query}"
    return urls


def add_user_id_type(query: Dict[str, str], args: argparse.Namespace) -> Dict[str, str]:
    if getattr(args, "user_id_type", None):
        query["user_id_type"] = args.user_id_type
    return query


def omit_property_for_special_field(field_type: Optional[int], payload: JsonObject) -> JsonObject:
    if field_type in (7, 15) and "property" in payload:
        payload = dict(payload)
        payload.pop("property", None)
    return payload


def get_bitable_field_detail(
    session: requests.Session,
    token: str,
    base_url: str,
    app_token: str,
    table_id: str,
    field_id: str,
) -> JsonObject:
    page_token: Optional[str] = None
    while True:
        query = {"page_size": "100"}
        if page_token:
            query["page_token"] = page_token
        payload = request_api(
            session,
            "GET",
            f"/bitable/v1/apps/{app_token}/tables/{table_id}/fields",
            token,
            query,
            None,
            None,
            base_url,
        )
        for field in payload.get("data", {}).get("items", []):
            if field.get("field_id") == field_id:
                return field
        if not payload.get("data", {}).get("has_more"):
            break
        page_token = payload.get("data", {}).get("page_token")
    raise ValueError(f"Field not found: {field_id}")


def cmd_tenant_token(args: argparse.Namespace) -> int:
    base_url = get_base_url()
    app_id = args.app_id or os.environ.get("FEISHU_APP_ID")
    app_secret = args.app_secret or os.environ.get("FEISHU_APP_SECRET")
    if not app_id or not app_secret:
        raise ValueError("Missing app credentials. Provide --app-id and --app-secret or set env vars.")
    with requests.Session() as session:
        payload = fetch_tenant_access_token(session, app_id, app_secret, base_url)
    return print_payload(payload)


def cmd_request(args: argparse.Namespace) -> int:
    query = parse_kv(args.query)
    headers = parse_kv(args.header)
    body = load_json_payload(args)
    session, token, base_url = build_session_and_token(args)
    with session:
        payload = request_api(session, args.method, args.path, token, query, headers, body, base_url)
    return print_payload(payload)


def cmd_docx_create(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    body: JsonObject = {"title": args.title}
    if args.folder_token:
        body["folder_token"] = args.folder_token
    with session:
        payload = request_api(session, "POST", "/docx/v1/documents", token, None, None, body, base_url)
    document_id = payload.get("data", {}).get("document", {}).get("document_id")
    if document_id:
        payload.setdefault("links", {}).update(build_docx_urls(document_id))
    return print_payload(payload)


def cmd_docx_raw_content(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    with session:
        payload = request_api(session, "GET", f"/docx/v1/documents/{args.document_id}/raw_content", token, None, None, None, base_url)
    return print_payload(payload)


def cmd_docx_list_blocks(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    query: Dict[str, str] = {}
    if args.page_size is not None:
        query["page_size"] = str(args.page_size)
    if args.page_token:
        query["page_token"] = args.page_token
    if args.document_revision_id is not None:
        query["document_revision_id"] = str(args.document_revision_id)
    with session:
        payload = request_api(session, "GET", f"/docx/v1/documents/{args.document_id}/blocks", token, query, None, None, base_url)
    return print_payload(payload)


def cmd_docx_list_children(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    query: Dict[str, str] = {}
    if args.page_size is not None:
        query["page_size"] = str(args.page_size)
    if args.page_token:
        query["page_token"] = args.page_token
    if args.document_revision_id is not None:
        query["document_revision_id"] = str(args.document_revision_id)
    with session:
        payload = request_api(
            session,
            "GET",
            f"/docx/v1/documents/{args.document_id}/blocks/{args.block_id}/children",
            token,
            query,
            None,
            None,
            base_url,
        )
    return print_payload(payload)


def build_text_block(text: str, block_type: int = 2) -> JsonObject:
    return {
        "block_type": block_type,
        "text": {
            "elements": [
                {
                    "text_run": {
                        "content": text,
                    }
                }
            ]
        },
    }


def cmd_docx_append_text(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    parent_block_id = args.parent_block_id or args.document_id
    body = {
        "index": args.index,
        "children": [build_text_block(args.text, args.block_type)],
    }
    query: Dict[str, str] = {}
    if args.document_revision_id is not None:
        query["document_revision_id"] = str(args.document_revision_id)
    with session:
        payload = request_api(
            session,
            "POST",
            f"/docx/v1/documents/{args.document_id}/blocks/{parent_block_id}/children",
            token,
            query,
            None,
            body,
            base_url,
        )
    return print_payload(payload)


def cmd_docx_update_text(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    body = {
        "replace_text_elements": {
            "elements": [
                {
                    "text_run": {
                        "content": args.text,
                    }
                }
            ]
        }
    }
    with session:
        payload = request_api(
            session,
            "PATCH",
            f"/docx/v1/documents/{args.document_id}/blocks/{args.block_id}",
            token,
            None,
            None,
            body,
            base_url,
        )
    return print_payload(payload)


def cmd_docx_delete_children(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    body = {
        "start_index": args.start_index,
        "end_index": args.end_index,
    }
    query: Dict[str, str] = {}
    if args.document_revision_id is not None:
        query["document_revision_id"] = str(args.document_revision_id)
    with session:
        payload = request_api(
            session,
            "DELETE",
            f"/docx/v1/documents/{args.document_id}/blocks/{args.block_id}/children/batch_delete",
            token,
            query,
            None,
            body,
            base_url,
        )
    return print_payload(payload)

def cmd_bitable_app_create(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    body: JsonObject = {"name": args.name}
    if args.folder_token:
        body["folder_token"] = args.folder_token
    with session:
        payload = request_api(session, "POST", "/bitable/v1/apps", token, None, None, body, base_url)
    app_token = payload.get("data", {}).get("app", {}).get("app_token")
    if app_token:
        payload.setdefault("links", {}).update(build_bitable_urls(app_token))
    return print_payload(payload)


def cmd_bitable_app_get(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    with session:
        payload = request_api(session, "GET", f"/bitable/v1/apps/{args.app_token}", token, None, None, None, base_url)
    payload.setdefault("links", {}).update(build_bitable_urls(args.app_token))
    return print_payload(payload)


def cmd_bitable_app_list(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    query: Dict[str, str] = {}
    if args.folder_token:
        query["folder_token"] = args.folder_token
    if args.page_size is not None:
        query["page_size"] = str(args.page_size)
    if args.page_token:
        query["page_token"] = args.page_token
    with session:
        payload = request_api(session, "GET", "/drive/v1/files", token, query, None, None, base_url)
    data = payload.get("data", {})
    files = [item for item in data.get("files", []) if item.get("type") == "bitable"]
    payload["data"]["files"] = files
    return print_payload(payload)


def cmd_bitable_app_patch(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    body: JsonObject = {}
    if args.name is not None:
        body["name"] = args.name
    if args.is_advanced is not None:
        body["is_advanced"] = args.is_advanced
    with session:
        payload = request_api(session, "PATCH", f"/bitable/v1/apps/{args.app_token}", token, None, None, body, base_url)
    payload.setdefault("links", {}).update(build_bitable_urls(args.app_token))
    return print_payload(payload)


def cmd_bitable_app_copy(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    body: JsonObject = {"name": args.name}
    if args.folder_token:
        body["folder_token"] = args.folder_token
    with session:
        payload = request_api(session, "POST", f"/bitable/v1/apps/{args.app_token}/copy", token, None, None, body, base_url)
    app_token = payload.get("data", {}).get("app", {}).get("app_token")
    if app_token:
        payload.setdefault("links", {}).update(build_bitable_urls(app_token))
    return print_payload(payload)


def cmd_bitable_table_create(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    table: JsonObject = {"name": args.name}
    if args.default_view_name:
        table["default_view_name"] = args.default_view_name
    fields = load_json_source(args.fields_json, args.fields_file, "fields")
    if fields is not None:
        if not isinstance(fields, list):
            raise ValueError("Table fields payload must be a JSON array.")
        normalized_fields = []
        for field in fields:
            if not isinstance(field, dict):
                raise ValueError("Each table field definition must be a JSON object.")
            normalized_fields.append(omit_property_for_special_field(field.get("type"), field))
        table["fields"] = normalized_fields
    body = {"table": table}
    with session:
        payload = request_api(session, "POST", f"/bitable/v1/apps/{args.app_token}/tables", token, None, None, body, base_url)
    table_id = payload.get("data", {}).get("table_id")
    default_view_id = payload.get("data", {}).get("default_view_id")
    payload.setdefault("links", {}).update(build_bitable_urls(args.app_token, table_id=table_id, view_id=default_view_id))
    return print_payload(payload)


def cmd_bitable_table_list(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    query: Dict[str, str] = {}
    if args.page_size is not None:
        query["page_size"] = str(args.page_size)
    if args.page_token:
        query["page_token"] = args.page_token
    with session:
        payload = request_api(session, "GET", f"/bitable/v1/apps/{args.app_token}/tables", token, query, None, None, base_url)
    return print_payload(payload)


def cmd_bitable_table_patch(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    body = {"name": args.name}
    with session:
        payload = request_api(session, "PATCH", f"/bitable/v1/apps/{args.app_token}/tables/{args.table_id}", token, None, None, body, base_url)
    payload.setdefault("links", {}).update(build_bitable_urls(args.app_token, table_id=args.table_id))
    return print_payload(payload)


def cmd_bitable_table_delete(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    with session:
        payload = request_api(session, "DELETE", f"/bitable/v1/apps/{args.app_token}/tables/{args.table_id}", token, None, None, None, base_url)
    return print_payload(payload)


def cmd_bitable_table_batch_create(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    body = {"tables": load_tables(args)}
    with session:
        payload = request_api(session, "POST", f"/bitable/v1/apps/{args.app_token}/tables/batch_create", token, None, None, body, base_url)
    return print_payload(payload)


def cmd_bitable_table_batch_delete(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    body = {"table_ids": args.table_ids}
    with session:
        payload = request_api(session, "POST", f"/bitable/v1/apps/{args.app_token}/tables/batch_delete", token, None, None, body, base_url)
    return print_payload(payload)


def cmd_bitable_field_create(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    body: JsonObject = {"field_name": args.field_name, "type": args.type}
    property_payload = load_property(args)
    if property_payload is not None:
        body["property"] = property_payload
    body = omit_property_for_special_field(args.type, body)
    with session:
        payload = request_api(session, "POST", f"/bitable/v1/apps/{args.app_token}/tables/{args.table_id}/fields", token, None, None, body, base_url)
    return print_payload(payload)


def cmd_bitable_field_list(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    query: Dict[str, str] = {}
    if args.view_id:
        query["view_id"] = args.view_id
    if args.page_size is not None:
        query["page_size"] = str(args.page_size)
    if args.page_token:
        query["page_token"] = args.page_token
    with session:
        payload = request_api(session, "GET", f"/bitable/v1/apps/{args.app_token}/tables/{args.table_id}/fields", token, query, None, None, base_url)
    return print_payload(payload)


def cmd_bitable_field_update(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    with session:
        current = get_bitable_field_detail(session, token, base_url, args.app_token, args.table_id, args.field_id)
        body: JsonObject = {
            "field_name": args.field_name or current.get("field_name"),
            "type": args.type if args.type is not None else current.get("type"),
        }
        property_payload = load_property(args)
        if property_payload is not None:
            body["property"] = property_payload
        elif "property" in current:
            body["property"] = current.get("property")
        body = omit_property_for_special_field(body.get("type"), body)
        payload = request_api(session, "PUT", f"/bitable/v1/apps/{args.app_token}/tables/{args.table_id}/fields/{args.field_id}", token, None, None, body, base_url)
    return print_payload(payload)


def cmd_bitable_field_delete(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    with session:
        payload = request_api(session, "DELETE", f"/bitable/v1/apps/{args.app_token}/tables/{args.table_id}/fields/{args.field_id}", token, None, None, None, base_url)
    return print_payload(payload)


def cmd_bitable_view_create(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    body: JsonObject = {"view_name": args.view_name, "view_type": args.view_type}
    with session:
        payload = request_api(session, "POST", f"/bitable/v1/apps/{args.app_token}/tables/{args.table_id}/views", token, None, None, body, base_url)
    view = payload.get("data", {}).get("view", {})
    view_id = view.get("view_id")
    payload.setdefault("links", {}).update(build_bitable_urls(args.app_token, table_id=args.table_id, view_id=view_id))
    return print_payload(payload)


def cmd_bitable_view_get(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    with session:
        payload = request_api(session, "GET", f"/bitable/v1/apps/{args.app_token}/tables/{args.table_id}/views/{args.view_id}", token, None, None, None, base_url)
    payload.setdefault("links", {}).update(build_bitable_urls(args.app_token, table_id=args.table_id, view_id=args.view_id))
    return print_payload(payload)


def cmd_bitable_view_list(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    query: Dict[str, str] = {}
    if args.page_size is not None:
        query["page_size"] = str(args.page_size)
    if args.page_token:
        query["page_token"] = args.page_token
    with session:
        payload = request_api(session, "GET", f"/bitable/v1/apps/{args.app_token}/tables/{args.table_id}/views", token, query, None, None, base_url)
    return print_payload(payload)


def cmd_bitable_view_patch(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    body = {"view_name": args.view_name}
    with session:
        payload = request_api(session, "PATCH", f"/bitable/v1/apps/{args.app_token}/tables/{args.table_id}/views/{args.view_id}", token, None, None, body, base_url)
    payload.setdefault("links", {}).update(build_bitable_urls(args.app_token, table_id=args.table_id, view_id=args.view_id))
    return print_payload(payload)


def cmd_bitable_view_delete(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    with session:
        payload = request_api(session, "DELETE", f"/bitable/v1/apps/{args.app_token}/tables/{args.table_id}/views/{args.view_id}", token, None, None, None, base_url)
    return print_payload(payload)

def cmd_bitable_list_records(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    query: Dict[str, str] = {}
    if args.page_size is not None:
        query["page_size"] = str(args.page_size)
    if args.page_token:
        query["page_token"] = args.page_token
    add_user_id_type(query, args)
    body: JsonObject = {}
    if args.view_id:
        body["view_id"] = args.view_id
    if args.field_names:
        body["field_names"] = args.field_names
    filter_payload = load_filter(args)
    if filter_payload is not None:
        body["filter"] = filter_payload
    sort_payload = load_sort(args)
    if sort_payload is not None:
        body["sort"] = sort_payload
    if args.automatic_fields is not None:
        body["automatic_fields"] = args.automatic_fields
    with session:
        payload = request_api(session, "POST", f"/bitable/v1/apps/{args.app_token}/tables/{args.table_id}/records/search", token, query, None, body, base_url)
    return print_payload(payload)


def cmd_bitable_create_record(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    query: Dict[str, str] = {}
    add_user_id_type(query, args)
    body: JsonObject = {"fields": load_fields(args)}
    if args.client_token:
        body["client_token"] = args.client_token
    with session:
        payload = request_api(session, "POST", f"/bitable/v1/apps/{args.app_token}/tables/{args.table_id}/records", token, query, None, body, base_url)
    return print_payload(payload)


def cmd_bitable_update_record(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    query: Dict[str, str] = {}
    add_user_id_type(query, args)
    body = {"fields": load_fields(args)}
    with session:
        payload = request_api(session, "PUT", f"/bitable/v1/apps/{args.app_token}/tables/{args.table_id}/records/{args.record_id}", token, query, None, body, base_url)
    return print_payload(payload)


def cmd_bitable_delete_record(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    with session:
        payload = request_api(session, "DELETE", f"/bitable/v1/apps/{args.app_token}/tables/{args.table_id}/records/{args.record_id}", token, None, None, None, base_url)
    return print_payload(payload)


def cmd_bitable_batch_create_records(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    query: Dict[str, str] = {}
    add_user_id_type(query, args)
    body = {"records": load_records(args)}
    with session:
        payload = request_api(session, "POST", f"/bitable/v1/apps/{args.app_token}/tables/{args.table_id}/records/batch_create", token, query, None, body, base_url)
    return print_payload(payload)


def cmd_bitable_batch_update_records(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    query: Dict[str, str] = {}
    add_user_id_type(query, args)
    body = {"records": load_records(args)}
    with session:
        payload = request_api(session, "POST", f"/bitable/v1/apps/{args.app_token}/tables/{args.table_id}/records/batch_update", token, query, None, body, base_url)
    return print_payload(payload)


def cmd_bitable_batch_delete_records(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    body = {"records": args.record_ids}
    with session:
        payload = request_api(session, "POST", f"/bitable/v1/apps/{args.app_token}/tables/{args.table_id}/records/batch_delete", token, None, None, body, base_url)
    return print_payload(payload)


def cmd_sheets_get_values(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    encoded_range = quote(args.range, safe="")
    with session:
        payload = request_api(session, "GET", f"/sheets/v2/spreadsheets/{args.spreadsheet_token}/values/{encoded_range}", token, None, None, None, base_url)
    return print_payload(payload)


def cmd_sheets_put_values(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    body = {"valueRange": {"range": args.range, "values": load_values(args)}}
    with session:
        payload = request_api(session, "PUT", f"/sheets/v2/spreadsheets/{args.spreadsheet_token}/values", token, None, None, body, base_url)
    return print_payload(payload)


def cmd_sheets_insert_dimension(args: argparse.Namespace) -> int:
    session, token, base_url = build_session_and_token(args)
    body = {
        "dimension": {
            "sheetId": args.sheet_id,
            "majorDimension": args.major_dimension,
            "startIndex": args.start_index,
            "endIndex": args.end_index,
        },
        "inheritStyle": args.inherit_style,
    }
    with session:
        payload = request_api(session, "POST", f"/sheets/v2/spreadsheets/{args.spreadsheet_token}/insert_dimension_range", token, None, None, body, base_url)
    return print_payload(payload)


def add_auth_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--token")
    parser.add_argument("--app-id")
    parser.add_argument("--app-secret")


def add_body_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--body-json", help="Inline JSON object body.")
    parser.add_argument("--body-file", help="Path to a JSON file used as request body.")


def add_fields_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--fields-json", help="Inline JSON object for record fields.")
    parser.add_argument("--fields-file", help="Path to a JSON file containing record fields.")


def add_values_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--values-json", help="Inline JSON 2D array for sheet values.")
    parser.add_argument("--values-file", help="Path to a JSON file containing a 2D values array.")


def add_records_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--records-json", help="Inline JSON array for batch record payloads.")
    parser.add_argument("--records-file", help="Path to a JSON file containing a batch record payload array.")


def add_tables_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--tables-json", help="Inline JSON array for batch table payloads.")
    parser.add_argument("--tables-file", help="Path to a JSON file containing a batch table payload array.")


def add_property_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--property-json", help="Inline JSON for field property configuration.")
    parser.add_argument("--property-file", help="Path to a JSON file containing field property configuration.")


def add_filter_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--filter-json", help="Inline JSON filter object for bitable search.")
    parser.add_argument("--filter-file", help="Path to a JSON file containing a bitable filter object.")


def add_sort_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--sort-json", help="Inline JSON sort array for bitable search.")
    parser.add_argument("--sort-file", help="Path to a JSON file containing a bitable sort array.")


def add_user_id_type_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--user-id-type", choices=["open_id", "union_id", "user_id"], help="Optional user_id_type for bitable person fields.")


def add_paging_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--page-size", type=int)
    parser.add_argument("--page-token")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Call Feishu official OpenAPI endpoints.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    token_parser = subparsers.add_parser("tenant-token", help="Fetch a tenant access token for an internal app.")
    token_parser.add_argument("--app-id")
    token_parser.add_argument("--app-secret")
    token_parser.set_defaults(func=cmd_tenant_token)

    request_parser = subparsers.add_parser("request", help="Call any Feishu OpenAPI endpoint.")
    request_parser.add_argument("--method", choices=["GET", "POST", "PUT", "PATCH", "DELETE"], required=True)
    request_parser.add_argument("--path", required=True, help="Endpoint path like /im/v1/messages")
    add_auth_args(request_parser)
    request_parser.add_argument("--query", action="append", default=[], help="Query parameter in KEY=VALUE form.")
    request_parser.add_argument("--header", action="append", default=[], help="Header in KEY=VALUE form.")
    add_body_args(request_parser)
    request_parser.set_defaults(func=cmd_request)

    for method in ("get", "post", "put", "patch", "delete"):
        alias_parser = subparsers.add_parser(method, help=f"Shortcut for {method.upper()} request.")
        alias_parser.add_argument("--path", required=True, help="Endpoint path like /im/v1/messages")
        add_auth_args(alias_parser)
        alias_parser.add_argument("--query", action="append", default=[], help="Query parameter in KEY=VALUE form.")
        alias_parser.add_argument("--header", action="append", default=[], help="Header in KEY=VALUE form.")
        add_body_args(alias_parser)
        alias_parser.set_defaults(func=cmd_request, method=method.upper())

    docx_create_parser = subparsers.add_parser("docx-create", help="Create a Feishu document.")
    add_auth_args(docx_create_parser)
    docx_create_parser.add_argument("--title", required=True)
    docx_create_parser.add_argument("--folder-token")
    docx_create_parser.set_defaults(func=cmd_docx_create)

    docx_raw_parser = subparsers.add_parser("docx-raw-content", help="Get document raw text content.")
    add_auth_args(docx_raw_parser)
    docx_raw_parser.add_argument("--document-id", required=True)
    docx_raw_parser.set_defaults(func=cmd_docx_raw_content)

    docx_blocks_parser = subparsers.add_parser("docx-list-blocks", help="List document blocks.")
    add_auth_args(docx_blocks_parser)
    docx_blocks_parser.add_argument("--document-id", required=True)
    add_paging_args(docx_blocks_parser)
    docx_blocks_parser.add_argument("--document-revision-id", type=int)
    docx_blocks_parser.set_defaults(func=cmd_docx_list_blocks)

    docx_children_parser = subparsers.add_parser("docx-list-children", help="List children under a document block.")
    add_auth_args(docx_children_parser)
    docx_children_parser.add_argument("--document-id", required=True)
    docx_children_parser.add_argument("--block-id", required=True)
    add_paging_args(docx_children_parser)
    docx_children_parser.add_argument("--document-revision-id", type=int)
    docx_children_parser.set_defaults(func=cmd_docx_list_children)

    docx_append_parser = subparsers.add_parser("docx-append-text", help="Append a text block to a document or parent block.")
    add_auth_args(docx_append_parser)
    docx_append_parser.add_argument("--document-id", required=True)
    docx_append_parser.add_argument("--parent-block-id", help="Defaults to document_id, which is commonly used as the root block.")
    docx_append_parser.add_argument("--text", required=True)
    docx_append_parser.add_argument("--index", type=int, default=-1, help="Insert position. Use -1 for append.")
    docx_append_parser.add_argument("--block-type", type=int, default=2, help="Default 2 for paragraph text block.")
    docx_append_parser.add_argument("--document-revision-id", type=int)
    docx_append_parser.set_defaults(func=cmd_docx_append_text)

    docx_update_parser = subparsers.add_parser("docx-update-text", help="Replace text elements in an existing text block.")
    add_auth_args(docx_update_parser)
    docx_update_parser.add_argument("--document-id", required=True)
    docx_update_parser.add_argument("--block-id", required=True)
    docx_update_parser.add_argument("--text", required=True)
    docx_update_parser.set_defaults(func=cmd_docx_update_text)

    docx_delete_parser = subparsers.add_parser("docx-delete-children", help="Delete a range of child blocks under a parent block.")
    add_auth_args(docx_delete_parser)
    docx_delete_parser.add_argument("--document-id", required=True)
    docx_delete_parser.add_argument("--block-id", required=True, help="Parent block id whose child index range will be deleted; list children on this parent first, then delete by child indexes. This is not the child block id itself.")
    docx_delete_parser.add_argument("--start-index", type=int, required=True)
    docx_delete_parser.add_argument("--end-index", type=int, required=True)
    docx_delete_parser.add_argument("--document-revision-id", type=int)
    docx_delete_parser.set_defaults(func=cmd_docx_delete_children)

    bitable_app_create_parser = subparsers.add_parser("bitable-app-create", help="Create a bitable app.")
    add_auth_args(bitable_app_create_parser)
    bitable_app_create_parser.add_argument("--name", required=True)
    bitable_app_create_parser.add_argument("--folder-token")
    bitable_app_create_parser.set_defaults(func=cmd_bitable_app_create)

    bitable_app_get_parser = subparsers.add_parser("bitable-app-get", help="Get bitable app metadata.")
    add_auth_args(bitable_app_get_parser)
    bitable_app_get_parser.add_argument("--app-token", required=True)
    bitable_app_get_parser.set_defaults(func=cmd_bitable_app_get)

    bitable_app_list_parser = subparsers.add_parser("bitable-app-list", help="List bitable apps using Drive files API.")
    add_auth_args(bitable_app_list_parser)
    bitable_app_list_parser.add_argument("--folder-token")
    add_paging_args(bitable_app_list_parser)
    bitable_app_list_parser.set_defaults(func=cmd_bitable_app_list)

    bitable_app_patch_parser = subparsers.add_parser("bitable-app-patch", help="Update bitable app metadata.")
    add_auth_args(bitable_app_patch_parser)
    bitable_app_patch_parser.add_argument("--app-token", required=True)
    bitable_app_patch_parser.add_argument("--name")
    bitable_app_patch_parser.add_argument("--is-advanced", dest="is_advanced", action="store_true")
    bitable_app_patch_parser.add_argument("--no-is-advanced", dest="is_advanced", action="store_false")
    bitable_app_patch_parser.set_defaults(func=cmd_bitable_app_patch, is_advanced=None)

    bitable_app_copy_parser = subparsers.add_parser("bitable-app-copy", help="Copy a bitable app.")
    add_auth_args(bitable_app_copy_parser)
    bitable_app_copy_parser.add_argument("--app-token", required=True)
    bitable_app_copy_parser.add_argument("--name", required=True)
    bitable_app_copy_parser.add_argument("--folder-token")
    bitable_app_copy_parser.set_defaults(func=cmd_bitable_app_copy)

    bitable_table_create_parser = subparsers.add_parser("bitable-table-create", help="Create a bitable table.")
    add_auth_args(bitable_table_create_parser)
    bitable_table_create_parser.add_argument("--app-token", required=True)
    bitable_table_create_parser.add_argument("--name", required=True)
    bitable_table_create_parser.add_argument("--default-view-name")
    bitable_table_create_parser.add_argument("--fields-json", help="Inline JSON array of field definitions for table creation.")
    bitable_table_create_parser.add_argument("--fields-file", help="Path to a JSON file containing field definitions for table creation.")
    bitable_table_create_parser.set_defaults(func=cmd_bitable_table_create)

    bitable_table_list_parser = subparsers.add_parser("bitable-table-list", help="List tables in a bitable app.")
    add_auth_args(bitable_table_list_parser)
    bitable_table_list_parser.add_argument("--app-token", required=True)
    add_paging_args(bitable_table_list_parser)
    bitable_table_list_parser.set_defaults(func=cmd_bitable_table_list)

    bitable_table_patch_parser = subparsers.add_parser("bitable-table-patch", help="Rename a bitable table.")
    add_auth_args(bitable_table_patch_parser)
    bitable_table_patch_parser.add_argument("--app-token", required=True)
    bitable_table_patch_parser.add_argument("--table-id", required=True)
    bitable_table_patch_parser.add_argument("--name", required=True)
    bitable_table_patch_parser.set_defaults(func=cmd_bitable_table_patch)

    bitable_table_delete_parser = subparsers.add_parser("bitable-table-delete", help="Delete a bitable table.")
    add_auth_args(bitable_table_delete_parser)
    bitable_table_delete_parser.add_argument("--app-token", required=True)
    bitable_table_delete_parser.add_argument("--table-id", required=True)
    bitable_table_delete_parser.set_defaults(func=cmd_bitable_table_delete)

    bitable_table_batch_create_parser = subparsers.add_parser("bitable-table-batch-create", help="Batch create bitable tables.")
    add_auth_args(bitable_table_batch_create_parser)
    bitable_table_batch_create_parser.add_argument("--app-token", required=True)
    add_tables_args(bitable_table_batch_create_parser)
    bitable_table_batch_create_parser.set_defaults(func=cmd_bitable_table_batch_create)

    bitable_table_batch_delete_parser = subparsers.add_parser("bitable-table-batch-delete", help="Batch delete bitable tables.")
    add_auth_args(bitable_table_batch_delete_parser)
    bitable_table_batch_delete_parser.add_argument("--app-token", required=True)
    bitable_table_batch_delete_parser.add_argument("--table-id", dest="table_ids", action="append", required=True)
    bitable_table_batch_delete_parser.set_defaults(func=cmd_bitable_table_batch_delete)

    bitable_field_create_parser = subparsers.add_parser("bitable-field-create", help="Create a bitable field.")
    add_auth_args(bitable_field_create_parser)
    bitable_field_create_parser.add_argument("--app-token", required=True)
    bitable_field_create_parser.add_argument("--table-id", required=True)
    bitable_field_create_parser.add_argument("--field-name", required=True)
    bitable_field_create_parser.add_argument("--type", required=True, type=int)
    add_property_args(bitable_field_create_parser)
    bitable_field_create_parser.set_defaults(func=cmd_bitable_field_create)

    bitable_field_list_parser = subparsers.add_parser("bitable-field-list", help="List fields in a bitable table.")
    add_auth_args(bitable_field_list_parser)
    bitable_field_list_parser.add_argument("--app-token", required=True)
    bitable_field_list_parser.add_argument("--table-id", required=True)
    bitable_field_list_parser.add_argument("--view-id")
    add_paging_args(bitable_field_list_parser)
    bitable_field_list_parser.set_defaults(func=cmd_bitable_field_list)

    bitable_field_update_parser = subparsers.add_parser("bitable-field-update", help="Update a bitable field.")
    add_auth_args(bitable_field_update_parser)
    bitable_field_update_parser.add_argument("--app-token", required=True)
    bitable_field_update_parser.add_argument("--table-id", required=True)
    bitable_field_update_parser.add_argument("--field-id", required=True)
    bitable_field_update_parser.add_argument("--field-name")
    bitable_field_update_parser.add_argument("--type", type=int)
    add_property_args(bitable_field_update_parser)
    bitable_field_update_parser.set_defaults(func=cmd_bitable_field_update)

    bitable_field_delete_parser = subparsers.add_parser("bitable-field-delete", help="Delete a bitable field.")
    add_auth_args(bitable_field_delete_parser)
    bitable_field_delete_parser.add_argument("--app-token", required=True)
    bitable_field_delete_parser.add_argument("--table-id", required=True)
    bitable_field_delete_parser.add_argument("--field-id", required=True)
    bitable_field_delete_parser.set_defaults(func=cmd_bitable_field_delete)

    bitable_view_create_parser = subparsers.add_parser("bitable-view-create", help="Create a bitable view.")
    add_auth_args(bitable_view_create_parser)
    bitable_view_create_parser.add_argument("--app-token", required=True)
    bitable_view_create_parser.add_argument("--table-id", required=True)
    bitable_view_create_parser.add_argument("--view-name", required=True)
    bitable_view_create_parser.add_argument("--view-type", choices=["grid", "kanban", "gallery", "gantt", "form"], default="grid")
    bitable_view_create_parser.set_defaults(func=cmd_bitable_view_create)

    bitable_view_get_parser = subparsers.add_parser("bitable-view-get", help="Get a bitable view.")
    add_auth_args(bitable_view_get_parser)
    bitable_view_get_parser.add_argument("--app-token", required=True)
    bitable_view_get_parser.add_argument("--table-id", required=True)
    bitable_view_get_parser.add_argument("--view-id", required=True)
    bitable_view_get_parser.set_defaults(func=cmd_bitable_view_get)

    bitable_view_list_parser = subparsers.add_parser("bitable-view-list", help="List views in a bitable table.")
    add_auth_args(bitable_view_list_parser)
    bitable_view_list_parser.add_argument("--app-token", required=True)
    bitable_view_list_parser.add_argument("--table-id", required=True)
    add_paging_args(bitable_view_list_parser)
    bitable_view_list_parser.set_defaults(func=cmd_bitable_view_list)

    bitable_view_patch_parser = subparsers.add_parser("bitable-view-patch", help="Rename a bitable view.")
    add_auth_args(bitable_view_patch_parser)
    bitable_view_patch_parser.add_argument("--app-token", required=True)
    bitable_view_patch_parser.add_argument("--table-id", required=True)
    bitable_view_patch_parser.add_argument("--view-id", required=True)
    bitable_view_patch_parser.add_argument("--view-name", required=True)
    bitable_view_patch_parser.set_defaults(func=cmd_bitable_view_patch)

    bitable_view_delete_parser = subparsers.add_parser("bitable-view-delete", help="Delete a bitable view.")
    add_auth_args(bitable_view_delete_parser)
    bitable_view_delete_parser.add_argument("--app-token", required=True)
    bitable_view_delete_parser.add_argument("--table-id", required=True)
    bitable_view_delete_parser.add_argument("--view-id", required=True)
    bitable_view_delete_parser.set_defaults(func=cmd_bitable_view_delete)

    bitable_records_list_parser = subparsers.add_parser("bitable-list-records", help="Search records from a bitable table using the records/search API.")
    add_auth_args(bitable_records_list_parser)
    bitable_records_list_parser.add_argument("--app-token", required=True)
    bitable_records_list_parser.add_argument("--table-id", required=True)
    add_user_id_type_arg(bitable_records_list_parser)
    add_paging_args(bitable_records_list_parser)
    bitable_records_list_parser.add_argument("--view-id")
    bitable_records_list_parser.add_argument("--field-name", dest="field_names", action="append", default=[], help="Repeat to limit returned fields.")
    add_filter_args(bitable_records_list_parser)
    add_sort_args(bitable_records_list_parser)
    bitable_records_list_parser.add_argument("--automatic-fields", dest="automatic_fields", action="store_true")
    bitable_records_list_parser.add_argument("--no-automatic-fields", dest="automatic_fields", action="store_false")
    bitable_records_list_parser.set_defaults(func=cmd_bitable_list_records, automatic_fields=None)

    bitable_record_create_parser = subparsers.add_parser("bitable-create-record", help="Create a bitable record.")
    add_auth_args(bitable_record_create_parser)
    bitable_record_create_parser.add_argument("--app-token", required=True)
    bitable_record_create_parser.add_argument("--table-id", required=True)
    add_user_id_type_arg(bitable_record_create_parser)
    bitable_record_create_parser.add_argument("--client-token", help="Optional idempotency token.")
    add_fields_args(bitable_record_create_parser)
    bitable_record_create_parser.set_defaults(func=cmd_bitable_create_record)

    bitable_record_update_parser = subparsers.add_parser("bitable-update-record", help="Update a bitable record.")
    add_auth_args(bitable_record_update_parser)
    bitable_record_update_parser.add_argument("--app-token", required=True)
    bitable_record_update_parser.add_argument("--table-id", required=True)
    bitable_record_update_parser.add_argument("--record-id", required=True)
    add_user_id_type_arg(bitable_record_update_parser)
    add_fields_args(bitable_record_update_parser)
    bitable_record_update_parser.set_defaults(func=cmd_bitable_update_record)

    bitable_record_delete_parser = subparsers.add_parser("bitable-delete-record", help="Delete a bitable record.")
    add_auth_args(bitable_record_delete_parser)
    bitable_record_delete_parser.add_argument("--app-token", required=True)
    bitable_record_delete_parser.add_argument("--table-id", required=True)
    bitable_record_delete_parser.add_argument("--record-id", required=True)
    bitable_record_delete_parser.set_defaults(func=cmd_bitable_delete_record)

    bitable_batch_create_parser = subparsers.add_parser("bitable-batch-create-records", help="Batch create bitable records.")
    add_auth_args(bitable_batch_create_parser)
    bitable_batch_create_parser.add_argument("--app-token", required=True)
    bitable_batch_create_parser.add_argument("--table-id", required=True)
    add_user_id_type_arg(bitable_batch_create_parser)
    add_records_args(bitable_batch_create_parser)
    bitable_batch_create_parser.set_defaults(func=cmd_bitable_batch_create_records)

    bitable_batch_update_parser = subparsers.add_parser("bitable-batch-update-records", help="Batch update bitable records.")
    add_auth_args(bitable_batch_update_parser)
    bitable_batch_update_parser.add_argument("--app-token", required=True)
    bitable_batch_update_parser.add_argument("--table-id", required=True)
    add_user_id_type_arg(bitable_batch_update_parser)
    add_records_args(bitable_batch_update_parser)
    bitable_batch_update_parser.set_defaults(func=cmd_bitable_batch_update_records)

    bitable_batch_delete_parser = subparsers.add_parser("bitable-batch-delete-records", help="Batch delete bitable records.")
    add_auth_args(bitable_batch_delete_parser)
    bitable_batch_delete_parser.add_argument("--app-token", required=True)
    bitable_batch_delete_parser.add_argument("--table-id", required=True)
    bitable_batch_delete_parser.add_argument("--record-id", dest="record_ids", action="append", required=True)
    bitable_batch_delete_parser.set_defaults(func=cmd_bitable_batch_delete_records)

    sheets_get_parser = subparsers.add_parser("sheets-get-values", help="Read a range from a spreadsheet.")
    add_auth_args(sheets_get_parser)
    sheets_get_parser.add_argument("--spreadsheet-token", required=True)
    sheets_get_parser.add_argument("--range", required=True, help="Range like sheetId!A1:B3")
    sheets_get_parser.set_defaults(func=cmd_sheets_get_values)

    sheets_put_parser = subparsers.add_parser("sheets-put-values", help="Write values to a spreadsheet range.")
    add_auth_args(sheets_put_parser)
    sheets_put_parser.add_argument("--spreadsheet-token", required=True)
    sheets_put_parser.add_argument("--range", required=True, help="Range like sheetId!A1:B3")
    add_values_args(sheets_put_parser)
    sheets_put_parser.set_defaults(func=cmd_sheets_put_values)

    sheets_insert_parser = subparsers.add_parser("sheets-insert-dimension", help="Insert rows or columns into a spreadsheet.")
    add_auth_args(sheets_insert_parser)
    sheets_insert_parser.add_argument("--spreadsheet-token", required=True)
    sheets_insert_parser.add_argument("--sheet-id", required=True)
    sheets_insert_parser.add_argument("--major-dimension", choices=["ROWS", "COLUMNS"], required=True)
    sheets_insert_parser.add_argument("--start-index", type=int, required=True)
    sheets_insert_parser.add_argument("--end-index", type=int, required=True)
    sheets_insert_parser.add_argument("--inherit-style", choices=["BEFORE", "AFTER"], default="AFTER")
    sheets_insert_parser.set_defaults(func=cmd_sheets_insert_dimension)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return args.func(args)
    except requests.RequestException as exc:
        print(f"Request failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

