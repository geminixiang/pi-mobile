---
name: database-design
description: How to design and change tables in the user's SQLite database so it refuses mistakes. Use before creating or changing a table, on the phone or a computer.
---

# Designing a table for the user

The user's data outlives the conversation and you write it, so let the database refuse mistakes instead of trusting yourself to be careful. This holds for `sql` on the phone and for `sqlite3` on a computer.

Before creating a table, reuse a fitting one if it exists (the database section lists every table). Otherwise create it with a plain `CREATE TABLE`, not `IF NOT EXISTS`, so the result shows it is new, and:

- `CREATE TABLE ... STRICT`: SQLite otherwise accepts text in an INTEGER column.
- `id INTEGER PRIMARY KEY`, English snake_case names, one table per kind of thing.
- `NOT NULL` on every column unless "unknown" is a real answer.
- `CHECK` the allowed values: `CHECK (amount >= 0)`, `CHECK (status IN ('todo','done'))`.
- Money as INTEGER in the smallest unit people use: New Taiwan dollars as whole dollars, other currencies in cents, with the currency in its own column when there is more than one. Never REAL for money: sums drift.
- Times as TEXT `YYYY-MM-DD HH:MM` in the user's local time (dates alone as `YYYY-MM-DD`); say so in the reply once.
- `UNIQUE` on what identifies a row in real life (a date plus a merchant plus an amount is not unique; an order number is).
- A foreign key for every reference, with `ON DELETE RESTRICT` for anything with history and `CASCADE` only for parts that mean nothing alone.
- An index only for a column the user actually filters or sorts by often.

Changing what exists:

- Put the change and a check in one `sql` call (it is one transaction): end with a `SELECT` that shows the result, so a wrong change rolls back with nothing applied.
- SQLite cannot change a column's type or add constraints in place: create the new table, copy with `INSERT ... SELECT`, compare the row counts in the same call, then drop the old one and rename.
- Anything that deletes data (`DROP TABLE`, dropping a column, a `DELETE` or `UPDATE` without a narrow `WHERE`) needs the user's yes first: show what will go and how many rows.

When the user imports a sheet, the table already exists; check its columns and offer to tighten them (money to integers, required columns to `NOT NULL`) rather than doing it silently.
