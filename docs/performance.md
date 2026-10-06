# Performance

D1 charges latency per round trip and bills by rows read. So each dashboard load is one `db.batch` of independent reads, and every hot query is backed by an index. D1 has no planner statistics unless someone runs `PRAGMA optimize`, so the indexes are chosen to produce the right plan without them. Query plans were checked with `EXPLAIN QUERY PLAN` on the migrated schema.

Measure with the bench, which seeds 5 projects, 20k invoices, 50k events and deliveries, 10k ledger rows, 40k activity rows and 3k subscriptions:

```sh
pnpm --filter @bogts/gateway bench
```

`src/lib/server/perf/roundtrips.test.ts` runs with `pnpm test` and fails if a load goes over its round-trip budget.

## Round-trip budget

The (app) layout and the page load run in parallel. Pages don't `await parent()`. The `?project=` scope is checked once per request (`requestScope`), and the page's reads start alongside that check (`withScope`).

| Load | Round trips | Critical path |
|---|---|---|
| Layout (switcher, sidebar badge) | 1 batch (3 statements) | 1 |
| Overview | 1 batch (16) + scope check | 1 |
| Events, payments, charges, subscriptions lists | 1 batch (list + tiles) | 1 |
| Projects, usage | 1 batch | 1 |
| Payment, charge, subscription, event detail | 1 batch | 1 |
| Search | 1 (id probes) + 1 (references) | 2 |
| Settings (cron status) | 1 batch | 1 |
| Pay page status poll | 1 batch (rate-limit hit + invoice) | 1, plus the QPay check when pending |
| `deliverFresh` after each `/v1` or `/hooks` request with nothing pending | 1 indexed probe | 1 |

Measured with a simulated 5 ms round trip, including the layout:

| Page | Before (round trips / wall / SQLite) | After |
|---|---|---|
| Overview | 33 / 179 ms / 69 ms | 2 / 10 ms / 3 ms |
| Events list | 11 / quadratic: 1.8 s at 2.5k events, 29 s at 10k | 2 / 9 ms / 3 ms at 50k |
| Payments, charges, subscriptions | 5 to 6 / about 40 ms / 26 ms | 2 / 6 to 8 ms / under 3 ms |
| Projects | 7 / 50 ms / 28 ms | 2 / 8 ms / 1 ms |
| Usage | 7 / 43 ms / 30 ms | 2 / 7 ms / 1 ms |

"The latest delivery of an event" used to be `delivery.id = (select max(id) …)`. When a list was filtered on a delivery column, SQLite walked every event for each candidate delivery. It is now `event_id = event.id and not exists (a later delivery)`, which is two probes of `delivery_event_id_idx`.

## Indexes and the queries they serve

| Index | Serves |
|---|---|
| `invoice_project_id_idx (project_id, id)` | Payments list, `GET /v1/invoices` (newest id first per project) |
| `invoice_reference_idx (reference, project_id, id)` | Purchase lookups (reuse a pending invoice, first paid sibling, cancel siblings), `?reference=`, global search |
| `invoice_created_idx (created_at)` | Overview success rate (invoices created in the period) |
| `invoice_sweep_idx (status, expires_at) where swept_at is null` | Sweep: pending invoices past expiry (unchanged) |
| `invoice_sweep_claimed_idx (status, swept_at) where swept_at is not null` | Sweep: stale claims (previously a full scan every 10 minutes) |
| `invoice_late_check_idx` | QPay late check (unchanged) |
| `card_setup_pending_idx (created_at) where status = 'pending'` | Cron: abandoned card steps (migration `0009_card_setup_pending`) |
| `charge_project_id_idx (project_id, id)` | Charges list, `GET /v1/charges` |
| `charge_reference_idx (reference, project_id)` | Global search, per-project reference |
| `charge_status_created_idx (status, created_at)` | Overview: charges stuck pending, finished charges in the period, status tiles |
| `subscription_customer_idx (customer_ref, project_id, plan_id)` | New subscription (open mandates of a customer and plan), duplicate-live check, search |
| `subscription_project_id_idx (project_id, id)` | Subscriptions list, `GET /v1/subscriptions` |
| `subscription_status_bill_idx (status, next_bill_at)` | Renewal reconciliation (previously a full scan every hour) |
| `subscription_plan_idx (plan_id)` | Plans tab counts, removing a plan (and the plan foreign key) |
| `ledger_created_idx (created_at, project_id)` | Overview volume and chart, usage (all projects or one) |
| `event_created_idx (created_at, project_id)` | Usage: events in a month, counted from the index alone |
| `delivery_status_created_idx (status, created_at)` | `deliverFresh`, failing deliveries (sidebar badge, overview, `?status=failing`), 7-day delivery health |
| `delivery_event_id_idx (event_id, id)` | Latest delivery per event, an event's deliveries, re-deliver |
| `delivery_project_id_idx (project_id, id)` | Webhook tab: a project's recent deliveries |
| `delivery_attempt_event_idx (event_id, number)` | Event page: attempts, newest first |
| `activity_kind_created_idx (kind, created_at)` | Overview "Needs attention" findings, reconcile's daily note |
| `audit_log_subject_idx (subject, created_at)` | Timelines, plan validation status |

Removed or replaced: `invoice_project_created_idx`, `invoice_project_reference_idx`, `charge_project_created_idx`, `charge_project_reference_idx`, `subscription_project_customer_idx`, `subscription_project_created_idx`, `ledger_project_created_idx`, `delivery_event_idx`, `delivery_project_created_idx`, `delivery_attempt_delivery_idx` and `delivery_attempt_project_created_idx` (never read), `activity_created_idx`, `audit_log_created_idx`.

The migration is `0006_perf_indexes`. After applying it, running `PRAGMA optimize` once is harmless, but the plans above don't depend on it.

## Accepted scans

- Tile counts over all rows (invoice, charge and subscription status counts; the events total) read the whole scoped table or index. They are exact counts, with no cached counters.
- The overview's subscription numbers take one pass over `subscription`, replacing the four separate passes it made before.
- `rate_limit` purge (hourly, small table).
