# Priority strategies

Both strategies implement `PriorityStrategy.evaluate`. The return value provides a priority and the reason recorded in the audit history. Priority selects the P1–P4 SLA targets from the service’s policy or the configured default.

## Weighted priority

The four impact, urgency and business criticality levels are encoded from 1 for LOW to 4 for CRITICAL.

```text
score = impact × urgency × business criticality × affected-users multiplier
```

| Users affected | Multiplier |
| -------------: | ---------: |
|            1–9 |       1.00 |
|          10–49 |       1.25 |
|         50–199 |       1.50 |
|    200 or more |       2.00 |

P1 starts at 36, P2 at 18, P3 at 6 and lower scores are P4. A high-impact and high-urgency ticket on a critical service reaches 36 even with one affected user. This calculation balances the three severity inputs with the size of the impact.

## Rule-based priority

The first matching rule wins.

| Priority | Condition                                                |
| -------- | -------------------------------------------------------- |
| P1       | Critical service and critical impact                     |
| P1       | Security category and high or critical impact            |
| P1       | At least 200 affected users and high or critical urgency |
| P2       | High or critical impact and urgency                      |
| P2       | High or critical service and at least medium impact      |
| P3       | At least medium impact or urgency                        |
| P4       | Default                                                  |

The administrator selects the strategy in Settings. A priority override on an open incident updates the existing SLA from its original start and retains the recorded pause duration and earlier findings. The SLA forecasting model is a separate operational signal. [Priority implementations](../server/priority/strategies.js)
