# 🚀 Aura — Distributed Job Processing System

Aura is a distributed job processing system designed to simulate real-world backend infrastructure — including scheduling, retries, failure recovery, and real-time observability.

It has been tested under **20,000+ jobs**, demonstrating correctness, stability, and performance under load.

---

## 🔥 System in Action

### 🧩 End-to-End Processing (20k Jobs)

![System Overview](./assets/system-overview.png)

---

### 📈 Throughput & Latency

![Performance](./assets/performance.png)

---

### 🔄 Real-Time Job Activity

![Job Activity](./assets/job-activity.png)

---

## 🧠 What This Project Proves

* Handles high-volume job processing (20k+)
* Maintains correctness under failures
* Recovers from worker crashes
* Provides real-time observability
* Demonstrates queue behavior under load

---

## ⚙️ Architecture

```text
Client → API → Redis Queue → Worker Pool → PostgreSQL
                        ↓
                  Scheduler (delay + recovery)
```

---

## 🔄 Job Lifecycle

```
PENDING → PROCESSING → COMPLETED
                    ↓
                 FAILED → RETRY → DLQ
```

---

## 📊 Load Testing Results

| Metric          | Result                 |
| --------------- | ---------------------- |
| Throughput      | ~300 jobs/min (~5/sec) |
| Peak ingestion  | 1000+ jobs/sec         |
| Latency (P95)   | ~6.5s                  |
| Failure rate    | ~10–15%                |
| System behavior | stable, fully drained  |

---

## ⚠️ Real Issues Solved

* UI crash under load → fixed with pagination + defensive rendering
* Redis build issue → fixed TypeScript output path
* DB conflicts → resolved via port remapping
* Stale job recovery → implemented heartbeat detection
* SSE data corruption → fixed with strict validation

---

## 📊 Observability

* Queue depth
* Throughput
* Latency (P95)
* Worker utilization
* System health

---

## 🧪 Run Locally

```bash
docker-compose up -d
npm run db:push
npm run build -w @aura/redis

DATABASE_URL="postgresql://postgres:password@localhost:5433/aura" \
REDIS_URL="redis://localhost:6379" \
JOB_GENERATOR_ENABLED=true \
npm run dev
```

UI:
http://localhost:5173

---

## 🧠 Key Learnings

* Systems must be designed for failure, not success
* Throughput vs latency trade-offs matter
* Backend scaling requires frontend optimization
* Idempotency is critical for correctness

---

## 👨‍💻 Author

Dhruva Aher


---


