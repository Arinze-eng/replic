"""
profiler.py — 数据画像模块
计算每列的统计信息：缺失值、唯一值、分布统计、分类频率等。
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd
from scipy import stats


def _safe_float(v: Any) -> float | None:
    """将 numpy 标量安全转为 Python float，NaN/Inf 返回 None。"""
    try:
        f = float(v)
        return None if (math.isnan(f) or math.isinf(f)) else round(f, 6)
    except (TypeError, ValueError):
        return None


def profile_numeric(series: pd.Series, bins: int | str = "auto") -> dict[str, Any]:
    """对数值列生成统计画像。"""
    clean = series.dropna()
    n = len(clean)

    if n == 0:
        return {"count": 0, "missing": len(series), "missing_rate": 1.0}

    # 基础统计
    desc = clean.describe(percentiles=[0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99])

    # 偏度 & 峰度
    skewness = _safe_float(stats.skew(clean))
    kurtosis = _safe_float(stats.kurtosis(clean))  # excess kurtosis

    # 直方图数据
    if bins == "auto":
        n_bins = max(5, min(50, int(1 + 3.322 * math.log10(n))))  # Sturges
    else:
        n_bins = int(bins)

    counts, edges = np.histogram(clean, bins=n_bins)
    hist_labels = [f"{edges[i]:.4g}–{edges[i+1]:.4g}" for i in range(len(edges) - 1)]

    return {
        "type": "numeric",
        "count": int(clean.count()),
        "missing": int(series.isna().sum()),
        "missing_rate": round(series.isna().mean(), 4),
        "unique": int(clean.nunique()),
        "mean": _safe_float(desc["mean"]),
        "std": _safe_float(desc["std"]),
        "min": _safe_float(desc["min"]),
        "p1": _safe_float(desc["1%"]),
        "p5": _safe_float(desc["5%"]),
        "q1": _safe_float(desc["25%"]),
        "median": _safe_float(desc["50%"]),
        "q3": _safe_float(desc["75%"]),
        "p95": _safe_float(desc["95%"]),
        "p99": _safe_float(desc["99%"]),
        "max": _safe_float(desc["max"]),
        "skewness": skewness,
        "kurtosis": kurtosis,
        "zero_count": int((clean == 0).sum()),
        "negative_count": int((clean < 0).sum()),
        "histogram": {
            "labels": hist_labels,
            "counts": counts.tolist(),
        },
    }


def profile_categorical(series: pd.Series, top_n: int = 20) -> dict[str, Any]:
    """对分类列生成统计画像。"""
    n_missing = int(series.isna().sum())
    clean = series.dropna()
    n = len(clean)

    value_counts = clean.value_counts()
    top = value_counts.head(top_n)

    return {
        "type": "categorical",
        "count": n,
        "missing": n_missing,
        "missing_rate": round(series.isna().mean(), 4),
        "unique": int(clean.nunique()),
        "top_values": [
            {"value": str(k), "count": int(v), "rate": round(v / n, 4)}
            for k, v in top.items()
        ],
        "has_more": len(value_counts) > top_n,
    }


def profile_datetime(series: pd.Series) -> dict[str, Any]:
    """对日期时间列生成统计画像。"""
    n_missing = int(series.isna().sum())
    clean = series.dropna()

    if len(clean) == 0:
        return {"type": "datetime", "count": 0, "missing": n_missing}

    dt = pd.to_datetime(clean, errors="coerce").dropna()

    return {
        "type": "datetime",
        "count": len(dt),
        "missing": n_missing,
        "missing_rate": round(series.isna().mean(), 4),
        "min": str(dt.min()),
        "max": str(dt.max()),
        "span_days": int((dt.max() - dt.min()).days),
        "unique": int(dt.nunique()),
    }


def profile_text(series: pd.Series) -> dict[str, Any]:
    """对高基数文本列生成简要画像。"""
    n_missing = int(series.isna().sum())
    clean = series.dropna().astype(str)
    lengths = clean.str.len()

    return {
        "type": "text",
        "count": len(clean),
        "missing": n_missing,
        "missing_rate": round(series.isna().mean(), 4),
        "unique": int(clean.nunique()),
        "avg_length": _safe_float(lengths.mean()),
        "max_length": int(lengths.max()) if len(lengths) else 0,
        "min_length": int(lengths.min()) if len(lengths) else 0,
    }


def profile_dataframe(
    df: pd.DataFrame,
    column_types: dict[str, str],
    bins: int | str = "auto",
    top_n: int = 20,
) -> dict[str, Any]:
    """
    对整个 DataFrame 生成完整画像。

    返回：
      {
        "overview": {...},
        "columns": { col_name: {...stats...} }
      }
    """
    total_cells = df.shape[0] * df.shape[1]
    total_missing = int(df.isna().sum().sum())
    memory_mb = round(df.memory_usage(deep=True).sum() / 1024 / 1024, 2)

    # 各类型列数
    type_counts: dict[str, int] = {}
    for t in column_types.values():
        type_counts[t] = type_counts.get(t, 0) + 1

    overview = {
        "rows": df.shape[0],
        "cols": df.shape[1],
        "total_cells": total_cells,
        "total_missing": total_missing,
        "missing_rate": round(total_missing / total_cells, 4) if total_cells else 0,
        "memory_mb": memory_mb,
        "column_type_counts": type_counts,
        "duplicate_rows": int(df.duplicated().sum()),
    }

    columns: dict[str, Any] = {}
    for col in df.columns:
        col_type = column_types.get(col, "categorical")
        if col_type == "numeric":
            columns[col] = profile_numeric(df[col], bins=bins)
        elif col_type == "datetime":
            columns[col] = profile_datetime(df[col])
        elif col_type == "text":
            columns[col] = profile_text(df[col])
        else:
            columns[col] = profile_categorical(df[col], top_n=top_n)

    return {"overview": overview, "columns": columns}
