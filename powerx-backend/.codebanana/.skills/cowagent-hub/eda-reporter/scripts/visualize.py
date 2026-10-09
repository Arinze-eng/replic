"""
visualize.py — 图表数据生成模块
将 profile/correlate/anomaly 分析结果转换为 ECharts 配置对象。
读取 resources/chart_configs/ 中的基础配置并合并实际数据。
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any


# resources/chart_configs/ 目录（相对于本脚本的两级父目录）
_CHART_CONFIG_DIR = Path(__file__).parent.parent / "resources" / "chart_configs"


def _load_base_config(name: str) -> dict:
    path = _CHART_CONFIG_DIR / f"{name}.json"
    if path.exists():
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return {}


def _deep_merge(base: dict, override: dict) -> dict:
    """递归合并两个字典，override 优先。"""
    result = copy.deepcopy(base)
    for k, v in override.items():
        if k in result and isinstance(result[k], dict) and isinstance(v, dict):
            result[k] = _deep_merge(result[k], v)
        else:
            result[k] = v
    return result


# ── 直方图 ────────────────────────────────────────────────

def build_histogram(col: str, profile: dict, height: int = 350) -> dict[str, Any]:
    """为单个数值列生成直方图 ECharts 配置。"""
    hist = profile.get("histogram", {})
    labels = hist.get("labels", [])
    counts = hist.get("counts", [])

    base = _load_base_config("histogram")
    override = {
        "title": {"text": col, "textStyle": {"fontSize": 13, "fontWeight": "normal"}},
        "xAxis": {"data": labels},
        "series": [{"data": counts}],
    }
    config = _deep_merge(base, override)
    config["_height"] = height
    config["_col"] = col
    config["_chart_type"] = "histogram"
    return config


# ── 相关性热力图 ──────────────────────────────────────────

def build_heatmap(corr_result: dict, height: int = 500) -> dict[str, Any] | None:
    """生成相关性热力图 ECharts 配置。"""
    if corr_result.get("skipped"):
        return None

    columns = corr_result["columns"]
    heatmap_data = corr_result["heatmap_data"]  # [[col_i, col_j, r], ...]

    base = _load_base_config("heatmap")
    override = {
        "title": {
            "text": "特征相关性矩阵",
            "subtext": f"方法: {corr_result.get('method', 'pearson')}",
            "textStyle": {"fontSize": 14},
        },
        "xAxis": {"data": columns},
        "yAxis": {"data": columns},
        "series": [{"data": heatmap_data}],
    }

    # 自适应高度（列数多时增大）
    n = len(columns)
    adaptive_height = max(height, n * 28 + 150)

    config = _deep_merge(base, override)
    config["_height"] = adaptive_height
    config["_chart_type"] = "heatmap"
    return config


# ── 箱线图 ────────────────────────────────────────────────

def build_boxplot(anomaly_result: dict, max_cols: int = 15, height: int = 380) -> dict[str, Any] | None:
    """为所有数值列生成箱线图（含异常点散点）ECharts 配置。"""
    col_data = anomaly_result.get("columns", {})
    valid = {c: v for c, v in col_data.items() if not v.get("skipped") and "boxplot_data" in v}

    if not valid:
        return None

    # 列数过多时只取异常值最多的前 N 列
    if len(valid) > max_cols:
        valid = dict(
            sorted(valid.items(), key=lambda x: x[1].get("anomaly_count", 0), reverse=True)[:max_cols]
        )

    col_names = list(valid.keys())
    box_series_data = [v["boxplot_data"] for v in valid.values()]

    # 散点数据：[[col_index, value], ...]
    scatter_data: list[list] = []
    for i, (col, v) in enumerate(valid.items()):
        for ov in v.get("outlier_values", []):
            scatter_data.append([i, ov])

    base = _load_base_config("boxplot")
    override = {
        "title": {
            "text": "异常值分布（箱线图）",
            "subtext": f"共 {len(col_names)} 列，红点为异常值",
            "textStyle": {"fontSize": 14},
        },
        "xAxis": {"data": col_names},
        "series": [
            {"data": box_series_data},
            {"data": scatter_data},
        ],
    }
    config = _deep_merge(base, override)
    config["_height"] = height
    config["_chart_type"] = "boxplot"
    return config


# ── 分类频率柱图 ──────────────────────────────────────────

def build_bar_categorical(col: str, profile: dict, top_n: int = 15, height: int = 320) -> dict[str, Any]:
    """为分类列生成频率柱图 ECharts 配置。"""
    top_values = profile.get("top_values", [])[:top_n]
    labels = [str(v["value"]) for v in top_values]
    counts = [v["count"] for v in top_values]

    config = {
        "_chart_type": "bar_categorical",
        "_col": col,
        "_height": height,
        "title": {"text": col, "textStyle": {"fontSize": 13, "fontWeight": "normal"}},
        "tooltip": {"trigger": "axis", "axisPointer": {"type": "shadow"}},
        "grid": {"left": "5%", "right": "5%", "top": "18%", "bottom": "15%", "containLabel": True},
        "xAxis": {
            "type": "category",
            "data": labels,
            "axisLabel": {"rotate": 30, "fontSize": 11, "overflow": "truncate", "width": 80},
        },
        "yAxis": {
            "type": "value",
            "name": "频次",
            "splitLine": {"lineStyle": {"type": "dashed", "color": "#e0e0e0"}},
        },
        "series": [
            {
                "type": "bar",
                "data": counts,
                "barMaxWidth": 40,
                "itemStyle": {
                    "color": "#5b8ff9",
                    "borderRadius": [3, 3, 0, 0],
                },
            }
        ],
    }
    return config


# ── 主函数：生成所有图表配置 ──────────────────────────────

def build_all_charts(
    profile_result: dict,
    corr_result: dict,
    anomaly_result: dict,
    chart_height: int = 350,
    max_boxplot_cols: int = 15,
) -> dict[str, Any]:
    """
    汇总生成所有图表配置。

    返回：
      {
        "column_charts": { col: echarts_config },   # 每列一个图
        "heatmap": echarts_config | None,
        "boxplot": echarts_config | None,
      }
    """
    column_charts: dict[str, Any] = {}
    columns_profile = profile_result.get("columns", {})

    for col, prof in columns_profile.items():
        col_type = prof.get("type")
        if col_type == "numeric":
            column_charts[col] = build_histogram(col, prof, height=chart_height)
        elif col_type == "categorical":
            if prof.get("top_values"):
                column_charts[col] = build_bar_categorical(col, prof, height=chart_height)

    heatmap = build_heatmap(corr_result, height=max(500, len(corr_result.get("columns", [])) * 28 + 150))
    boxplot = build_boxplot(anomaly_result, max_cols=max_boxplot_cols, height=chart_height + 30)

    return {
        "column_charts": column_charts,
        "heatmap": heatmap,
        "boxplot": boxplot,
    }
