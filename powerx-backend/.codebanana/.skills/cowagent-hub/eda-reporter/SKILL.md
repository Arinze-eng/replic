---
name: eda-reporter
description: 输入 CSV/Excel 文件，自动完成数据画像、相关性分析、异常值检测，生成带交互图表的 HTML 报告和 Markdown 摘要。
---

# EDA Reporter

> 自动化探索性数据分析（EDA）技能。输入 CSV 或 Excel 文件，自动完成数据质量检测、分布分析、相关性计算、异常值识别，并生成带交互图表的 HTML 报告和 Markdown 摘要。

## 能力说明

- **数据加载**：支持 CSV（自动检测编码）和 Excel（.xlsx / .xls），自动推断列类型（数值、分类、日期时间）
- **数据画像**：缺失值比例、唯一值计数、分布统计（均值/标准差/偏度/峰度）、分类频率
- **相关性分析**：数值列间 Pearson/Spearman 相关矩阵，识别高度相关特征对
- **异常值检测**：IQR 和 Z-Score 双算法，按列输出异常值数量和样本
- **可视化报告**：基于 ECharts 的交互式 HTML 报告（直方图、热力图、箱线图），以及 Markdown 纯文本摘要

## 使用方式

### 基本用法

```
请对 /path/to/data.csv 进行探索性数据分析，生成报告
```

```
分析这份 Excel 数据：/data/sales_2024.xlsx，重点关注数值列的异常值
```

### 完整参数

```bash
python scripts/render.py <input_file> [options]

参数：
  input_file              输入文件路径（.csv 或 .xlsx/.xls）
  --output <dir>          报告输出目录（默认：与输入文件同目录）
  --format <html|md|both> 输出格式（默认：both）
  --config <yaml>         自定义阈值配置文件（默认：resources/thresholds.yaml）
  --title <str>           报告标题（默认：自动使用文件名）
  --sample <int>          大文件采样行数（默认：不采样）
  --corr-method <str>     相关系数方法 pearson|spearman（默认：pearson）
```

### 调用示例

```bash
# 生成完整 HTML + Markdown 报告
python scripts/render.py data/customers.csv --output reports/

# 仅生成 Markdown，适合在对话中展示
python scripts/render.py data/sales.xlsx --format md

# 大文件采样分析
python scripts/render.py data/logs_10m.csv --sample 50000 --format html

# 使用自定义异常检测阈值
python scripts/render.py data/metrics.csv --config my_thresholds.yaml
```

## 输出说明

### HTML 报告（report.html）

- 数据概览卡片（行数、列数、总缺失率、内存占用）
- 各列详细画像（含直方图或频率柱图）
- 相关性热力图（数值列）
- 异常值箱线图（含异常点高亮）
- 可交互，支持图表缩放和数据导出

### Markdown 摘要（report.md）

- 结构化文字描述，适合在对话窗口直接阅读
- 包含数据质量警告（缺失率 > 20%、高相关特征对、大量异常值）
- 附完整分析建议

## 依赖要求

### Python 包

```
pandas>=1.5.0
openpyxl>=3.0.0
numpy>=1.23.0
scipy>=1.9.0
scikit-learn>=1.1.0
jinja2>=3.1.0
pyyaml>=6.0
chardet>=5.0.0
```

安装：

```bash
pip install pandas openpyxl numpy scipy scikit-learn jinja2 pyyaml chardet
```

### 系统要求

- Python 3.8+
- 无需外部 API Key，完全本地运行

## 注意事项

- 纯数值列（如 ID 类）会被自动识别为分类列（唯一值比例 > 95%）
- 相关性分析要求至少 2 列数值列，否则跳过
- 超过 100 万行的文件建议使用 `--sample` 参数
- 日期时间列会自动解析，不参与数值统计，但会展示时间跨度信息
