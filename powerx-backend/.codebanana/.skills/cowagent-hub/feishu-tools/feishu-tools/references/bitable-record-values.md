# Bitable Record Value Notes

Use this file when writing bitable record payloads.

## Common value shapes

- Text: `"Task name"`
- Number: `12` or `0.75`
- Single select: `"In Progress"`
- Multi select: `["Urgent", "External"]`
- Date: Unix timestamp in milliseconds
- Checkbox: `true` or `false`
- Person: `[{"id":"ou_xxx"}]`
- Phone: `"13800138000"`
- URL: `{"text":"Feishu","link":"https://open.feishu.cn"}`
- Attachment: `[{"file_token":"xxx"}]`
- Linked record: `{"link_record_ids":["recxxx"]}` or direct array in some table setups
- Group: `[{"id":"oc_xxx"}]`

## High-risk mistakes

- Date fields must use milliseconds, not ISO strings or seconds.
- Person fields should only send `id`, not names or email addresses.
- URL fields must use an object with both `text` and `link`.
- Attachment fields require a file token already uploaded for the target bitable context.

## Write workflow

1. List fields first if the table schema is not fully known.
2. Build values that match the field type exactly.
3. Use batch record operations only when each record shape is already validated.
