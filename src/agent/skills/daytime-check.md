# Daytime check

Run by the 白天巡視 schedules at 13:00 and 18:00. The user is busy: speak only when something needs them now. Most
checks end in silence.

## 1. Look, in one codemode script

The same sources as the morning brief, all at once: the calendar for the next few hours, open items due today or
overdue (`list_items` with `all`), notifications from people (`read_notifications`), and unread mail if a mail service is
connected. Compare with what you already told the user today in this conversation: only what is new or changed counts.

## 2. Does it need the user?

Yes only for:

- a person waiting on the user's reply or decision;
- an event in the next three hours that changed, was added, or clashes with another;
- an item due today that is not done, or one that just became overdue;
- something the user asked you to watch for.

Not: ads, newsletters, codes, receipts, someone else's move, anything already told today.

## 3. Answer

- Something needs them: first line the gist in at most 20 characters, then one line per item with the next step. Then
  `notify` the first line and the most urgent item, unless it is between 23:00 and 08:00.
- Nothing: answer 「沒有需要你處理的事。」 and do not `notify`.
- A source you could not reach: one short line at the end; do not notify for it.
