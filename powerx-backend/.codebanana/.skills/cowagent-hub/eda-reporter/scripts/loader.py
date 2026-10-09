"""
loader.py — 数据加载模块
支持 CSV（自动检测编码）和 Excel，自动推断列类型。
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

import chardet
import numpy as np
import pandas as pd


# 常见空值字符串
_NULL_VALUES = {"", "null", "NULL", "None", "none", "NA", "na", "N/A", "n/a",
                "NaN", "nan", "#N/A", "#NA", "-", "--", "?"}

# 唯一值比例超过此值时视为 ID 列（分类）
_ID_UNIQUE_RATIO = 0.95


def _detect_encoding(path: str) -> str:
    with open(path, "rb") as f:
        raw = f.read(min(os.path.getsize(path), 100_000))
    result = chardet.detect(raw)
    encoding = result.get("encoding") or "utf-8"
    # 常见别名统一
    return {"GB2312": "gbk", "GBK": "gbk"}.get(encoding.upper(), encoding)


def _infer_column_type(series: pd.Series, id_unique_ratio: float = _ID_UNIQUE_RATIO) -> str:
    """推断列的语义类型：numeric / categorical / datetime / text。"""
    if series.dtype == "bool":
        return "categorical"

    # 尝试解析日期时间
    if series.dtype == object:
        sample = series.dropna().head(200)
        try:
            parsed = pd.to_datetime(sample, infer_datetime_format=True, errors="coerce")
            if parsed.notna().mean() > 0.8:
                return "datetime"
        except Exception:
            pass

    if pd.api.types.is_numeric_dtype(series):
        # 唯一值极高 → ID 类分类列
        n_unique = series.nunique()
        n_total = series.count()
        if n_total > 0 and (n_unique / n_total) >= id_unique_ratio and n_unique > 50:
            return "categorical"
        return "numeric"

    # object / string
    n_unique = series.nunique()
    n_total = series.count()
    if n_total > 0 and (n_unique / n_total) >= id_unique_ratio and n_unique > 50:
        return "text"
    return "categorical"


def load_file(
    path: str,
    sample: int | None = None,
    id_unique_ratio: float = _ID_UNIQUE_RATIO,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """
    加载 CSV 或 Excel 文件，返回 (DataFrame, metadata)。

    metadata 包含：
      - file_name, file_size_mb, total_rows, total_cols
      - encoding（CSV 专用）
      - column_types: {col: "numeric"|"categorical"|"datetime"|"text"}
      - sampled: bool
    """
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"文件不存在: {path}")

    suffix = p.suffix.lower()
    file_size_mb = round(p.stat().st_size / 1024 / 1024, 2)
    encoding = None

    if suffix == ".csv":
        encoding = _detect_encoding(path)
        df = pd.read_csv(
            path,
            encoding=encoding,
            na_values=list(_NULL_VALUES),
            keep_default_na=True,
            low_memory=False,
        )
    elif suffix in (".xlsx", ".xls"):
        df = pd.read_excel(path, na_values=list(_NULL_VALUES))
    else:
        raise ValueError(f"不支持的文件格式: {suffix}（仅支持 .csv / .xlsx / .xls）")

    total_rows = len(df)

    # 列名清洗：去除首尾空格
    df.columns = [str(c).strip() for c in df.columns]

    # 采样
    sampled = False
    if sample and len(df) > sample:
        df = df.sample(n=sample, random_state=42).reset_index(drop=True)
        sampled = True

    # 尝试将 object 列转为数值
    for col in df.select_dtypes(include="object").columns:
        converted = pd.to_numeric(df[col], errors="coerce")
        if converted.notna().sum() / max(df[col].count(), 1) > 0.9:
            df[col] = converted

    # 尝试解析日期时间列
    for col in df.select_dtypes(include="object").columns:
        try:
            parsed = pd.to_datetime(df[col], infer_datetime_format=True, errors="coerce")
            if parsed.notna().mean() > 0.8:
                df[col] = parsed
        except Exception:
            pass

    # 推断列类型
    column_types: dict[str, str] = {}
    for col in df.columns:
        column_types[col] = _infer_column_type(df[col], id_unique_ratio)

    metadata: dict[str, Any] = {
        "file_name": p.name,
        "file_path": str(p.resolve()),
        "file_size_mb": file_size_mb,
        "total_rows": total_rows,
        "sampled_rows": len(df),
        "total_cols": len(df.columns),
        "encoding": encoding,
        "sampled": sampled,
        "column_types": column_types,
        "columns": list(df.columns),
    }

    return df, metadata


# ── CLI 入口（供独立调试） ───────────────────────────────────
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python loader.py <file_path> [sample_rows]")
        sys.exit(1)

    _path = sys.argv[1]
    _sample = int(sys.argv[2]) if len(sys.argv) > 2 else None
    _df, _meta = load_file(_path, sample=_sample)

    print(json.dumps(_meta, ensure_ascii=False, indent=2))
    print(f"\n前 3 行预览：\n{_df.head(3).to_string()}")
