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
| Gift practice sheets | Gift recipients got no practice sheet | Gift Delivery now adds the topic sheet (12 topics) or the sport sheet | "Sleep" gift showed the Sleep sheet link |
| Employee welcome | "Unlimited tracks in any length, up to 3 a day" | Now "Up to 3 tracks a day, in any length" | Saved and compared |
| Same-day gifts | A gift dated today waited until 09:00 (made for them) or 09:15 (they choose) the next morning | Track Delivery and Website Orders now start Gift Delivery or Gift Invite Sender straight away when the date is today. This uses credits only on those orders, and the morning runs stay as a backup. Buyer emails now say "later today" | Made-for-them gift arrived 2 minutes after ordering, and the they-choose invite 2 seconds after |
| Volume note in delivery emails | People who chose Whispered or Subliminal could think the track was broken | Track Delivery and Gift Delivery show "How your track sounds" for Clear, Whispered or Subliminal, and the gift store now has a volume field. The mixer now sends the volume back (merged to main and deployed on 10 October) | Whispered member track email showed the note |
| Gift cancel link | A large "Cancel this gift" button | Now a small grey line under the sign-off | Saved and compared |
| Dashes | Affirmations sometimes contained em dashes | Website Orders prompt forbids them, and any that slip through become commas | Saved and compared |

## Etsy test harness (no buying needed)

The "TEST - Etsy Orders" scenario takes fake receipts on its own webhook and sends every email to Sylvia. Script: `send_receipts.py` in the session scratchpad (not in the repo because it contains the webhook link). Use receipt ids from 9000000001 and the +etsytest / +etsygift addresses, then clean up data stores 195099, 195100 and 145519. The TEST copy still has the old sound list, so "Rain" fails there but works on the live scenario.

## Waiting for a decision or not done

- **Risk-3 Release (6570132)** has a prepared but unsaved update: the no-dashes rule, the menopause line and the sport safety rules. It's lower priority because those orders are reviewed by hand first.
Left for another session because each one needs a large blueprint upload for a small effect:
- **Risk-3 Release (6570132), one upload for all of these.** Its background list has no "Surprise", so a released Surprise order always gets ocean waves (copy the Surprise switch from Website Orders module 20). Also add the sport safety rules, the no-dashes rule and the menopause line, which are all prepared in the session scratchpad as r3-new-1840.json. These orders are reviewed by hand first, so they're rare.
- **Personal welcome email (Membership Stripe events, 6574497).** It still says "Unlimited tracks in any length, up to 3 a day". Change it to "Up to 3 tracks a day, in any length" to match the employee email, which was changed on 10 October.
- **3 website consent records from 23 September have an empty email.** These are most likely early test rows. They're harmless and can be deleted from the consent log.
- The Etsy connection can't read listings (optional, not needed for orders).

## Not yet tested (next session)

- Joining and cancelling through Stripe, for both personal and sport (needs a real or test card)
- The member preferences page, and emailing the planner PDF
- Freeing a seat at /manage and reusing it, and the employer's monthly report
- Scheduled jobs and watchdogs (weekly smoke test, gift expiry sweeper, welcome guides)

## Still to do (memberships)

Main rule from Sylvia: test anything a customer can buy or use as part of any membership.

- [x] Normal membership, tested 10 October with your own account:
  - 4th track in a day stopped, with the limit email
  - Member track (Binaural beats, 30 minutes, Clear, Money & abundance): 30:00 exactly, -18.8 LUFS, the affirmations followed the brief, and the practice sheet link works
  - Membership page access check right for personal, sport and a wrong key
  - "What we hold about you" arrived within seconds
  - 5 minute reset ("Awake in the night") returned a guide, audio and an inbox copy, with no dashes
  - 66 day planner (walking at lunchtime) built 66 days around the brief, starting with a "noticing" week, with no dashes
  - Not tested this round: joining through Stripe, cancelling, preferences, and emailing the planner PDF
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
- [ ] Scheduled jobs and watchdogs

## Next session: Etsy consent without the tap (Sylvia's priority)

Sylvia doesn't want buyers to have to tap a link in an email, because people miss it, get refunded, and sales are lost. The tap link also shows a hook.eu1.make.com address, which looks wrong to buyers. Etsy only allows 2 dropdown options per listing, and both are used (sound and volume), so a consent dropdown won't fit.

Agreed direction: put the consent in the label of the text box the buyer already fills in. For example "What would you like this track to work on? By writing here, you agree we can use it, including any health details, to make your track." Gift and Christmas listings: "...By writing here, you agree we can use it to make their track, and you haven't included anything about their health." (Suggest Sylvia checks the wording with a GDPR adviser.)

Sylvia approved this wording on 10 October:
- Track listings, the box label: "What would you like this track to work on? By writing here, you agree we can use it, including any health details, to make your track."
- Gift and Christmas listings, the box label: "Tell us about them and what you'd like their track to help with. By writing here, you agree we can use it to make their track, and you haven't included anything about their health."

**For Claude Cowork on Sylvia's other account:** open each Etsy listing in the listing editor and check whether Etsy allows a separate consent question without losing anything. That could be a third variation, an extra personalisation box, or a required checkbox. Etsy currently seems to allow only 2 variations, and both are used for sound and volume. If a separate required box is possible, it's the safest form of consent and is preferred. Otherwise, use the label wording above. Either way, don't save any change to a box label until the Etsy Orders scenario has been updated to match (see the steps below), or orders will stop.

**Also for Cowork: a recipient name box.** Etsy gift and Christmas track listings don't ask for the recipient's first name, so the gift email says "To you, from Sylvia" instead of "To Ame, from Sylvia". Check whether there's room for one more box, "Their first name", like the planner listings have. If there is, add it, then in the same Etsy Orders upload read it into recipient_name (Website Orders already uses question_PlodEb for the name).

Order of work, because Etsy Orders finds answers by the exact box label:
1. Sylvia sends the new label wording first.
2. Update Etsy Orders (7001679) module 3 raw_focus to read the new labels (keep the old ones as fallbacks). Then, instead of the consent email (module 42), record consent in 195100 and hand the order to Website Orders directly, as Etsy Consent 7554991 does after a tap. Copy the change to the TEST Etsy scenario and test with fake receipts.
3. Sylvia changes the labels on Etsy.
4. One real test order.
If the tap is kept for any listing, move the link to a page on the website (buildyourinnervoice.com/confirm) instead of the raw Make address.

The first real Etsy order (10 October, receipt 4197027741) parsed correctly in every field: Rain, Barely there, gift email with no date (sent today), Christmas, sports. After the tap it went through end to end. The gift arrived 1 minute later with the right message, sports affirmations, the subliminal "How your track sounds" note and the sport practice sheet. The buyer got "Your gift has been delivered", and no "not marked complete" alert was sent, so the Etsy order was marked complete.

Etsy notes:
- "Buy it now" did nothing for Sylvia until the item was put in the basket, even with every box filled. This is on Etsy's side. Check it on the phone app, and report it to Etsy if it happens there too.
- Etsy Orders checks for new orders once an hour.

## Watch in future tracks

- The affirmation writer sometimes still writes "my body knows" and negations such as "do not keep me wired" in non-sport tracks (seen in a Sleep track on 10 October). Consider adding a final self-check line to the prompt.

## Decisions

- "Unlimited tracks" is fine in customer copy. The 3 a day limit is fair use and is covered in the terms, so don't flag the wording again.
