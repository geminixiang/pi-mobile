# Spoken report

For anything said with `speak`: a headphones schedule's briefing, or when the user asks to hear it. The listener hears
it once, while walking or commuting, and cannot scroll back. A written report that is read aloud fails: it has too
many items, identifiers, and caveats to follow by ear.

## 1. Decide before you write

Gather everything, then decide: **what must the user do or know today?**

- Pick **at most three** items, by urgency and by whether the user is the one who has to act. Anything that is someone
  else's move, unchanged since the last report, or only for reference is left out of the speech.
- Find the **bottom line**: one sentence the user should remember if they hear nothing else.
- Everything left out still goes in the written answer, with its links.

## 2. Shape

1. **Opening, one sentence:** the bottom line and how many items. 「今天有兩件事要你處理，最急的是換資料庫密碼。」
2. **One paragraph per item, two or three sentences:** what it is in plain words, why it matters now, and the one next
   step. Start each with a signpost: 「第一件」「第二件」「最後」.
3. **Close, one sentence:** the actions again. 「所以今天先排密碼輪替，再回 gateway 那張單。」
4. If items were left out: one sentence. 「其他四件不急，細節在對話裡。」

Nothing important: say so in one or two sentences and stop. 「今天沒有新的事要你處理。」

## 3. Length

About a minute: **250 to 400 Chinese characters**. Never over 600, even when a schedule's prompt asks for longer: a
longer report gets more items, not more words per item, and more items is what the listener cannot follow. If it is
longer, cut items, not words.

## 4. Write for the ear

- Short sentences, one idea each, about 25 characters at most. Subject first, then the verb.
- **No identifiers.** No issue or PR numbers, URLs, repo paths, file names, environment variables, ids, or code.
  Name a thing by what it is about: 「Slack 個人 token 那件」, not 「followups 第一百八十一號」.
- Round numbers that are not the point: 「六十多張」「每月省兩百多美元」. Say times as spoken: 「早上十點半」.
- Avoid acronyms the voice reads letter by letter, unless the user says them that way (PR, API are fine).
- People: name someone only when the user has to deal with them.
- No parentheses, slashes, dashes, lists, or markdown: the voice reads them oddly or skips them.
- Separate the parts with a blank line: the phone pauses there, which helps the listener hear the structure.

## 5. Leave out

- How you worked: what you searched, which account you checked, how many results, which tools.
- Coverage and caveats, unless one changes what the user should do; then one sentence.
- Corrections of earlier reports, unless the user acted on the earlier one.

## 6. Check

Could the user, hearing it once on the street, repeat the bottom line and what to do first? If not, cut more.

## Example

Too much (read-out written report):
> 早安，GitHub 工作重點有五組。已確認登入帳號是 geminixiang。第一，憑證處理是目前最值得優先安排的事。followups 第一百八十一號，最新留言已把範圍收斂成六項……這次搜尋到五十九張指派給你的開放項目、八十一張提及你的開放項目……

For the ear:
> 早安。今天有兩件事要你處理，最急的是換掉外洩風險最高的憑證。
>
> 第一件，憑證輪替。共用的資料庫密碼和一個還有效的 Slack 個人 token 列為最優先。今天要排一個時段，讓用到資料庫的服務一起換密碼。
>
> 第二件，gateway 授權那張單還在等你回覆。你要說清楚，名單交給 agent-pm 管，gateway 只負責驗證身分。
>
> 所以今天先排密碼輪替，再回 gateway 那張單。其他三件不急，細節在對話裡。
