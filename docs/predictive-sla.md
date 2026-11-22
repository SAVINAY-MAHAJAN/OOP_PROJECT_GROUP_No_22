# Predictive SLA violation detection

The forecast estimates the chance that an open incident will miss its **resolution** target. The deadline-based SLA status still records whether either contractual deadline is approaching or breached. Forecasts appear in incident details, on the administrator dashboard and in one alert per eligible incident.

## Model

1. Use up to 500 of the most recent closed incidents with a recorded resolution time. Prefer the same service and priority when at least five valid cases exist. Otherwise use the same priority across services with at least five valid cases. With fewer than five, start at a 25% prior.
2. Compare each historical active resolution duration with the current case's resolution target. For example, if three of five durational comparisons exceed a 30-minute target, the base rate is 60%.
3. Condition on the amount of active work time elapsed. Keep historical cases whose active duration exceeded that elapsed time. If three of four remaining comparisons missed the target, the forecast before adjustments becomes 75%. If there are no surviving comparisons, retain the base rate.
4. Apply the adjustments below and clamp the result to the interval 0–100%. Active elapsed time excludes completed pauses and freezes at the start of a current pause.

| Factor                                                |            Adjustment |
| ----------------------------------------------------- | --------------------: |
| Assignee is at 80% capacity or higher                 | +10 percentage points |
| Still unacknowledged past half of the response window | +15 percentage points |
| Waiting for reporter information                      | +10 percentage points |
| Already escalated                                     | +10 percentage points |

LOW is below 40%, MEDIUM covers 40% up to 70%, and HIGH starts at 70%. The alert threshold is independently configurable from 10–99% and defaults to 70%. The dashboard counts all qualifying open incidents and lists the eight highest forecasts. A response violation can coexist with an actionable resolution forecast. Once a resolution target has been missed, its SLA status records the outcome and the forecast is removed.

The monitor loads history once per pass. It records `SLA_RISK_PREDICTED` and the `sla.riskNotified` flag in the same transaction, then saves in-app and simulated email notices for the assignee and administrators. It preserves the flag through priority changes, reopen and retries. Connected recipients receive a committed live update.

## Demonstrate

With a local demo running, `npm run demo:history` adds 30 labelled, synthetic closed incidents. Repeat runs add only missing rows. Report a new critical Payment Gateway ticket to see an example with a high-risk service cohort. Check the incident's factor list against the dashboard and use **Run SLA / escalation check** to trigger the alert.

This is a deterministic empirical estimate with heuristic adjustments. Small cohorts can move abruptly as elapsed time increases. Its probabilities are uncalibrated on external operational data. Synthetic histories support a repeatable demonstration. [Predictor](../server/sla/predictor.js) · [Forecast queries](../server/sla/risk-service.js)
