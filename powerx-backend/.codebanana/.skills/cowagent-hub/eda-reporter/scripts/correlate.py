"""
correlate.py — 相关性分析模块
计算数值列间相关矩阵，识别强相关特征对。
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
from scipy import stats


def compute_correlation(
    df: pd.DataFrame,
    column_types: dict[str, str],
    method: str = "pearson",
    strong_threshold: float = 0.80,
    multicollinearity_threshold: float = 0.95,
    max_columns: int = 30,
) -> dict[str, Any]:
    """
    计算数值列间相关矩阵。

    返回：
      {
        "columns": [...],
        "matrix": [[...], ...],      # 行列均为 columns
        "strong_pairs": [...],        # |r| >= strong_threshold 的列对
        "multicollinear_pairs": [...],# |r| >= multicollinearity_threshold
        "method": "pearson"|"spearman",
        "skipped": bool,              # 数值列不足时为 True
      }
    """
    numeric_cols = [c for c, t in column_types.items() if t == "numeric"]

    if len(numeric_cols) < 2:
        return {
            "skipped": True,
            "reason": f"数值列不足（仅有 {len(numeric_cols)} 列），至少需要 2 列",
            "columns": [],
            "matrix": [],
            "strong_pairs": [],
            "multicollinear_pairs": [],
            "method": method,
        }

    # 列数过多时截取前 max_columns 列（按方差降序）
    if len(numeric_cols) > max_columns:
        variances = df[numeric_cols].var().sort_values(ascending=False)
        numeric_cols = variances.index[:max_columns].tolist()

    sub = df[numeric_cols].copy()

    if method == "spearman":
        corr_matrix = sub.rank().corr(method="pearson")
    else:
        corr_matrix = sub.corr(method="pearson")

    # 将 NaN 替换为 0（列方差为零时会出现）
    corr_matrix = corr_matrix.fillna(0)

    # 提取强相关对（上三角，排除对角线）
    strong_pairs: list[dict[str, Any]] = []
    multicollinear_pairs: list[dict[str, Any]] = []

    n = len(numeric_cols)
    for i in range(n):
        for j in range(i + 1, n):
            r = float(corr_matrix.iloc[i, j])
            abs_r = abs(r)
            if abs_r >= strong_threshold:
                pair = {
                    "col_a": numeric_cols[i],
                    "col_b": numeric_cols[j],
                    "r": round(r, 4),
                    "abs_r": round(abs_r, 4),
                }
                strong_pairs.append(pair)
                if abs_r >= multicollinearity_threshold:
                    multicollinear_pairs.append(pair)

    # 按相关系数绝对值降序
    strong_pairs.sort(key=lambda x: x["abs_r"], reverse=True)
    multicollinear_pairs.sort(key=lambda x: x["abs_r"], reverse=True)

    # 矩阵数据（用于热力图）
    # ECharts heatmap 格式：[[col_i, col_j, value], ...]
    heatmap_data: list[list] = []
    for i, ci in enumerate(numeric_cols):
        for j, cj in enumerate(numeric_cols):
            heatmap_data.append([ci, cj, round(float(corr_matrix.loc[ci, cj]), 4)])

    return {
        "skipped": False,
        "columns": numeric_cols,
        "matrix": corr_matrix.round(4).values.tolist(),
        "heatmap_data": heatmap_data,
        "strong_pairs": strong_pairs,
        "multicollinear_pairs": multicollinear_pairs,
        "method": method,
        "truncated": len([c for c, t in column_types.items() if t == "numeric"]) > max_columns,
    }
