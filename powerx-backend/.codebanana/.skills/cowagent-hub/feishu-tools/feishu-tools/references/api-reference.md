# Feishu Official OpenAPI Notes

Use this file as the compact endpoint map for the standalone Python skill.

## Auth

- Base URL: `https://open.feishu.cn/open-apis`
- Internal app token: `POST /auth/v3/tenant_access_token/internal`
- Auth header: `Authorization: Bearer <tenant_access_token>`

## Docs

- Create document: `POST /docx/v1/documents`
- Get raw content: `GET /docx/v1/documents/{document_id}/raw_content`
- List blocks: `GET /docx/v1/documents/{document_id}/blocks`
- List children: `GET /docx/v1/documents/{document_id}/blocks/{block_id}/children`
- Insert child blocks: `POST /docx/v1/documents/{document_id}/blocks/{block_id}/children`
- Update block text: `PATCH /docx/v1/documents/{document_id}/blocks/{block_id}`
- Delete child block range: `DELETE /docx/v1/documents/{document_id}/blocks/{block_id}/children/batch_delete`

Practical delete flow:
1. Call `docx-list-children` on the parent block.
2. Find the child index range you want to remove.
3. Call `docx-delete-children` with `start_index` and `end_index`.


User-facing doc link note:
- A created doc is normally opened with a `/docx/{document_id}` URL, not `/document/{document_id}`
- Generic pattern: `https://feishu.cn/docx/{document_id}`
- Entry-host pattern: `https://<entry-host>.feishu.cn/docx/{document_id}`, for example `https://sg0ee1nbp0.feishu.cn/docx/{document_id}`
- Tenant-host pattern: `https://<tenant>.feishu.cn/docx/{document_id}`, for example `https://simple-future.feishu.cn/docx/{document_id}`
- Prefer the tenant host for final user-facing links when known; otherwise an entry host can still work and redirect after login

## Bitable App

- Create: `POST /bitable/v1/apps`
- Get: `GET /bitable/v1/apps/{app_token}`
- List: `GET /drive/v1/files` then filter `type=bitable`
- Patch: `PATCH /bitable/v1/apps/{app_token}`
- Copy: `POST /bitable/v1/apps/{app_token}/copy`

## Bitable Table

- Create: `POST /bitable/v1/apps/{app_token}/tables`
- List: `GET /bitable/v1/apps/{app_token}/tables`
- Patch: `PATCH /bitable/v1/apps/{app_token}/tables/{table_id}`
- Delete: `DELETE /bitable/v1/apps/{app_token}/tables/{table_id}`
- Batch create: `POST /bitable/v1/apps/{app_token}/tables/batch_create`
- Batch delete: `POST /bitable/v1/apps/{app_token}/tables/batch_delete`

## Bitable Field

- Create: `POST /bitable/v1/apps/{app_token}/tables/{table_id}/fields`
- List: `GET /bitable/v1/apps/{app_token}/tables/{table_id}/fields`
- Update: `PUT /bitable/v1/apps/{app_token}/tables/{table_id}/fields/{field_id}`
- Delete: `DELETE /bitable/v1/apps/{app_token}/tables/{table_id}/fields/{field_id}`

Important:
- `type=15` URL fields must omit `property`
- `type=7` checkbox fields should also omit `property`

## Bitable View

- Create: `POST /bitable/v1/apps/{app_token}/tables/{table_id}/views`
- Get: `GET /bitable/v1/apps/{app_token}/tables/{table_id}/views/{view_id}`
- List: `GET /bitable/v1/apps/{app_token}/tables/{table_id}/views`
- Patch: `PATCH /bitable/v1/apps/{app_token}/tables/{table_id}/views/{view_id}`
- Delete: `DELETE /bitable/v1/apps/{app_token}/tables/{table_id}/views/{view_id}`

## Bitable Record

- Search/list: `POST /bitable/v1/apps/{app_token}/tables/{table_id}/records/search`
- Create: `POST /bitable/v1/apps/{app_token}/tables/{table_id}/records`
- Update: `PUT /bitable/v1/apps/{app_token}/tables/{table_id}/records/{record_id}`
- Delete: `DELETE /bitable/v1/apps/{app_token}/tables/{table_id}/records/{record_id}`
- Batch create: `POST /bitable/v1/apps/{app_token}/tables/{table_id}/records/batch_create`
- Batch update: `POST /bitable/v1/apps/{app_token}/tables/{table_id}/records/batch_update`
- Batch delete: `POST /bitable/v1/apps/{app_token}/tables/{table_id}/records/batch_delete`

For search payloads, keep `filter`, `sort`, `field_names`, and `view_id` in the JSON body, while `page_size` and `page_token` stay in query params.

## Bitable Link Note

When a bitable app token is known, page URLs normally follow:
- Generic pattern: `https://feishu.cn/base/{app_token}`
- Entry-host pattern: `https://<entry-host>/base/{app_token}`
- Tenant-host pattern: `https://<tenant-host>/base/{app_token}`

When table and view are also known, append query parameters:
- `?table={table_id}`
- `&view={view_id}`

Example:
- `https://simple-future.feishu.cn/base/DRnyb2lICatKdhsl56hcCqn6nTe?table=tblsGUp0Q08R56cG&view=vewVNcd0qg`

## Sheets

- Read range: `GET /sheets/v2/spreadsheets/{spreadsheet_token}/values/{range}`
- Write range: `PUT /sheets/v2/spreadsheets/{spreadsheet_token}/values`
- Insert rows or columns: `POST /sheets/v2/spreadsheets/{spreadsheet_token}/insert_dimension_range`

## Response Validation

Treat HTTP 200 as transport success only. Also require top-level `code == 0` before assuming the Feishu operation succeeded.

