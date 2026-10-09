---
name: feishu-workspace
description: Call Feishu OpenAPI for docs, sheets, and bitable through the bundled Python CLI.
homepage: https://open.feishu.cn
metadata:
  emoji: 🪶
  requires:
    bins: ["python"]
    env: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"]
---

# Feishu Workspace

Call Feishu official OpenAPI endpoints for docs, sheets, and bitable by using the bundled `scripts/feishu_openapi.py` CLI.

## Setup

This skill requires:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`

Read these values from environment variables when they are already available in the runtime environment.

If they are missing at runtime:

1. Ask the user for `FEISHU_APP_ID` and `FEISHU_APP_SECRET`
2. You must send the user this official reference link: [How to obtain App ID](https://open.feishu.cn/document/faq/trouble-shooting/how-to-obtain-app-id)
3. Tell the user that `App Secret` is on the same credential page as `App ID`

PowerShell example:

```powershell
$env:FEISHU_APP_ID="cli_xxx"
$env:FEISHU_APP_SECRET="xxx"
```

Optional environment variables:

- `FEISHU_TENANT_ACCESS_TOKEN`
- `FEISHU_BASE_URL`
- `FEISHU_WEB_HOST`
- `FEISHU_ENTRY_HOST`

If `FEISHU_TENANT_ACCESS_TOKEN` is absent, the script automatically requests a tenant token by using `FEISHU_APP_ID` and `FEISHU_APP_SECRET`.

## Resource Permissions

Check environment variables first. Only troubleshoot resource permissions after confirming `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are available.

Even when the app credentials are valid, Feishu may still reject operations on a specific document or spreadsheet if the app has not been added to that resource.

A common signal is:

```text
Request failed: 403 Client Error: Forbidden
```

If an operation fails with a document or sheet permission error, guide the user to do the following with the Chinese UI labels:

1. Open the target document or spreadsheet
2. 点击右上角的 `···`
3. 选择 `更多`
4. 选择 `添加文档应用`
5. 在弹出界面搜索应用名称
6. 赋予 `可管理` 或 `可编辑` 权限

Do not assume app-level credentials automatically grant access to every existing document, sheet, or bitable resource.

## Usage

Prefer the bundled Python CLI:

```powershell
python scripts/feishu_openapi.py <command> [options]
```

Use dedicated commands before generic HTTP requests.

Quick routing:

- Docs create/read/edit: `docx-*`
- Bitable app/table/field/view/record operations: `bitable-*`
- Sheets read/write/insert: `sheets-*`
- Unsupported official endpoints: `request`, `get`, `post`, `put`, `patch`, `delete`

Recommended workflows:

- Document editing: inspect with `docx-list-blocks` or `docx-list-children` before update or delete
- Document line deletion: always list the parent block's children first, then call `docx-delete-children` by child index range
- Bitable record writes: call `bitable-field-list` first when the schema is not already known
- Bitable schema changes: use `bitable-table-*`, `bitable-field-*`, and `bitable-view-*` in that order when building a new base

## Examples

Create a document:

```powershell
python scripts/feishu_openapi.py docx-create --title "Project Notes"
```

List child blocks before deleting a visible line:

```powershell
python scripts/feishu_openapi.py docx-list-children --document-id doxcnxxxx --block-id <parent_block_id>
python scripts/feishu_openapi.py docx-delete-children --document-id doxcnxxxx --block-id <parent_block_id> --start-index <last_index> --end-index <last_index_plus_one>
```

Create a bitable app and inspect fields:

```powershell
python scripts/feishu_openapi.py bitable-app-create --name "CRM"
python scripts/feishu_openapi.py bitable-field-list --app-token bascnxxxx --table-id tblxxxx
```

Search or write records:

```powershell
python scripts/feishu_openapi.py bitable-list-records --app-token bascnxxxx --table-id tblxxxx --filter-file filter.json --sort-file sort.json
python scripts/feishu_openapi.py bitable-create-record --app-token bascnxxxx --table-id tblxxxx --fields-file fields.json
python scripts/feishu_openapi.py bitable-batch-create-records --app-token bascnxxxx --table-id tblxxxx --records-file records.json
```

Read or write sheets:

```powershell
python scripts/feishu_openapi.py sheets-get-values --spreadsheet-token shtcnxxxx --range "sheetId!A1:B3"
python scripts/feishu_openapi.py sheets-put-values --spreadsheet-token shtcnxxxx --range "sheetId!A1:B3" --values-file values.json
```

Call any official endpoint:

```powershell
python scripts/feishu_openapi.py post --path /im/v1/messages --body-file body.json
```

## Response

The CLI prints JSON to stdout.

The following examples are illustrative response shapes, not fixed verbatim payloads.

Illustrative success shape:

```json
{
  "code": 0,
  "data": {
    "...": "..."
  }
}
```

Illustrative error shape:

```json
{
  "code": 99991663,
  "msg": "No permission"
}
```

Treat transport success and Feishu success separately:

- HTTP `200` only means the request reached Feishu
- Top-level `code == 0` means the Feishu operation succeeded

## References

Use these files only when needed:

- [references/api-reference.md](references/api-reference.md): compact endpoint map and response notes
- [references/bitable-field-properties.md](references/bitable-field-properties.md): field type and `property` shape notes
- [references/bitable-record-values.md](references/bitable-record-values.md): common record value payload shapes

## Notes

- Prefer dedicated commands for docs, bitable, and sheets before falling back to generic `request`
- Keep large JSON payloads in files instead of long inline shell strings
- `docx-delete-children` expects the parent block id, not the child block id being removed
- URL fields (`type=15`) and checkbox fields (`type=7`) should omit `property`
