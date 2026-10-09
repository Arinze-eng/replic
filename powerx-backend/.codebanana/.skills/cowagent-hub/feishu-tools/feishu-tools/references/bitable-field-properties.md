# Bitable Field Property Notes

Condensed from the official OpenClaw skill references and Feishu OpenAPI behavior.

## Frequent field types

- Text: `type=1`, `property` optional or empty
- Number: `type=2`, optional `property.formatter`
- Single select: `type=3`, `property.options` array
- Multi select: `type=4`, `property.options` array
- Date: `type=5`, optional `property.date_formatter`
- Checkbox: `type=7`, omit `property`
- Person: `type=11`, optional `property.multiple`
- Phone: `type=13`, `property` optional or empty
- URL: `type=15`, omit `property` completely
- Attachment: `type=17`, `property` optional or empty
- One-way link: `type=18`, `property.table_id`, optional `property.multiple`
- Two-way link: `type=21`, `property.table_id`, `property.back_field_name`, optional `property.multiple`

## Display-oriented number fields

- Progress: `type=2`, `ui_type=Progress`, property includes `min`, `max`, optional `range_customize`
- Currency: `type=2`, `ui_type=Currency`, property includes `currency_code`, optional `formatter`
- Rating: `type=2`, `ui_type=Rating`, property includes `min`, `max`, optional `rating.symbol`

## Practical rule

When a field create or update fails, verify both:
- the numeric `type`
- whether `property` must be included, omitted, or shaped differently
