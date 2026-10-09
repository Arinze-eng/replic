---
name: xlsx
description: 打开、读取、编辑或修复现有的 .xlsx、.xlsm、.csv 或 .tsv 文件
---

# Excel表格文件处理

**Category:** external · **Tags:** office, content · **Author:** Anthropic
> **Homepage:** https://github.com/anthropics/skills/blob/main/skills/xlsx

打开、读取、编辑或修复现有的 .xlsx、.xlsm、.csv 或 .tsv 文件

在任何以电子表格文件为主要输入或输出的情况下使用此技能。这意味着用户希望执行以下任务：
- 打开、读取、编辑或修复现有的 .xlsx、.xlsm、.csv 或 .tsv 文件（例如，添加列、计算公式、格式化、制作图表、清理混乱数据）；
- 从零开始或从其他数据源创建新的电子表格；或者在表格文件格式之间转换。特别是在用户通过名称或路径提及电子表格文件时触发——即使是随意提及（如“我下载中的 xlsx”）——并希望对其进行操作或生成相关内容。
- 也会在清理或重组混乱的表格式数据文件（格式错误的行，错位的标题，垃圾数据）成正确电子表格时触发。交付物必须是电子表格文件。
当主要交付物是 Word 文档、HTML 报告、独立 Python 脚本、数据库管道或 Google Sheets API 集成时，即使涉及到表格数据，也不要触发此技能。


## How to use

When a task matches this skill's purpose, follow the method implied by its description and the tool's homepage. If the skill requires an external API key (see "Requires env" above), use the configured credentials. Produce client-ready, high-quality output.
