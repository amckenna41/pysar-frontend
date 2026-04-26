"""
Unit tests for all pure Python helper functions in backend/main.py.

These functions are stateless — they accept plain Python/Pandas objects and return
dicts or values. No mocking of external services is required.

Coverage:
  _read_dataset           — file format parsing (CSV, TSV, TXT auto-detect)
  _sequence_length_stats  — min/max/mean length + distribution histogram
  _validate_sequences     — amino acid character validation
  _activity_histogram     — binned histogram for numeric activity series
  _length_histogram       — binned histogram for integer length lists
  _detect_duplicates      — duplicate sequence detection
  _check_missing          — missing value detection across seq + act columns
  _detect_outliers        — 3-sigma outlier detection
  _col_guess_confidence   — confidence tier for auto-guessed column assignments
  _build_config           — EncodeRequest → pySAR JSON config dict assembly
  _estimate_total_models  — model count estimation for all three encoding strategies
"""
import math
import textwrap
from pathlib import Path

import pandas as pd
import pytest

from backend.main import (
    EncodeRequest,
    UPLOAD_DIR,
    _activity_histogram,
    _build_config,
    _check_missing,
    _col_guess_confidence,
    _detect_duplicates,
    _detect_outliers,
    _estimate_total_models,
    _length_histogram,
    _read_dataset,
    _sequence_length_stats,
    _validate_sequences,
)


# ── helpers ────────────────────────────────────────────────────────────────────

def _write(tmp_path: Path, name: str, content: str) -> Path:
    p = tmp_path / name
    p.write_text(content)
    return p


def _df(*rows) -> pd.DataFrame:
    return pd.DataFrame(list(rows))


def _enc_req(**kwargs) -> EncodeRequest:
    """Minimal valid EncodeRequest with overrides applied."""
    defaults = dict(
        # Use a path inside UPLOAD_DIR so the path traversal validator passes
        file_path=str(UPLOAD_DIR / "test.csv"),
        sequence_col="sequence",
        activity_col="T50",
        strategy="aai",
    )
    defaults.update(kwargs)
    return EncodeRequest(**defaults)


# ──────────────────────────────────────────────────────────────────────────────
# _read_dataset
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.unit
class TestReadDataset:
    """_read_dataset detects CSV, TSV, and whitespace-delimited .txt files."""

    def test_reads_csv_with_comma_delimiter(self, tmp_path):
        p = _write(tmp_path, "data.csv", "sequence,T50\nACDE,55.0\nFGHI,61.3\n")
        df = _read_dataset(str(p))
        assert list(df.columns) == ["sequence", "T50"]
        assert len(df) == 2
        assert df.iloc[0]["sequence"] == "ACDE"
        assert float(df.iloc[1]["T50"]) == pytest.approx(61.3)

    def test_reads_tsv_with_tab_delimiter(self, tmp_path):
        p = _write(tmp_path, "data.tsv", "sequence\tT50\nACDE\t55.0\nFGHI\t61.3\n")
        df = _read_dataset(str(p))
        assert "sequence" in df.columns
        assert "T50" in df.columns
        assert len(df) == 2

    def test_reads_txt_as_tab_delimited(self, tmp_path):
        p = _write(tmp_path, "data.txt", "sequence\tT50\nACDE\t55.0\nFGHI\t61.3\n")
        df = _read_dataset(str(p))
        assert len(df.columns) == 2
        assert len(df) == 2

    def test_txt_falls_back_to_csv_when_tab_gives_single_column(self, tmp_path):
        # When the TSV parse yields 1 column, the function retries with comma
        p = _write(tmp_path, "data.txt", "sequence,T50\nACDE,55.0\nFGHI,61.3\n")
        df = _read_dataset(str(p))
        assert "sequence" in df.columns
        assert "T50" in df.columns

    def test_raises_for_nonexistent_file(self):
        with pytest.raises(Exception):
            _read_dataset("/does/not/exist/data.csv")

    def test_preserves_all_rows(self, tmp_path):
        lines = "\n".join([f"SEQ{i},{i * 0.1:.1f}" for i in range(50)])
        p = _write(tmp_path, "big.csv", f"sequence,T50\n{lines}\n")
        df = _read_dataset(str(p))
        assert len(df) == 50


# ──────────────────────────────────────────────────────────────────────────────
# _sequence_length_stats
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.unit
class TestSequenceLengthStats:
    """_sequence_length_stats returns correct aggregates and a length distribution."""

    def test_basic_stats(self):
        df = _df(
            {"sequence": "ACDE",       "T50": 55.0},   # len 4
            {"sequence": "ACDEFGHI",   "T50": 60.0},   # len 8
            {"sequence": "ACDEFGHIKL", "T50": 50.0},   # len 10
        )
        s = _sequence_length_stats(df, "sequence")
        assert s["min"] == 4
        assert s["max"] == 10
        assert s["mean"] == 7.3  # _sequence_length_stats rounds mean to 1 decimal
        assert "distribution" in s
        assert isinstance(s["distribution"], list)

    def test_missing_column_returns_zeros(self):
        df = _df({"T50": 55.0})
        s = _sequence_length_stats(df, "sequence")
        assert s == {"min": 0, "max": 0, "mean": 0}

    def test_empty_column_returns_zeros(self):
        df = pd.DataFrame({"sequence": pd.Series([], dtype=str), "T50": []})
        s = _sequence_length_stats(df, "sequence")
        assert s == {"min": 0, "max": 0, "mean": 0}

    def test_single_row(self):
        df = _df({"sequence": "ACDE", "T50": 55.0})
        s = _sequence_length_stats(df, "sequence")
        assert s["min"] == 4
        assert s["max"] == 4
        assert s["mean"] == pytest.approx(4.0)

    def test_null_rows_excluded_from_stats(self):
        df = pd.DataFrame({"sequence": ["ACDE", None], "T50": [55.0, 60.0]})
        s = _sequence_length_stats(df, "sequence")
        # Only the non-null row counted
        assert s["min"] == s["max"] == 4


# ──────────────────────────────────────────────────────────────────────────────
# _validate_sequences
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.unit
class TestValidateSequences:
    """_validate_sequences flags non-standard amino acid characters."""

    def test_all_standard_uppercase(self):
        df = _df({"sequence": "ACDEFGHIKLMNPQRSTVWY", "T50": 55.0})
        r = _validate_sequences(df, "sequence")
        assert r["valid"] is True
        assert r["invalid_count"] == 0
        assert r["warnings"] == []
        assert r["invalid_rows"] == []

    def test_lowercase_standard_aa_are_valid(self):
        df = _df({"sequence": "acdefghiklmnpqrstvwy", "T50": 55.0})
        r = _validate_sequences(df, "sequence")
        assert r["valid"] is True

    def test_ambiguous_aa_codes_accepted(self):
        # B (Asp/Asn), Z (Glu/Gln), X (unknown), U (Sec), O (Pyl) are all in VALID_AA
        df = _df({"sequence": "ACBZXUOJ", "T50": 55.0})
        r = _validate_sequences(df, "sequence")
        assert r["valid"] is True

    def test_digits_are_invalid(self):
        df = _df({"sequence": "ACE123FG", "T50": 55.0})
        r = _validate_sequences(df, "sequence")
        assert r["valid"] is False
        assert r["invalid_count"] == 1
        assert len(r["warnings"]) == 1

    def test_special_chars_are_invalid(self):
        df = _df(
            {"sequence": "ACDE", "T50": 55.0},
            {"sequence": "AC-DE", "T50": 60.0},   # hyphen is invalid
        )
        r = _validate_sequences(df, "sequence")
        assert r["invalid_count"] == 1

    def test_missing_column_returns_valid(self):
        df = _df({"T50": 55.0})
        r = _validate_sequences(df, "sequence")
        assert r["valid"] is True
        assert r["invalid_count"] == 0

    def test_warnings_capped_at_five(self):
        rows = [{"sequence": f"123{i}", "T50": float(i)} for i in range(10)]
        r = _validate_sequences(pd.DataFrame(rows), "sequence")
        assert len(r["warnings"]) <= 5
        assert r["invalid_count"] == 10

    def test_invalid_rows_capped_at_fifty(self):
        rows = [{"sequence": f"###ROW{i}", "T50": float(i)} for i in range(60)]
        r = _validate_sequences(pd.DataFrame(rows), "sequence")
        assert len(r["invalid_rows"]) <= 50


# ──────────────────────────────────────────────────────────────────────────────
# _activity_histogram
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.unit
class TestActivityHistogram:
    """_activity_histogram builds correctly sized and counted bins."""

    def test_empty_series_returns_empty_list(self):
        assert _activity_histogram(pd.Series([], dtype=float)) == []

    def test_single_value_single_bin(self):
        r = _activity_histogram(pd.Series([42.0]))
        assert len(r) == 1
        assert r[0]["count"] == 1

    def test_all_same_value_returns_single_bin(self):
        r = _activity_histogram(pd.Series([5.0, 5.0, 5.0]))
        assert len(r) == 1
        assert r[0]["count"] == 3

    def test_default_twenty_bins(self):
        r = _activity_histogram(pd.Series(range(100)), bins=20)
        assert len(r) == 20

    def test_total_count_equals_input_length(self):
        vals = [1.0, 2.0, 3.0, 4.0, 5.0]
        r = _activity_histogram(pd.Series(vals), bins=5)
        assert sum(b["count"] for b in r) == 5

    def test_nan_values_excluded(self):
        r = _activity_histogram(pd.Series([1.0, float("nan"), 3.0]))
        assert sum(b["count"] for b in r) == 2

    def test_bin_keys_present(self):
        r = _activity_histogram(pd.Series([10.0, 20.0, 30.0]), bins=3)
        for b in r:
            assert "bin" in b
            assert "count" in b


# ──────────────────────────────────────────────────────────────────────────────
# _length_histogram
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.unit
class TestLengthHistogram:
    """_length_histogram produces correct bins for integer length lists."""

    def test_empty_list_returns_empty(self):
        assert _length_histogram([]) == []

    def test_single_value(self):
        r = _length_histogram([10])
        assert len(r) == 1
        assert r[0]["count"] == 1

    def test_all_same_length(self):
        r = _length_histogram([5, 5, 5, 5])
        assert len(r) == 1
        assert r[0]["count"] == 4

    def test_total_count_equals_input(self):
        r = _length_histogram(list(range(1, 21)), bins=5)
        assert sum(b["count"] for b in r) == 20


# ──────────────────────────────────────────────────────────────────────────────
# _detect_duplicates
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.unit
class TestDetectDuplicates:
    """_detect_duplicates identifies repeated sequence strings."""

    def test_no_duplicates(self):
        df = _df(
            {"sequence": "ACDE", "T50": 55.0},
            {"sequence": "FGHI", "T50": 60.0},
        )
        r = _detect_duplicates(df, "sequence")
        assert r["has_duplicates"] is False
        assert r["duplicate_count"] == 0
        assert r["unique_count"] == 2

    def test_one_duplicate(self):
        df = _df(
            {"sequence": "ACDE", "T50": 55.0},
            {"sequence": "ACDE", "T50": 61.3},   # duplicate
            {"sequence": "FGHI", "T50": 60.0},
        )
        r = _detect_duplicates(df, "sequence")
        assert r["has_duplicates"] is True
        assert r["duplicate_count"] == 1  # second occurrence
        assert r["unique_count"] == 2

    def test_multiple_occurrences_of_same_sequence(self):
        df = _df(
            {"sequence": "ACDE", "T50": 55.0},
            {"sequence": "ACDE", "T50": 56.0},
            {"sequence": "ACDE", "T50": 57.0},
        )
        r = _detect_duplicates(df, "sequence")
        assert r["duplicate_count"] == 2  # all but the first occurrence

    def test_missing_column_returns_safe_defaults(self):
        df = _df({"T50": 55.0}, {"T50": 60.0})
        r = _detect_duplicates(df, "sequence")
        assert r["has_duplicates"] is False

    def test_duplicate_rows_list_capped_at_fifty(self):
        rows = [{"sequence": "ACDE", "T50": float(i)} for i in range(60)]
        r = _detect_duplicates(pd.DataFrame(rows), "sequence")
        assert len(r["duplicate_rows"]) <= 50


# ──────────────────────────────────────────────────────────────────────────────
# _check_missing
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.unit
class TestCheckMissing:
    """_check_missing counts NaN/empty cells across the sequence and activity columns."""

    def test_no_missing_values(self):
        df = _df(
            {"sequence": "ACDE", "T50": 55.0},
            {"sequence": "FGHI", "T50": 60.0},
        )
        r = _check_missing(df, "sequence", "T50")
        assert r["has_missing"] is False
        assert r["seq_missing"] == 0
        assert r["act_missing"] == 0

    def test_missing_activity_value(self):
        df = pd.DataFrame({"sequence": ["ACDE", "FGHI"], "T50": [55.0, None]})
        r = _check_missing(df, "sequence", "T50")
        assert r["has_missing"] is True
        assert r["act_missing"] == 1
        assert r["seq_missing"] == 0

    def test_missing_sequence_value(self):
        df = pd.DataFrame({"sequence": ["ACDE", None], "T50": [55.0, 60.0]})
        r = _check_missing(df, "sequence", "T50")
        assert r["has_missing"] is True
        assert r["seq_missing"] == 1

    def test_whitespace_only_sequence_counts_as_missing(self):
        df = pd.DataFrame({"sequence": ["ACDE", "   "], "T50": [55.0, 60.0]})
        r = _check_missing(df, "sequence", "T50")
        assert r["seq_missing"] == 1

    def test_missing_column_reports_zero_for_that_column(self):
        df = _df({"T50": 55.0})
        r = _check_missing(df, "sequence", "T50")
        assert r["seq_missing"] == 0

    def test_both_columns_missing(self):
        df = pd.DataFrame({"sequence": [None, "ACDE"], "T50": [None, 55.0]})
        r = _check_missing(df, "sequence", "T50")
        assert r["seq_missing"] == 1
        assert r["act_missing"] == 1
        assert r["has_missing"] is True


# ──────────────────────────────────────────────────────────────────────────────
# _detect_outliers
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.unit
class TestDetectOutliers:
    """_detect_outliers flags activity values more than 3σ from the mean."""

    def test_no_outliers_in_tight_cluster(self):
        s = pd.Series([55.0, 56.0, 54.0, 55.5, 54.8, 56.2, 55.1, 55.3])
        r = _detect_outliers(s)
        assert r["outlier_count"] == 0
        assert r["outlier_values"] == []

    def test_detects_extreme_high_value(self):
        # 3σ rule requires n>=12 to reliably flag a single outlier; use 11 normal + 1 extreme
        normal = [55.0, 56.0, 54.0, 55.5, 54.8, 56.2, 55.1, 55.3, 54.5, 55.7, 56.5]
        s = pd.Series(normal + [500.0])
        r = _detect_outliers(s)
        assert r["outlier_count"] == 1
        assert 500.0 in r["outlier_values"]

    def test_detects_extreme_low_value(self):
        # 3σ rule requires n>=12 to reliably flag a single outlier; use 11 normal + 1 extreme
        normal = [55.0, 56.0, 54.0, 55.5, 54.8, 56.2, 55.1, 55.3, 54.5, 55.7, 56.5]
        s = pd.Series(normal + [-500.0])
        r = _detect_outliers(s)
        assert r["outlier_count"] == 1

    def test_fewer_than_4_values_returns_empty(self):
        # Outlier detection requires >= 4 observations for meaningful std
        r = _detect_outliers(pd.Series([55.0, 60.0, 50.0]))
        assert r["outlier_count"] == 0

    def test_all_identical_values_no_outliers(self):
        # std == 0 → threshold == 0 → no value exceeds it
        r = _detect_outliers(pd.Series([5.0, 5.0, 5.0, 5.0, 5.0]))
        assert r["outlier_count"] == 0

    def test_returns_mean_std_threshold_fields(self):
        s = pd.Series([55.0, 56.0, 54.0, 55.5, 54.8, 56.2, 55.1, 55.3, 150.0])
        r = _detect_outliers(s)
        assert "mean" in r
        assert "std" in r
        assert "threshold_delta" in r
        assert r["threshold_delta"] == pytest.approx(3 * float(s.std()), rel=1e-3)

    def test_outlier_values_capped_at_fifty_entries(self):
        normal  = [55.0] * 10
        extreme = [1000.0] * 60
        r = _detect_outliers(pd.Series(normal + extreme))
        assert len(r["outlier_values"]) <= 50


# ──────────────────────────────────────────────────────────────────────────────
# _col_guess_confidence
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.unit
class TestColGuessConfidence:
    """_col_guess_confidence returns 'high', 'medium', or 'low' for column type hints."""

    def test_high_confidence_sequence_column_by_name(self):
        df = _df({"sequence": "ACDE", "T50": 55.0})
        assert _col_guess_confidence(df, "sequence", "seq") == "high"

    def test_high_confidence_seq_column_with_keyword_alias(self):
        df = _df({"protein": "ACDE", "T50": 55.0})
        assert _col_guess_confidence(df, "protein", "seq") == "high"

    def test_high_confidence_activity_column_named_activity(self):
        df = _df({"sequence": "ACDE", "activity": 55.0})
        assert _col_guess_confidence(df, "activity", "act") == "high"

    def test_high_confidence_activity_column_named_t50(self):
        df = _df({"sequence": "ACDE", "T50": 55.0})
        assert _col_guess_confidence(df, "T50", "act") == "high"

    def test_high_confidence_fitness_column(self):
        df = _df({"sequence": "ACDE", "fitness": 0.9})
        assert _col_guess_confidence(df, "fitness", "act") == "high"

    def test_medium_confidence_for_numeric_unnamed_act(self):
        df = pd.DataFrame({"col1": ["ACDE", "FGHI"], "col2": [1.0, 2.0]})
        conf = _col_guess_confidence(df, "col2", "act")
        assert conf in ("high", "medium")

    def test_low_confidence_for_unrecognised_seq_column(self):
        df = pd.DataFrame({"xyz": [1.0, 2.0], "T50": [55.0, 60.0]})
        conf = _col_guess_confidence(df, "xyz", "seq")
        assert conf in ("medium", "low")


# ──────────────────────────────────────────────────────────────────────────────
# _build_config
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.unit
class TestBuildConfig:
    """_build_config assembles the pySAR JSON config dict from an EncodeRequest."""

    def test_top_level_sections_present(self):
        cfg = _build_config(_enc_req())
        assert set(cfg.keys()) >= {"dataset", "model", "descriptors", "pyDSP"}

    def test_dataset_section_mirrors_request(self):
        path = str(UPLOAD_DIR / "seqs.csv")
        cfg = _build_config(_enc_req(
            file_path=path,
            sequence_col="seq",
            activity_col="act",
        ))
        # Validator resolves the path; compare resolved forms
        assert cfg["dataset"]["dataset"] == str((UPLOAD_DIR / "seqs.csv").resolve())
        assert cfg["dataset"]["sequence_col"] == "seq"
        assert cfg["dataset"]["activity"] == "act"

    def test_model_algorithm_propagated(self):
        cfg = _build_config(_enc_req(algorithm="ridge", test_split=0.3))
        assert cfg["model"]["algorithm"] == "ridge"
        assert cfg["model"]["test_split"] == pytest.approx(0.3)

    def test_default_dsp_disables_signal_processing(self):
        cfg = _build_config(_enc_req())
        assert cfg["pyDSP"].get("use_dsp") == 0

    def test_dsp_config_forwarded_verbatim(self):
        dsp = {"use_dsp": 1, "spectrum": "power", "window": {"type": "hamming"}}
        cfg = _build_config(_enc_req(dsp_config=dsp))
        assert cfg["pyDSP"] == dsp

    def test_descriptor_config_forwarded_verbatim(self):
        desc = {"amino_acid_composition": {"normalize": 1}}
        cfg = _build_config(_enc_req(descriptors_config=desc))
        assert cfg["descriptors"] == desc

    def test_none_model_parameters_defaults_to_empty_dict(self):
        cfg = _build_config(_enc_req(model_parameters=None))
        assert cfg["model"]["parameters"] == {}


# ──────────────────────────────────────────────────────────────────────────────
# _estimate_total_models
# ──────────────────────────────────────────────────────────────────────────────

@pytest.mark.unit
class TestEstimateTotalModels:
    """_estimate_total_models computes model counts for all three strategies."""

    # ── AAI strategy ──────────────────────────────────────────────────────────

    def test_aai_defaults_to_566_indices_when_none_selected(self):
        req = _enc_req(strategy="aai", aai_indices=None)
        assert _estimate_total_models(req) == 566

    def test_aai_uses_length_of_selected_indices(self):
        req = _enc_req(strategy="aai", aai_indices=["ALTS910101", "BHAR880101"])
        assert _estimate_total_models(req) == 2

    def test_aai_single_index(self):
        req = _enc_req(strategy="aai", aai_indices=["ALTS910101"])
        assert _estimate_total_models(req) == 1

    def test_aai_respects_max_models_hard_cap(self):
        req = _enc_req(strategy="aai", aai_indices=None, max_models=10)
        assert _estimate_total_models(req) == 10

    def test_aai_max_models_no_effect_when_larger_than_pool(self):
        req = _enc_req(strategy="aai", aai_indices=["A", "B"], max_models=100)
        assert _estimate_total_models(req) == 2

    # ── Descriptor strategy ───────────────────────────────────────────────────

    def test_descriptor_defaults_to_33_when_none_selected(self):
        req = _enc_req(strategy="descriptor", selected_descriptors=None, desc_combo=1)
        # _DEFAULT_DESC_COUNT == 33
        assert _estimate_total_models(req) == 33

    def test_descriptor_combo_1_with_explicit_selection(self):
        # C(3, 1) = 3
        req = _enc_req(strategy="descriptor",
                       selected_descriptors=["aac", "dpc", "tpc"], desc_combo=1)
        assert _estimate_total_models(req) == 3

    def test_descriptor_combo_2(self):
        # C(3,1) + C(3,2) = 3 + 3 = 6
        req = _enc_req(strategy="descriptor",
                       selected_descriptors=["a", "b", "c"], desc_combo=2)
        assert _estimate_total_models(req) == 6

    def test_descriptor_combo_3(self):
        # C(4,1)+C(4,2)+C(4,3) = 4+6+4 = 14
        req = _enc_req(strategy="descriptor",
                       selected_descriptors=["a", "b", "c", "d"], desc_combo=3)
        assert _estimate_total_models(req) == 14

    def test_descriptor_single_descriptor_combo_1_is_one(self):
        req = _enc_req(strategy="descriptor",
                       selected_descriptors=["aac"], desc_combo=1)
        assert _estimate_total_models(req) == 1

    # ── AAI + Descriptor (combined) strategy ──────────────────────────────────

    def test_aai_descriptor_cross_product(self):
        # 2 AAI × C(2,1)=2 descriptors = 4 total
        req = _enc_req(
            strategy="aai_descriptor",
            aai_indices=["A", "B"],
            selected_descriptors=["x", "y"],
            desc_combo=1,
        )
        assert _estimate_total_models(req) == 4

    def test_aai_descriptor_with_combo_2(self):
        # 2 AAI × (C(3,1)+C(3,2)) = 2 × 6 = 12
        req = _enc_req(
            strategy="aai_descriptor",
            aai_indices=["A", "B"],
            selected_descriptors=["x", "y", "z"],
            desc_combo=2,
        )
        assert _estimate_total_models(req) == 12

    # ── Edge cases ────────────────────────────────────────────────────────────

    def test_unknown_strategy_returns_zero(self):
        # strategy is now a Literal — bypass validation with model_construct to
        # test the else-branch of _estimate_total_models directly
        req = EncodeRequest.model_construct(
            file_path=str(UPLOAD_DIR / "test.csv"),
            sequence_col="sequence",
            activity_col="T50",
            strategy="unknown_strategy",
            aai_indices=None,
            selected_descriptors=None,
            desc_combo=1,
            max_models=None,
        )
        assert _estimate_total_models(req) == 0

    def test_max_models_applied_to_aai_descriptor(self):
        req = _enc_req(
            strategy="aai_descriptor",
            aai_indices=None,         # 566
            selected_descriptors=None, # 33
            desc_combo=1,
            max_models=100,
        )
        assert _estimate_total_models(req) == 100
