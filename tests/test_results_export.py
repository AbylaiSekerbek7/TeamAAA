from backend import results_export as rx


def ok_record(cid="a", **over):
    crit = [
        {"criterion_id": "contact", "value": True, "rationale": "x", "evidence_turns": [10]},
        {"criterion_id": "discovery", "value": None, "rationale": "x", "evidence_turns": [1]},
        {"criterion_id": "identification", "value": None, "rationale": "x", "evidence_turns": [1]},
        {"criterion_id": "consultation", "value": 15, "rationale": "x", "evidence_turns": [5]},
        {"criterion_id": "empathy", "value": True, "rationale": "x", "evidence_turns": [5]},
        {"criterion_id": "dialogue", "value": 7, "rationale": "x", "evidence_turns": [5]},
        {"criterion_id": "closure", "value": False, "rationale": "x", "evidence_turns": [12]},
        {"criterion_id": "critical", "value": False, "rationale": "x", "evidence_turns": []},
    ]
    r = {"conversation_id": cid, "status": "ok", "criteria": crit, "score": {"final_score": 85.38, "critical_flag": False}}
    r.update(over)
    return r


def payload(results):
    return {"schema_version": "1.0", "team_name": "T", "model": {"mode": "local", "name": "m"}, "results": results}


def test_valid_payload():
    assert rx.validate(payload([ok_record("a"), ok_record("b")]), expected_ids=["a", "b"]) == []


def test_error_record_shape():
    err = {"conversation_id": "e", "status": "error", "criteria": [], "score": None, "error": "Не удалось получить ответ модели."}
    assert rx.validate(payload([err])) == []
    bad = dict(err, score={"final_score": 0, "critical_flag": False})
    assert rx.validate(payload([bad]))


def test_detects_duplicates_missing_and_types():
    assert rx.validate(payload([ok_record("a"), ok_record("a")]))
    assert rx.validate(payload([ok_record("a")]), expected_ids=["a", "b"])
    r = ok_record("a")
    r["criteria"][5]["value"] = 5  # dialogue allows 0/4/7/10 only
    assert rx.validate(payload([r]))
    r = ok_record("a")
    r["criteria"][3]["value"] = False  # consultation is numeric or null
    assert rx.validate(payload([r]))
    r = ok_record("a")
    r["score"]["critical_flag"] = True  # must match critical value
    assert rx.validate(payload([r]))


def test_value_mapping_and_turn_refs():
    assert rx.to_value("yes") is True and rx.to_value("no") is False and rx.to_value("na") is None and rx.to_value(15) == 15
    assert rx.one_based_refs("Основание — реплика [9] и [0].", 20) == "Основание — реплика [10] и [1]."
