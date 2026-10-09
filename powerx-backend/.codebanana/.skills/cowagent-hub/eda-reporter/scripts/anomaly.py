"""
anomaly.py — 异常值检测模块
对数值列使用 IQR 和 Z-Score 双算法检测异常值。
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd


def _iqr_bounds(series: pd.Series, multiplier: float = 1.5) -> tuple[float, float]:
    q1 = float(series.quantile(0.25))
    q3 = float(series.quantile(0.75))
    iqr = q3 - q1
    return q1 - multiplier * iqr, q3 + multiplier * iqr


def _zscore_mask(series: pd.Series, threshold: float = 3.0) -> pd.Series:
    mean = series.mean()
    std = series.std()
    if std == 0:
        return pd.Series([False] * len(series), index=series.index)
    return ((series - mean) / std).abs() > threshold


def detect_anomalies(
    df: pd.DataFrame,
    column_types: dict[str, str],
    iqr_multiplier: float = 1.5,
    zscore_threshold: float = 3.0,
    require_both: bool = False,
    anomaly_rate_warn: float = 0.05,
) -> dict[str, Any]:
    """
    对所有数值列检测异常值。

    返回：
      {
        "columns": {
          col: {
            "total": int,
            "anomaly_count": int,
            "anomaly_rate": float,
            "iqr_only": int,
            "zscore_only": int,
            "both": int,
            "bounds": {"iqr_lower": float, "iqr_upper": float},
            "boxplot_data": [min, Q1, median, Q3, max],
            "outlier_values": [float, ...],   # 最多 20 个样本
            "warning": bool,
          }
        },
        "warnings": [str, ...],   # 高异常率列的警告信息
        "summary": {
          "total_anomalies": int,
          "affected_columns": int,
        }
      }
    """
    numeric_cols = [c for c, t in column_types.items() if t == "numeric"]

    result_cols: dict[str, Any] = {}
    warnings: list[str] = []
    total_anomalies = 0
    affected_columns = 0

    for col in numeric_cols:
        series = df[col].dropna()
        n = len(series)

        if n < 4:
            result_cols[col] = {
                "total": n,
                "anomaly_count": 0,
                "anomaly_rate": 0.0,
                "skipped": True,
                "reason": "有效值不足 4 个",
            }
            continue

        # IQR 检测
        lower, upper = _iqr_bounds(series, iqr_multiplier)
        iqr_mask = (series < lower) | (series > upper)

        # Z-Score 检测
        zscore_mask = _zscore_mask(series, zscore_threshold)

        # 合并
        if require_both:
            anomaly_mask = iqr_mask & zscore_mask
        else:
            anomaly_mask = iqr_mask | zscore_mask

        iqr_only = int((iqr_mask & ~zscore_mask).sum())
        zscore_only = int((~iqr_mask & zscore_mask).sum())
        both = int((iqr_mask & zscore_mask).sum())
        anomaly_count = int(anomaly_mask.sum())
        anomaly_rate = round(anomaly_count / n, 4)

        # 箱线图数据（ECharts boxplot 格式）
        q1 = float(series.quantile(0.25))
        q3 = float(series.quantile(0.75))
        boxplot_data = [
            round(float(series.min()), 6),
            round(q1, 6),
            round(float(series.median()), 6),
            round(q3, 6),
            round(float(series.max()), 6),
        ]

        # 异常值样本（最多 20 个，按绝对偏差降序）
        outlier_series = series[anomaly_mask]
        mean_val = series.mean()
        outlier_sorted = outlier_series.reindex(
            (outlier_series - mean_val).abs().sort_values(ascending=False).index
        ).head(20)
        outlier_values = [round(float(v), 6) for v in outlier_sorted]

        has_warning = anomaly_rate >= anomaly_rate_warn
        if has_warning:
            warnings.append(
                f"列 '{col}' 异常率 {anomaly_rate:.1%}（{anomaly_count}/{n}），"
                f"建议检查数据来源"
            )

        result_cols[col] = {
            "total": n,
            "anomaly_count": anomaly_count,
            "anomaly_rate": anomaly_rate,
            "iqr_only": iqr_only,
            "zscore_only": zscore_only,
            "both": both,
            "bounds": {
                "iqr_lower": round(lower, 6),
                "iqr_upper": round(upper, 6),
                "zscore_lower": round(float(series.mean() - zscore_threshold * series.std()), 6),
                "zscore_upper": round(float(series.mean() + zscore_threshold * series.std()), 6),
            },
            "boxplot_data": boxplot_data,
            "outlier_values": outlier_values,
            "warning": has_warning,
        }

        if anomaly_count > 0:
            total_anomalies += anomaly_count
            affected_columns += 1

    return {
        "columns": result_cols,
        "warnings": warnings,
        "summary": {
            "total_anomalies": total_anomalies,
            "affected_columns": affected_columns,
            "numeric_columns_checked": len(numeric_cols),
        },
    }
