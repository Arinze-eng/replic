"""
render.py — 主入口：编排所有分析步骤，生成 HTML + Markdown 报告。

用法：
  python render.py <input_file> [--output <dir>] [--format html|md|both]
                   [--config <yaml>] [--title <str>] [--sample <int>]
                   [--corr-method pearson|spearman]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

import yaml
from jinja2 import Environment, FileSystemLoader

# 将 scripts/ 目录加入 path，支持直接运行
sys.path.insert(0, str(Path(__file__).parent))

from anomaly import detect_anomalies
from correlate import compute_correlation
from loader import load_file
from profiler import profile_dataframe
from visualize import build_all_charts


# ── 配置加载 ──────────────────────────────────────────────

def _load_config(config_path: str | None) -> dict:
    default_path = Path(__file__).parent.parent / "resources" / "thresholds.yaml"
    path = Path(config_path) if config_path else default_path
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _get(cfg: dict, *keys: str, default=None):
    """安全读取嵌套配置。"""
    v = cfg
    for k in keys:
        if not isinstance(v, dict):
            return default
        v = v.get(k, default)
    return v


# ── Markdown 报告生成 ─────────────────────────────────────

def _fmt_rate(r: float) -> str:
    return f"{r * 100:.1f}%"


def _quality_badge(rate: float, warn: float, critical: float) -> str:
    if rate >= critical:
        return "严重缺失"
    if rate >= warn:
        return "高缺失"
    return "正常"


def build_markdown(
    metadata: dict,
    profile_result: dict,
    corr_result: dict,
    anomaly_result: dict,
    config: dict,
    title: str,
) -> str:
    miss_warn = _get(config, "data_quality", "missing_rate_warn", default=0.2)
    miss_crit = _get(config, "data_quality", "missing_rate_critical", default=0.5)
    skew_warn = _get(config, "distribution", "skewness_warn", default=1.0)
    kurt_warn = _get(config, "distribution", "kurtosis_warn", default=3.0)
    anomaly_warn = _get(config, "anomaly", "anomaly_rate_warn", default=0.05)
    strong_thr = _get(config, "correlation", "strong_threshold", default=0.8)

    ov = profile_result["overview"]
    lines: list[str] = []

    lines.append(f"# {title}\n")
    lines.append(f"> 生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  ")
    lines.append(f"> 文件：`{metadata['file_name']}` ({metadata['file_size_mb']} MB)\n")

    # 概览
    lines.append("## 数据概览\n")
    lines.append(f"| 指标 | 值 |")
    lines.append(f"|------|----|")
    lines.append(f"| 行数 | {ov['rows']:,} |")
    lines.append(f"| 列数 | {ov['cols']} |")
    lines.append(f"| 重复行 | {ov['duplicate_rows']:,} ({_fmt_rate(ov['duplicate_rows'] / max(ov['rows'], 1))}) |")
    lines.append(f"| 总缺失率 | {_fmt_rate(ov['missing_rate'])} |")
    lines.append(f"| 内存占用 | {ov['memory_mb']} MB |")
    if metadata.get("sampled"):
        lines.append(f"| 采样 | 是（{metadata['sampled_rows']:,} 行，原始 {metadata['total_rows']:,} 行）|")
    lines.append("")

    type_counts = ov.get("column_type_counts", {})
    type_str = "、".join(f"{t}列 {n} 个" for t, n in type_counts.items())
    lines.append(f"列类型分布：{type_str}\n")

    # 数据质量警告
    quality_warnings: list[str] = []
    for col, prof in profile_result["columns"].items():
        r = prof.get("missing_rate", 0)
        if r >= miss_warn:
            badge = _quality_badge(r, miss_warn, miss_crit)
            quality_warnings.append(f"- **{col}**：缺失率 {_fmt_rate(r)}（{badge}）")
    if quality_warnings:
        lines.append("### 数据质量警告\n")
        lines.extend(quality_warnings)
        lines.append("")

    # 各列摘要
    lines.append("## 各列分析\n")
    for col, prof in profile_result["columns"].items():
        col_type = prof.get("type", "unknown")
        lines.append(f"### `{col}` ({col_type})\n")

        miss_r = prof.get("missing_rate", 0)
        lines.append(f"- 有效值：{prof.get('count', 0):,}，缺失：{prof.get('missing', 0):,}（{_fmt_rate(miss_r)}）")

        if col_type == "numeric":
            lines.append(f"- 均值：{prof.get('mean')}，标准差：{prof.get('std')}")
            lines.append(f"- 范围：[{prof.get('min')} ~ {prof.get('max')}]，中位数：{prof.get('median')}")
            skew = prof.get("skewness")
            kurt = prof.get("kurtosis")
            flags = []
            if skew is not None and abs(skew) > skew_warn:
                flags.append(f"高偏态（偏度={skew:.2f}）")
            if kurt is not None and abs(kurt) > kurt_warn:
                flags.append(f"厚尾（峰度={kurt:.2f}）")
            if flags:
                lines.append(f"- 分布特征：{'，'.join(flags)}")
            # 异常值信息
            anom = anomaly_result["columns"].get(col, {})
            if not anom.get("skipped") and anom.get("anomaly_count", 0) > 0:
                lines.append(
                    f"- 异常值：{anom['anomaly_count']} 个（{_fmt_rate(anom['anomaly_rate'])}），"
                    f"IQR 区间 [{anom['bounds']['iqr_lower']:.4g}, {anom['bounds']['iqr_upper']:.4g}]"
                )

        elif col_type == "categorical":
            lines.append(f"- 唯一值：{prof.get('unique', 0)}")
            top = prof.get("top_values", [])[:5]
            if top:
                top_str = "、".join(f"{v['value']}({v['count']})" for v in top)
                lines.append(f"- 前 5 值：{top_str}")

        elif col_type == "datetime":
            lines.append(f"- 时间跨度：{prof.get('min')} ~ {prof.get('max')}（{prof.get('span_days', 0)} 天）")

        lines.append("")

    # 相关性
    lines.append("## 相关性分析\n")
    if corr_result.get("skipped"):
        lines.append(f"> {corr_result.get('reason')}\n")
    else:
        method = corr_result.get("method", "pearson")
        lines.append(f"使用 **{method}** 相关系数，分析 {len(corr_result['columns'])} 个数值列。\n")
        strong = corr_result.get("strong_pairs", [])
        if strong:
            lines.append(f"### 强相关特征对（|r| ≥ {strong_thr}）\n")
            for p in strong[:10]:
                lines.append(f"- `{p['col_a']}` × `{p['col_b']}`：r = **{p['r']}**")
            lines.append("")
        mc = corr_result.get("multicollinear_pairs", [])
        if mc:
            lines.append("### 多重共线性警告\n")
            for p in mc:
                lines.append(f"- `{p['col_a']}` 与 `{p['col_b']}` 高度相关（r = {p['r']}），建议检查是否冗余特征")
            lines.append("")

    # 异常值汇总
    lines.append("## 异常值汇总\n")
    asum = anomaly_result.get("summary", {})
    lines.append(f"- 检测列数：{asum.get('numeric_columns_checked', 0)}")
    lines.append(f"- 受影响列：{asum.get('affected_columns', 0)}")
    lines.append(f"- 异常值总计：{asum.get('total_anomalies', 0):,}\n")

    for w in anomaly_result.get("warnings", []):
        lines.append(f"> **警告**：{w}")
    if anomaly_result.get("warnings"):
        lines.append("")

    # 分析建议
    lines.append("## 分析建议\n")
    suggestions: list[str] = []

    if ov["missing_rate"] > miss_warn:
        suggestions.append("整体缺失率较高，建议优先处理缺失值（填充或删除）。")
    if ov["duplicate_rows"] > 0:
        suggestions.append(f"存在 {ov['duplicate_rows']:,} 条重复行，建议去重后再建模。")
    if corr_result.get("multicollinear_pairs"):
        suggestions.append("存在高度相关特征，建议使用 PCA 降维或人工筛选冗余列。")
    if anomaly_result["summary"]["affected_columns"] > 0:
        suggestions.append("存在异常值，建议结合业务背景决定是否 Winsorize 或删除。")

    if suggestions:
        for s in suggestions:
            lines.append(f"- {s}")
    else:
        lines.append("- 数据整体质量良好，可直接用于建模分析。")
    lines.append("")

    return "\n".join(lines)


# ── HTML 报告生成 ─────────────────────────────────────────

def build_html(
    metadata: dict,
    profile_result: dict,
    corr_result: dict,
    anomaly_result: dict,
    charts: dict,
    config: dict,
    title: str,
) -> str:
    template_path = Path(__file__).parent.parent / "resources" / "report_template.html"
    env = Environment(
        loader=FileSystemLoader(str(template_path.parent)),
        autoescape=False,
    )

    def to_json(v: Any) -> str:
        return json.dumps(v, ensure_ascii=False)

    env.filters["tojson"] = to_json

    template = env.get_template(template_path.name)
    return template.render(
        title=title,
        generated_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        metadata=metadata,
        profile=profile_result,
        corr=corr_result,
        anomaly=anomaly_result,
        charts=charts,
        config=config,
    )


# ── 主流程 ───────────────────────────────────────────────

def run(
    input_file: str,
    output_dir: str | None = None,
    fmt: str = "both",
    config_path: str | None = None,
    title: str | None = None,
    sample: int | None = None,
    corr_method: str = "pearson",
) -> dict[str, str]:
    """
    执行完整 EDA 流程，返回 {"html": path, "md": path} 中已生成的项。
    """
    cfg = _load_config(config_path)

    # 1. 加载数据
    print(f"[1/5] 加载文件: {input_file}")
    id_ratio = _get(cfg, "data_quality", "id_column_unique_ratio", default=0.95)
    df, metadata = load_file(input_file, sample=sample, id_unique_ratio=id_ratio)
    print(f"      {metadata['sampled_rows']:,} 行 × {metadata['total_cols']} 列")

    report_title = title or Path(input_file).stem
    out_dir = Path(output_dir) if output_dir else Path(input_file).parent
    out_dir.mkdir(parents=True, exist_ok=True)

    # 2. 数据画像
    print("[2/5] 数据画像...")
    bins = _get(cfg, "distribution", "histogram_bins", default="auto")
    top_n = _get(cfg, "data_quality", "categorical_top_n", default=20)
    profile_result = profile_dataframe(df, metadata["column_types"], bins=bins, top_n=top_n)

    # 3. 相关性分析
    print("[3/5] 相关性分析...")
    corr_result = compute_correlation(
        df,
        metadata["column_types"],
        method=corr_method,
        strong_threshold=_get(cfg, "correlation", "strong_threshold", default=0.80),
        multicollinearity_threshold=_get(cfg, "correlation", "multicollinearity_threshold", default=0.95),
        max_columns=_get(cfg, "correlation", "heatmap_max_columns", default=30),
    )

    # 4. 异常值检测
    print("[4/5] 异常值检测...")
    anomaly_result = detect_anomalies(
        df,
        metadata["column_types"],
        iqr_multiplier=_get(cfg, "anomaly", "iqr_multiplier", default=1.5),
        zscore_threshold=_get(cfg, "anomaly", "zscore_threshold", default=3.0),
        require_both=_get(cfg, "anomaly", "require_both_methods", default=False),
        anomaly_rate_warn=_get(cfg, "anomaly", "anomaly_rate_warn", default=0.05),
    )

    # 5. 生成报告
    print("[5/5] 生成报告...")
    charts = build_all_charts(
        profile_result,
        corr_result,
        anomaly_result,
        chart_height=_get(cfg, "report", "chart_height", default=350),
    )

    output_files: dict[str, str] = {}
    base_name = Path(input_file).stem

    if fmt in ("md", "both"):
        md_content = build_markdown(metadata, profile_result, corr_result, anomaly_result, cfg, report_title)
        md_path = out_dir / f"{base_name}_eda_report.md"
        md_path.write_text(md_content, encoding="utf-8")
        output_files["md"] = str(md_path)
        print(f"      Markdown → {md_path}")

    if fmt in ("html", "both"):
        html_content = build_html(metadata, profile_result, corr_result, anomaly_result, charts, cfg, report_title)
        html_path = out_dir / f"{base_name}_eda_report.html"
        html_path.write_text(html_content, encoding="utf-8")
        output_files["html"] = str(html_path)
        print(f"      HTML    → {html_path}")

    print("\n✓ 分析完成")
    return output_files


# ── CLI ──────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="EDA Reporter — 自动探索性数据分析报告生成器")
    parser.add_argument("input_file", help="输入文件路径（.csv / .xlsx / .xls）")
    parser.add_argument("--output", "-o", default=None, help="报告输出目录（默认：与输入文件同目录）")
    parser.add_argument("--format", "-f", choices=["html", "md", "both"], default="both", dest="fmt")
    parser.add_argument("--config", "-c", default=None, help="thresholds.yaml 路径")
    parser.add_argument("--title", "-t", default=None, help="报告标题")
    parser.add_argument("--sample", "-s", type=int, default=None, help="大文件采样行数")
    parser.add_argument("--corr-method", choices=["pearson", "spearman"], default="pearson")

    args = parser.parse_args()
    result = run(
        input_file=args.input_file,
        output_dir=args.output,
        fmt=args.fmt,
        config_path=args.config,
        title=args.title,
        sample=args.sample,
        corr_method=args.corr_method,
    )
    for k, v in result.items():
        print(f"{k.upper()}: {v}")


if __name__ == "__main__":
    main()
