# Semantic Context Service

This is the Semantica integration boundary for the AI platform. It runs separately from the Node business API and stores graph context, provenance and Agent decision records.

## Responsibilities

- Ingest only already-authorized facts from OA, ERP, MES, LIMS, QMS and OMS.
- Build context graphs and retain provenance, validity time and record time.
- Validate ontology constraints and surface conflicts for human review.
- Record the evidence and outcome of each 智脑 decision.

It must **not** authenticate users, make entitlement decisions, hold business-system credentials or execute workflows. Those remain in the account/permission/key/workflow control planes.

## Run

```powershell
python -m pip install -r services/semantic-context/requirements.txt
python services/semantic-context/app.py
```

The default local endpoint is `http://127.0.0.1:3011` (`/health`). Port `3010` is reserved for the Key Center service. Override the semantic endpoint only with `SEMANTIC_CONTEXT_PORT`.

The production deployment should use mTLS and a private network endpoint. The Demo API exposes a role-filtered semantic projection so the UI remains usable when this separate Python service is not running.
