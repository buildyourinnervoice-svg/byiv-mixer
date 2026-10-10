# Build Your Inner Voice: handover, 10 October 2026

This replaces earlier handovers. It's updated after each section of testing, so if a session ends part way through, the "Still to do" list shows exactly where it stopped.

Before any work on BYIV, read `.claude/skills/check-without-being-asked/SKILL.md`. Before writing anything a customer will read, read `.claude/skills/byiv-writing-rules/SKILL.md`. Both are in this repo, and the same two skills are uploaded to claude.ai (Settings, Capabilities, Skills) so every account and the desktop app have them.

## Rules for every session, on every account

1. **Sylvia should never be the one who finds a bug.** After any fix, trace the whole path the order takes, and check every scenario that copies the same logic (Website Orders, Risk-3 Release, Etsy, gifts).
2. **Test like a customer, and vary the choices.** Each test uses a different sound, length, volume and route (member, non-member, gift, Etsy, sport), so fewer tests cover more. Measure the audio, don't just listen to it.
3. **After every Make change**, back up first, then fetch the scenario again and compare it with what you meant to save.
4. **Make traps that have caused real faults:** `and` / `or` inside `{{ }}` are always true (use `&` and `|`). A filter operator that doesn't exist saves without complaint and never passes. A module talking to Etsy, Stripe or HTTP without an error handler can switch the whole scenario off.
5. **Use test accounts only** (listed in the QA skill), and delete test rows afterwards.
6. **The repo is public.** Never commit keys, team codes, webhook links or customer details.
7. **Credits:** big blueprint uploads (60 to 90 KB) are the most expensive thing a session does. Make each change in the smallest scenario that can carry it.

## What was fixed on 10 October

| Area | Problem | Fix | Tested |
|---|---|---|---|
| Volume | Since 3 October every order was mixed at Whispered, whatever was chosen | Volume rule rewritten in Website Orders and Risk-3 Release | Clear about -19, Whispered about -40.8, Subliminal about -32 LUFS, backgrounds checked too |
| Gifts with a date | The hold step used an invalid operator, so dated gifts skipped the hold and went to the buyer as "Someone" | Hold step rebuilt in Website Orders | Held, then delivered "To you, from Jane" with the card |
| Etsy | One Etsy "mark complete" error switched Track Delivery off for everyone | Error handlers on every Etsy step (Track Delivery, Etsy Consent) | Fake receipt failures now alert and carry on |
| Etsy sounds | "Rain" and differently capitalised answers weren't recognised | Sound and volume lookups made case-insensitive, "Rain" added | Live Etsy Orders compared after saving |
| Etsy buyer name | Gift emails said "Someone" | Buyer first name passed through Etsy Consent | "Jane has sent you a gift" |
| Christmas cards | Planner gifts missed the card | Card shown for Secret Santa, Christmas words, or a send date from 1 November to 6 January | Planner gift emails checked |
| Sport practice sheet | Etsy sports tracks and all gift emails had no practice sheet | Etsy Consent sends focus "Sports confidence" for the 2 sports listings, and Gift Delivery shows the sheet for sports gifts | Netball (not a gift) and cross country (gift) both got the link |
| Sport safety | The safety rules (no weight or food, no pushing through pain, injuries) only applied to sport members | Now in the sport rule for every sports track, plus "never write what their body knows" | Prompt saved and compared |
| Dashes | Affirmations sometimes contained em dashes | Website Orders prompt forbids them, and any that slip through become commas | Saved and compared |

## Etsy test harness (no buying needed)

The "TEST - Etsy Orders" scenario takes fake receipts on its own webhook and sends every email to Sylvia. Script: `send_receipts.py` in the session scratchpad (not in the repo because it contains the webhook link). Use receipt ids from 9000000001 and the +etsytest / +etsygift addresses, then clean up data stores 195099, 195100 and 145519. The TEST copy still has the old sound list, so "Rain" fails there but works on the live scenario.

## Waiting for a decision or not done

- **Risk-3 Release (6570132)** has a prepared but unsaved update: the no-dashes rule, the menopause line and the sport safety rules. It's lower priority because those orders are reviewed by hand first.
- The buyer email for a "they choose" gift says "On 10 October we'll email them", but the invite actually goes at 09:15 the next morning.
- The Risk-3 Release background list has no "Surprise", so a released Surprise order gets ocean waves.
- 3 website consent records from 23 September have an empty email.
- The Etsy connection can't read listings (optional, not needed for orders).
- Gift recipients of non-sport tracks don't get the topic practice sheet that people buying for themselves get.
- Two gift emails (the "they choose" confirmation in Website Orders, and "Your gift has been opened" in Gift Redemption) say membership gives "unlimited tracks", but members are limited to 3 a day. The copy needs to match the limit, or the limit needs to change.

## Still to do (memberships)

Main rule from Sylvia: test anything a customer can buy or use as part of any membership.

- [x] Normal membership, tested 10 October with your own account:
  - 4th track in a day stopped, with the limit email
  - Member track (Binaural beats, 30 minutes, Clear, Money & abundance): 30:00 exactly, -18.8 LUFS, the affirmations followed the brief, and the practice sheet link works
  - Membership page access check right for personal, sport and a wrong key
  - "What we hold about you" arrived within seconds
  - 5 minute reset ("Awake in the night") returned a guide, audio and an inbox copy, with no dashes
  - Not tested this round: joining through Stripe, cancelling, preferences and the planner (website planner gifts were tested earlier in the day)
- [x] Sport membership, tested 10 October with the +sporttest account:
  - Choosing a sport (Padel) saved
  - Membership page shows plan "sport" and tracks left
  - Sport Sheet Writer wrote a rowing sheet for the member and refused a wrong key
  - Member track (Ambient meditation, 5 minutes, Clear, padel serve): 5:00 exactly, -19.1 LUFS. It follows the new sport rules (it opens "I know this game", with no "push through") and has the practice sheet link
  - 5th track in a month stopped, with the monthly limit email
  - Not tested this round: the sport planner, and joining through Stripe
- [x] Employee membership, tested 10 October on EMP-TEST-INTERNAL only, and cleaned up afterwards:
  - Fresh activation worked: the welcome email arrived and the membership page showed "workplace" with the company name
  - The same person again got "already a member" and their link re-sent
  - A wrong code was refused, and a lowercase code works
  - A full team was refused, and so was a paused team
  - A team session ("Pre-mortem" for a month-end deadline) was written for the team, with no dashes
  - Not tested this round: freeing a seat at /manage and reusing it, and the employer's own emails
  - The welcome email says "Unlimited tracks in any length, up to 3 a day", which contradicts itself. Suggest "Up to 3 tracks a day, in any length".
- [ ] Scheduled jobs and watchdogs
