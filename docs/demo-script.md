# Demo script

Target 17 minutes. Start the demo using the [README](../README.md) and run `npm run demo:history` in a second terminal against the same database. Use Chrome or Edge with separate normal and private windows or separate browser profiles. Each role needs its own cookie jar. Click **Fill form** on a sample account, then **Sign in**. The included samples are Ravi (employee), Arjun (technician) and Anita (administrator). When automatic assignment picks a different technician, check **Users** and sign in as the selected technician using the shared demo technician password.

## 0–5 min · Report, prioritize, assign, notify

1. Keep Anita's Dashboard open in one window so its **Live** indicator is visible.
2. As Ravi, report a Corporate Network / VPN incident with a descriptive title, urgent details and affected users. Try **Suggest category** before submitting.
3. Open the new ticket. Point out the category, priority, deadlines, assignee and history. Explain which priority strategy and assignment strategy decided.
4. Watch the administrator dashboard total and live toast update. Open **Outbox** then switch between simulated email and SMS after an urgent report. Check one inbox item as read and watch the unread badge change.

## 5–11 min · Investigate, pause and resolve

1. Sign in as the technician assigned to the new ticket. Open **My Incidents**, filter by ID, acknowledge it and start investigation.
2. Select **Request info**. Show the pending status, pause and unchanged response deadline. Leave the technician window visible.
3. Reply as Ravi. The technician detail refreshes and the resolution deadline extends by the paused time.
4. Resolve as the assigned technician. Verify as Ravi, provide a rating, and close as the technician or administrator. Review the ticket history and an appropriate SLA status.
5. Show **My Workload** to explain why resolved work releases a capacity slot.

## 11–17 min · Duplicate, outage, escalation and predicted resolution breach

1. Reset the simulated clock in Settings if it was advanced. Submit a P1 Payment Gateway ticket using CRITICAL impact and urgency. The synthetic history has enough comparable Payment Gateway cases to show the forecast.
2. In the administrator dashboard, open **Predicted resolution breaches** and click the new ticket. Explain the observed base rate, elapsed conditioning and any displayed adjustments. Use **Run SLA / escalation check** to generate the prediction notification before advancing the clock.
3. Report an identical Payment Gateway incident to trigger the duplicate prompt, then confirm or choose a distinct title. Submit distinct reports until at least three open tickets share the service within the hour. Show the live suspected-outage banner and the admin audit log.
4. Leave one new P1 ticket unacknowledged. Press **+5 min** to reach the response deadline, **+15 min** to reveal later escalation, and **+60 min** to reach the top escalation level. Recent events, deadlines and related IDs appear in the dashboard, inbox and Outbox. **Reset clock** restores the offset. Recorded events remain in history.
5. Return to the code or class diagram. Point out the strategy registries, event observer, committed SSE channel and pure prediction class. Mention that each alert is written once and that using two processes would need a shared live-event source.
