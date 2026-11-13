# Morning brief

The user's day at a glance, sent by the 早晨簡報 schedule at 08:00, or when the user asks for today's brief. Also how
to set up the daily rhythm when the user accepts it.

## 1. Gather, in one codemode script

Ask for every source together (`Promise.all`); a source that fails or is not there is a gap to report, not a reason to
stop:

- Calendar: today's events, and tomorrow before 10:00 (`read_calendar_events`).
- Items: open items of every bot (`list_items` with `all`) that are due today, overdue, or waiting on someone.
- Notifications: the ones still on the phone from people and apps that need an answer (`read_notifications`); skip
  ads, codes, and system noise.
- Mail: unread mail that needs a reply or a decision, if a mail service is connected (an `mcp__` tool; find it with
  `searchTools("mail")`).
- Weather where the phone is, only when it changes what to wear or carry (rain, a big swing in temperature).

Use only what this bot can reach. Never guess what a source would have said.

## 2. Write

1. First line: the gist in at most 20 characters, such as 「今天三個會，10:00 最早」.
2. Then at most five short lines, by time and by what the user has to do: meetings with their time, what is due, who
   is waiting for an answer. Leave out what needs nothing from the user.
3. Last line, only if something was missing: what you could not see and why, in one line, such as
   「沒看到信箱：這個 Bot 沒連信件服務。」 or 「沒有日曆權限。」.

Nothing on: say so in one line. Then `notify` the first line and the most urgent item; skip the notification between
23:00 and 08:00 (a late run after the phone was off) and when the user has nothing today.

## 3. Setting up the daily rhythm

Only after the user said yes to it (好). Create three schedules with `create_schedule`, `on: "time"`, every day:

| name | time | prompt |
|---|---|---|
| 早晨簡報 | 08:00 | Read the morning-brief skill and give today's brief. |
| 白天巡視 | 13:00 | Read the daytime-check skill and follow it. |
| 白天巡視 | 18:00 | Read the daytime-check skill and follow it. |

Nothing runs between 23:00 and 08:00. If one fails (too many schedules), say which and stop.

Then tell the user in one short paragraph, without a list: you will brief them every day at 08:00 and the first brief
is on which day (today if it is before 08:00 now, else tomorrow; give the date and weekday); at 13:00 and 18:00 you take
a look and notify only when something needs them, and stay silent otherwise; they can pause or delete these in
設定 › 自動化. Mention a source you cannot reach yet (calendar, notifications, mail) in one clause.
