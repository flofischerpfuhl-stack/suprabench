# SupraBench Prefill Research, Stand 2026-06-22

Ziel: aktuelle Scores recherchieren und belegen, dann nach Review kontrolliert in Production seeden.

Status: Urspruenglich research-only; nach User-Freigabe am 2026-06-22 in Convex Production importiert. Importpfad: `seed:seedBenches`, `seed:seedModels`, `seed:seedBenchRatings`, `seed:seedScores`, `seed:recomputeAllBenchCaches`, `scoresWorker:migrateAllToD1`, `seed:finalize`, `rankings:recomputeFromD1`.

Post-Import-Snapshot:

| Tabelle / Cache | Count |
|---|---:|
| `benches` | 18 |
| `models` | 126 |
| `modelScores` | 495 |
| `benchQualityRatings` | 18 |
| `modelRankings` | 126 |
| `familyRankings` | 70 |

## Kurzfazit

- Production enthält nach dem Import 18 Benchmarks und 495 Score-Submissions.
- Die bestehenden CAIS- und Artificial-Analysis-Quellen haben sich seit dem Seed sichtbar weiterbewegt. Besonders relevant sind neue Reihen für GPT-5.5, Claude/Opus 4.8, Claude Fable 5, Gemini 3.5 Flash, Kimi K2.6/K2.7, GLM-5.2 und Grok 4.3.
- DeepSWE ist zweideutig:
  - Datacurve DeepSWE ist ein neuer Benchmark mit 113 Tasks. Das sind die Scores, die als neuer Benchmark-Kandidat in SupraBench passen.
  - Agentica/Together DeepSWE-Preview ist ein Modell/Agent auf SWE-bench Verified. Diese Werte dürfen nicht als Datacurve-DeepSWE-Benchmark-Scores eingetragen werden.

## Belege

Screenshots liegen lokal unter [docs/research/screenshots/](screenshots/).

| Beleg | Datei | Zweck |
|---|---|---|
| Datacurve DeepSWE v1.1 Leaderboard | [deepswe-leaderboard-2026-06-22.png](screenshots/deepswe-leaderboard-2026-06-22.png) | Neuer DeepSWE-Benchmark, 113 Tasks, v1.1, sichtbare Score-Tabelle |
| CAIS Dashboard | [cais-dashboard-current-2026-06-22.png](screenshots/cais-dashboard-current-2026-06-22.png) | Aktuelle Text-/Vision-Matrix für bestehende CAIS-Benches |
| Artificial Analysis HLE | [artificial-analysis-hle-2026-06-22.png](screenshots/artificial-analysis-hle-2026-06-22.png) | Aktuelle HLE Topwerte und Methodik |
| Artificial Analysis LCR | [artificial-analysis-lcr-2026-06-22.png](screenshots/artificial-analysis-lcr-2026-06-22.png) | Aktuelle AA-LCR Topwerte |
| Artificial Analysis SciCode | [artificial-analysis-scicode-2026-06-22.png](screenshots/artificial-analysis-scicode-2026-06-22.png) | Aktuelle SciCode Topwerte |
| SWE-bench Verified Kontext | [swebench-verified-2026-06-22.png](screenshots/swebench-verified-2026-06-22.png) | Belegt Benchmark-Kontext, 500 human-filtered instances, mini-SWE-agent-Hinweis |
| HF DeepSWE-Preview | [hf-deepswe-preview-evaluation-2026-06-22.png](screenshots/hf-deepswe-preview-evaluation-2026-06-22.png) | Belegt die getrennte DeepSWE-Preview-Modellkarte |

Primärquellen:

- Datacurve DeepSWE: https://deepswe.datacurve.ai/
- Datacurve DeepSWE v1.1 JSON: https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json
- DeepSWE GitHub: https://github.com/datacurve-ai/deep-swe
- CAIS Dashboard: https://dashboard.safe.ai/
- Artificial Analysis HLE: https://artificialanalysis.ai/evaluations/humanitys-last-exam
- Artificial Analysis MMMU-Pro: https://artificialanalysis.ai/evaluations/mmmu-pro
- Artificial Analysis LCR: https://artificialanalysis.ai/evaluations/artificial-analysis-long-context-reasoning
- Artificial Analysis SciCode: https://artificialanalysis.ai/evaluations/scicode
- Artificial Analysis Terminal-Bench Hard: https://artificialanalysis.ai/evaluations/terminalbench-hard
- Artificial Analysis Tau2-Bench: https://artificialanalysis.ai/evaluations/tau2-bench
- Artificial Analysis APEX-Agents-AA: https://artificialanalysis.ai/evaluations/apex-agents-aa
- SWE-bench Verified: https://www.swebench.com/verified.html
- DeepSWE-Preview Modellkarte: https://huggingface.co/agentica-org/DeepSWE-Preview
- Together DeepSWE-Preview Blog: https://www.together.ai/blog/deepswe

## Pre-Import Production DB Snapshot

Read-only Commands:

```bash
npx convex run --prod benches:listRanked '{}'
npx convex run --prod benches:getBySlug '{"slug":"<bench-slug>"}'
npx convex run --prod models:listRanked '{}'
```

| Benchmark | Production-Slug | DB-Score-Zeilen | aktuelle DB-Topwerte |
|---|---:|---:|---|
| ARC-AGI-2 | `arc-agi-2` | 32 | Gemini 3.1 Pro Preview 73.3; GPT-5.4 65.0; Grok 4.2 55.0 |
| Humanity's Last Exam | `humanity-s-last-exam` | 62 | Gemini 3.1 Pro Preview 45.9/44.7; GPT-5.5 xhigh 44.3; GPT-5.5 high 43.0 |
| SWE-Bench Pro | `swe-bench-pro` | 32 | Claude Opus 4.7 60.9; Claude Opus 4.6 56.7; Claude Sonnet 4.6 53.8 |
| TextQuests | `textquests` | 32 | Gemini 3.1 Pro Preview 45.8; GPT-5.4 42.2; Gemini 3 Pro 41.0 |
| EnigmaEval | `enigmaeval` | 28 | Gemini 3.1 Pro Preview 32.4; GPT-5.4 27.6; Gemini 3 Flash 18.3 |
| IntPhys 2 | `intphys-2` | 28 | Gemini 3 Flash 63.4; Grok 4.2 62.6; GPT-5 mini 59.2 |
| SWE-bench Verified | `swe-bench-verified` | 13 | Claude 4.5 Opus high 76.8; Gemini 3 Flash high 75.8; MiniMax M2.5 high 75.79 |
| SpatialViz | `spatialviz` | 28 | GPT-5.4 69.3; Gemini 3.1 Pro Preview 66.1; GPT-5.2 65.8 |
| ERQA | `erqa` | 28 | Gemini 3.1 Pro Preview 74.2; Gemini 3 Flash 71.0; Gemini 3 Pro 70.2 |
| APEX-Agents-AA | `apex-agents-aa` | 12 | GPT-5.5 xhigh 37.7; GPT-5.4 xhigh 33.3; Claude Opus 4.6 max 33.0 |
| MindCube | `mindcube` | 28 | Gemini 3.1 Pro Preview 84.1; Gemini 3 Flash 78.3; Gemini 3 Pro 77.3 |
| SciCode | `scicode` | 12 | Gemini 3.1 Pro Preview 58.9; GPT-5.4 xhigh 56.6; GPT-5.5 xhigh 56.1 |
| Terminal-Bench Hard | `terminal-bench-hard` | 11 | GPT-5.5 xhigh 60.6; GPT-5.5 high 59.8; GPT-5.4 xhigh 57.6 |
| AA Long Context Reasoning | `aa-long-context-reasoning` | 14 | GPT-5.2 Codex xhigh 75.7; GPT-5 high 75.6; GPT-5.1 75.0 |
| MMMU-Pro | `mmmu-pro` | 21 | Gemini 3.1 Pro Preview 82; GPT-5.5 medium/high 81; Muse Spark 81 |
| Tau2-Bench Telecom | `tau2-bench-telecom` | 10 | GLM-4.7 Flash 98.8; GLM-5 Turbo 98.5; GLM-5V Turbo 98.5 |

## Aktuelle Quellwerte Für Bestehende Benches

### CAIS Dashboard

Quelle: https://dashboard.safe.ai/
Screenshot: [cais-dashboard-current-2026-06-22.png](screenshots/cais-dashboard-current-2026-06-22.png)

Text Capabilities, aktuelle sichtbare Standard-Modelle:

| Modell-Label Quelle | HLE | ARC-AGI-2 | SWE-Bench Pro | TextQuests |
|---|---:|---:|---:|---:|
| GPT-5.5 | 43.6 | 77.5 | 53.4 | 42.0 |
| Opus 4.8 | 42.2 | 67.5 | 65.4 | 40.1 |
| Gemini 3.1 Pro | 45.9 | 73.3 | 46.7 | 45.8 |
| DeepSeek 4 Pro | 32.4 | 28.3 | 47.3 | 20.3 |
| Kimi K2.6 | 29.9 | 18.1 | 50.1 | 27.4 |
| GLM 5.1 | 25.6 | 15.0 | 49.2 | 29.5 |
| Grok 4.3 | 33.1 | 13.3 | 38.7 | 13.7 |

Vision Capabilities, aktuelle sichtbare Standard-Modelle:

| Modell-Label Quelle | ERQA | MindCube | SpatialViz | IntPhys 2 | EnigmaEval |
|---|---:|---:|---:|---:|---:|
| GPT-5.5 | 70.5 | 79.9 | 74.2 | 59.9 | 37.2 |
| Gemini 3.1 Pro | 74.2 | 84.1 | 66.1 | 53.6 | 32.4 |
| Kimi K2.6 | 61.3 | 75.6 | 73.9 | 60.0 | 5.5 |
| Opus 4.8 | 59.5 | 64.9 | 65.2 | 55.1 | 20.5 |
| Grok 4.3 | 57.3 | 72.2 | 49.6 | 56.9 | 6.1 |

Interpretation: Die CAIS-Quelle ist nicht mehr identisch mit dem alten Seed. Ein späterer DB-Write sollte diese Werte entweder als zusätzliche Submissions mit neuer `sourceUrl`/Access-Date übernehmen oder bewusst nur DeepSWE ergänzen.

### Artificial Analysis

Quellen: siehe Primärquellenliste oben. HLE/LCR/SciCode sind zusätzlich als Screenshots belegt.

| Benchmark | aktuelle Top-3 auf Quellseite | DB-Abgleich |
|---|---|---|
| Humanity's Last Exam | Claude Fable 5 adaptive max/fallback 53.3; Claude Opus 4.8 adaptive max 45.7; Gemini 3.1 Pro Preview 44.7 | DB hat HLE schon, aber Topmodell Claude Fable 5 fehlt |
| MMMU-Pro | Gemini 3.5 Flash high 84; Gemini 3.5 Flash medium 84; Gemini 3.1 Pro Preview 82 | DB-Top ist noch Gemini 3.1 Pro Preview 82 |
| AA Long Context Reasoning | GPT-5.2 Codex xhigh 75.7; GPT-5 high 75.6; GPT-5.1 high 75.0 | DB enthält diese Spitze weitgehend, aber aktuelle AA-Liste hat mehr Einträge |
| SciCode | Claude Fable 5 adaptive max/fallback 60.2; Gemini 3.1 Pro Preview 58.9; GPT-5.4 xhigh 56.6 | DB-Top ist noch Gemini 3.1 Pro Preview 58.9 |
| Terminal-Bench Hard | Claude Fable 5 adaptive max/fallback 62.9; GPT-5.5 xhigh 60.6; GPT-5.5 high 59.8 | DB-Top ist noch GPT-5.5 xhigh 60.6 |
| Tau2-Bench Telecom | JT-35B-Flash 99.1; GLM-5.2 max 99.1; GLM-4.7-Flash reasoning 98.8 | DB-Top ist noch GLM-4.7 Flash 98.8 |
| APEX-Agents-AA | Gemini 3.5 Flash high 47.1; GPT-5.5 xhigh 37.7; GPT-5.4 xhigh 33.3 | DB-Top ist noch GPT-5.5 xhigh 37.7 |

## Neuer Benchmark-Kandidat: Datacurve DeepSWE

Quelle: https://deepswe.datacurve.ai/
JSON: https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json
Screenshot: [deepswe-leaderboard-2026-06-22.png](screenshots/deepswe-leaderboard-2026-06-22.png)

Quell-Metadaten aus offizieller JSON-Datei:

- `generated_at`: `2026-06-20T18:00:09.904443+00:00`
- `latest_job`: `20260620-deep-swe-glm-5-2`, finished `2026-06-20T22:09:10.110006`
- `n_tasks_in_set`: 113
- Unit laut JSON: `pass@1` ist Attempt-Pass-Rate über scored rollout attempts; `pass@4` ist Anteil Tasks mit mindestens einem passing rollout.
- Alle sichtbaren Scores laufen laut Seite mit `mini-swe-agent`.

Benchmark-Definition für Review:

| Feld | Vorschlag |
|---|---|
| Name | DeepSWE |
| Slug | `deepswe` |
| URL | `https://deepswe.datacurve.ai/` |
| Beschreibung | Long-horizon software engineering benchmark with original tasks across active open-source repositories, evaluated with Pier/mini-swe-agent. |
| Tags | `coding`, `software engineering`, `agents`, `long horizon` |
| Skala | Vorschlag `0..1000`, wie die meisten Prozent-Benches im Seed; `pct * 10` gerundet als rawScore |
| Primärscore | `pass@1` |

Offizielle v1.1 Scores:

| Modell-Label Quelle | Effort | pass@1 | n_passed/n_attempted | pass@4 | Rohscore bei Skala 0..1000 |
|---|---|---:|---:|---:|---:|
| Claude Fable 5 | xhigh | 69.91 | 316/452 | 88.50 | 699 |
| Claude Fable 5 | max | 69.72 | 304/436 | 84.07 | 697 |
| Claude Fable 5 | high | 68.60 | 295/430 | 86.73 | 686 |
| GPT-5.5 | xhigh | 67.04 | 303/452 | 88.50 | 670 |
| Claude Fable 5 | medium | 65.37 | 285/436 | 83.19 | 654 |
| GPT-5.5 | high | 64.38 | 291/452 | 90.27 | 644 |
| Claude Fable 5 | low | 59.58 | 258/433 | 81.42 | 596 |
| Claude Opus 4.8 | max | 58.97 | 253/429 | 79.28 | 590 |
| Claude Opus 4.8 | xhigh | 54.36 | 243/447 | 80.53 | 544 |
| GPT-5.5 | medium | 53.98 | 244/452 | 77.88 | 540 |
| Claude Opus 4.8 | high | 51.77 | 234/452 | 77.88 | 518 |
| GPT-5.4 | xhigh | 51.77 | 234/452 | 77.88 | 518 |
| Claude Opus 4.8 | medium | 48.67 | 220/452 | 76.11 | 487 |
| GLM-5.2 | max | 43.78 | 197/450 | 76.99 | 438 |
| Claude Opus 4.8 | low | 40.80 | 184/451 | 68.14 | 408 |
| Gemini 3.5 Flash | medium | 37.39 | 169/452 | 66.37 | 374 |
| Kimi K2.7 Code | default | 30.53 | 138/452 | 61.06 | 305 |
| Claude Sonnet 4.6 | high | 29.93 | 135/451 | 56.64 | 299 |
| GPT-5.5 | low | 26.99 | 122/452 | 47.79 | 270 |
| Gemini 3.1 Pro Preview | high | 11.75 | 53/451 | 28.32 | 118 |

Modelle aus der DeepSWE-v1.1-Liste, die in Production bereits existieren:

- `GPT-5.5 (xhigh/high/medium/low)` existiert.
- `GPT-5.4 (xhigh)` existiert.
- `Claude Sonnet 4.6` und `Claude Sonnet 4.6 (max)` existieren, aber kein `high`-Effort-Eintrag.
- `Gemini 3.1 Pro Preview` existiert.

Modelle aus der DeepSWE-v1.1-Liste, die vor einem Score-Write wahrscheinlich neu anzulegen sind:

- Claude Fable 5: `xhigh`, `max`, `high`, `medium`, `low`
- Claude Opus 4.8: `max`, `xhigh`, `high`, `medium`, `low`
- GLM-5.2 (max)
- Gemini 3.5 Flash (medium)
- Kimi K2.7 Code
- Claude Sonnet 4.6 (high), falls Effort-spezifisch getrennt erfasst werden soll

Provider-Mapping muss vor dem Write final geprüft werden. Aus den Quelllogos naheliegend: Anthropic für Claude Fable/Opus/Sonnet, OpenAI für GPT, Google für Gemini, Zhipu AI für GLM, Moonshot AI für Kimi.

## Nicht Verwechseln: DeepSWE-Preview

Quelle: https://huggingface.co/agentica-org/DeepSWE-Preview
Screenshot: [hf-deepswe-preview-evaluation-2026-06-22.png](screenshots/hf-deepswe-preview-evaluation-2026-06-22.png)

Das ist kein Datacurve-DeepSWE-Benchmark, sondern ein open-weight Coding-Agent/Modell. Relevante SWE-bench-Verified-Werte:

| Modell/Scaffold | Benchmark | Score |
|---|---|---:|
| DeepSWE-Preview 32B, R2E-Gym Agent | SWE-bench Verified | 42.2 |
| DeepSWE-Preview 32B, R2E-Gym Agent + Hybrid Best@8 | SWE-bench Verified | 57.9 |
| DeepSWE-Preview 32B, R2E-Gym Agent + Hybrid Best@16 / TTS | SWE-bench Verified | 59.0 |

Hinweis: Der Subagent fand auf SWE-bench selbst 58.8% für `DeepSWE-Preview + TTS(Bo16)`, während Hugging Face/Together 59.0% nennen. Das ist wahrscheinlich Rundung oder ein leicht anderer Uploadstand. Vor einem SWE-bench-Verified-Write sollte die offizielle SWE-bench-Zeile direkt gefiltert und als Screenshot gesichert werden.

## Schreibpfad In Production

Die Datenbank ist Convex. `modelScores` bleibt Primary Store; Cloudflare D1 ist ein Score-Mirror für Ranking-Rebuilds. Siehe [convex/schema.ts](../../convex/schema.ts), [convex/scoresWorker.ts](../../convex/scoresWorker.ts) und [infra/scores-worker/schema.sql](../../infra/scores-worker/schema.sql).

Kontrollierte Write-Pfade:

- UI/Convex-Mutationen: `submissions.submitOne`, `submitForBench`, `submitForModel` in [convex/submissions.ts](../../convex/submissions.ts).
- Nach Score-Insert: D1-Mirror und Ranking-Rebuild über [convex/scoresWorker.ts](../../convex/scoresWorker.ts).
- Seed-Style Admin-Pfad existiert in [convex/seed.ts](../../convex/seed.ts) und wurde bereits für Production entworfen: `npx convex run --prod seed:seedAll` und `npx convex run --prod seed:finalize`.
- Production-Frontend nutzt außerhalb von localhost `https://upbeat-clam-790.convex.cloud`, siehe [public/js/convex.js](../../public/js/convex.js).

Nicht geeignet als Schreibpfad:

- Die öffentliche `/v1/*` API ist GET-only. POST/PUT/PATCH/DELETE liefern 405.
- Die öffentliche API ist für Research-Lesen außerdem nicht ideal, weil erfolgreiche Reads Usage/Rate/Audit-Metadaten schreiben. Für diesen Research wurden deshalb Convex-Read-Queries verwendet.

## Empfehlung Vor DB-Write

1. Für DeepSWE zuerst neuen Bench `DeepSWE` anlegen und alle 20 v1.1 `pass@1`-Scores aus der JSON-Datei übernehmen, falls Effort-Konfigurationen in SupraBench wie bisher getrennt modelliert werden.
2. Score-Skala vor Write final festlegen. Konsistent mit dem Seed wäre `scaleMax=1000` und `rawScore=round(pass@1 * 10)`.
3. Fehlende Modellzeilen für Claude Fable 5, Claude Opus 4.8, GLM-5.2, Gemini 3.5 Flash und Kimi K2.7 Code vorab anlegen.
4. Bestehende CAIS- und AA-Benches getrennt als Refresh-Batch behandeln. Die aktuellen Quellwerte weichen an mehreren Stellen vom Seed ab und sollten nicht nebenbei mit DeepSWE vermischt werden.
5. Erst nach Review eine kleine neue Seed-/admin-Mutation schreiben, die idempotent ist und nur neue `(model, bench, sourceUrl)`-Tupel einfügt.

## Neuer Kandidat: SkateBench v2

Quellen:

- Live-Leaderboard: https://skatebench.t3.gg/
- GitHub-Repo: https://github.com/T3-Content/skatebench
- Live-Bundle mit eingebetteten v2-Daten: `https://skatebench.t3.gg/_next/static/chunks/app/page-70668c806a3a990c.js?dpl=dpl_BCExXQstCpNDdRTEDag9tEYvY7nj`
- Screenshot: [skatebench-leaderboard-2026-06-22.png](screenshots/skatebench-leaderboard-2026-06-22.png)

Ergebnis: Ja, ein Leaderboard ist auffindbar und technisch integrierbar. Die Live-Seite nennt `Skatebench v2` und `Success rate based on 390 technical trick definitions`. Die aktuellen 28 v2-Scores sind im ausgelieferten Next.js-Page-Bundle eingebettet. Das im GitHub-Repo committed `visualizer/data/benchmark-results.json` ist dagegen aelter (`2026-02-20`, 24 Modelle, 210 Tests je Modell) und sollte nicht fuer v2 verwendet werden.

Live-v2-Metadaten aus dem Page-Bundle:

- `timestamp`: `2026-03-06T01:30:06.138Z`
- `version`: `2026-03-05`
- `testSuite`: `Skatebench v2`
- `totalModels`: 28
- `totalTestsRun`: 10,920
- Pro Modell: 390 Tests
- Runner-Kontext aus GitHub: `TEST_RUNS_PER_MODEL = 30`, `MAX_CONCURRENCY = 80`, `TIMEOUT_SECONDS = 400`; Correctness ist String-Match auf akzeptierte Antworten plus Ausschluss von `negative_answers`.

Live-v2-Scores:

| Modell-Label Quelle | correct/total | successRate |
|---|---:|---:|
| gemini-3.1-pro-preview | 378/390 | 96.92 |
| gpt-5.4-high | 318/390 | 81.54 |
| gpt-5.4-xhigh | 317/390 | 81.28 |
| gpt-5.4-medium | 306/390 | 78.46 |
| gpt-5.4-pro-thinking | 306/390 | 78.46 |
| gpt-5-high | 302/390 | 77.44 |
| gemini-3-flash-low | 297/390 | 76.15 |
| gemini-3-pro-preview | 297/390 | 76.15 |
| gpt-5-default | 294/390 | 75.38 |
| gemini-3-flash-high | 293/390 | 75.13 |
| gpt-5.1-high | 280/390 | 71.79 |
| gpt-5.2-pro | 280/390 | 71.79 |
| gpt-5.2-xhigh | 269/390 | 68.97 |
| glm-5 | 260/390 | 66.67 |
| claude-4.6-opus-thinking-high | 251/390 | 64.36 |
| grok-4 | 239/390 | 61.28 |
| kimi-k2.5 | 223/390 | 57.18 |
| claude-4.5-opus-thinking-high | 196/390 | 50.26 |
| deepseek-v3.2-thinking-high | 182/390 | 46.67 |
| gpt-5.2-high | 174/390 | 44.62 |
| kimi-k2-thinking | 171/390 | 43.85 |
| gpt-5.2-default | 162/390 | 41.54 |
| gpt-5-mini | 148/390 | 37.95 |
| grok-4.1-fast | 138/390 | 35.38 |
| gpt-5-minimal | 65/390 | 16.67 |
| gpt-oss-120b-high | 64/390 | 16.41 |
| claude-4.6-sonnet | 59/390 | 15.13 |
| minimax-m2.5 | 54/390 | 13.85 |

Integrationsbewertung: nur als Community-/Nischenbenchmark, nicht als Core-Benchmark empfohlen. Score-Skala waere sauber `0..1000` mit `round(successRate * 10)`. Problematisch sind geringe Real-World-Relevanz, Nischenwissen, geringe Transparenz der aktuellen v2-Fragen und ein Snapshot-Alter von 108 Tagen am 2026-06-22.

## Benchmark Quality Ratings

Skala: `1` schwach / niedrig, `5` stark / hoch. `Priority` ist die Integrations-/Gewichtungsprioritaet fuer SupraBench, nicht die Qualitaet allein.

| Benchmark | Relevance | Contam. Resistance | Frontier Discrim. | Reproducibility | Priority | Kurzbegruendung |
|---|---:|---:|---:|---:|---:|---|
| `arc-agi-2` | 2 | 5 | 4 | 3 | 4 | Stark fuer abstrakte Generalisierung, aber indirekte Praxisrelevanz und nicht voll reproduzierbar. |
| `humanity-s-last-exam` | 3 | 4 | 5 | 4 | 5 | Breiter Frontier-Wissenssignal mit viel Headroom; weniger workflow-nah. |
| `swe-bench-pro` | 5 | 5 | 5 | 4 | 5 | Sehr stark: realistische SWE-Aufgaben, Kontaminationsdesign, Headroom. |
| `textquests` | 3 | 2 | 4 | 4 | 3 | Gute Agenten-/Planungsprobe, aber klassische Spiele und Walkthroughs sind kontaminationsanfaellig. |
| `enigmaeval` | 2 | 3 | 5 | 4 | 3 | Sehr harte kreative Multimodal-Raetsel, aber geringere direkte Praxisrelevanz. |
| `intphys-2` | 3 | 4 | 3 | 4 | 3 | Nuetzlich fuer Physik-/Weltmodell, aber synthetisch und teils nahe am Zufall. |
| `swe-bench-verified` | 5 | 2 | 3 | 5 | 3 | Wichtig fuer Vergleichbarkeit, aber oeffentlich, GitHub-basiert und frontier-nahe gesaettigt. |
| `spatialviz` | 3 | 5 | 4 | 4 | 4 | Starkes programmatisch erzeugtes Spatial-Signal; kuenstliches Format. |
| `erqa` | 4 | 3 | 3 | 4 | 3 | Embodied/Robotics-Relevanz, aber Multiple-Choice und moderater Scope. |
| `apex-agents-aa` | 5 | 3 | 5 | 4 | 5 | Hohe Business-Agent-Relevanz und Headroom; oeffentliche Tasks erhoehen kuenftige Kontamination. |
| `mindcube` | 3 | 4 | 3 | 4 | 3 | Gute Spatial-Mental-Model-Abdeckung, aber aktuelle Topwerte wirken weniger frontier-hart. |
| `scicode` | 5 | 3 | 5 | 5 | 5 | Starkes wissenschaftliches Coding-Signal, gute Methodik und Reproduzierbarkeit. |
| `terminal-bench-hard` | 5 | 4 | 5 | 4 | 5 | Hochrelevante Terminal-Agent-Aufgaben mit programmatischer Verifikation. |
| `aa-long-context-reasoning` | 4 | 4 | 3 | 2 | 3 | Relevantes Long-Context-Signal, aber proprietaere Transparenz und Frontier-Clustering. |
| `mmmu-pro` | 3 | 4 | 3 | 5 | 4 | Solider multimodaler Akademik-Benchmark, aber weniger frontier-hart. |
| `tau2-bench-telecom` | 5 | 4 | 1 | 5 | 2 | Sehr praxisnah, aber fuer Frontier-Ranking aktuell stark gesaettigt. |
| `deepswe` candidate | 5 | 5 | 5 | 4 | 5 | Klare Integrations-Empfehlung: aktuelle originale Long-Horizon-SWE-Aufgaben mit breiter Score-Streuung. |
| `skatebench` candidate | 1 | 2 | 2 | 2 | 1 | Technisch integrierbar, aber nur als Nischen-/Community-Kuriositaet sinnvoll. |

Die HTML-Reviewseite mit benchweisen Werten, Links und Screenshots liegt unter [suprabench-prefill-review-2026-06-22.html](suprabench-prefill-review-2026-06-22.html).
