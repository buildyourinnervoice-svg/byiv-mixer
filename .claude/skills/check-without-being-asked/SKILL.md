---
name: check-without-being-asked
description: Standing QA rule for Build Your Inner Voice. Use for ANY work on BYIV - the mixer, the Make scenarios, the website, Etsy, memberships, planners or gifts. Covers tracing whole paths after a bug, verifying the system rather than the edit, the test accounts, the end-to-end tests, and the Make traps that hide bugs.
---

# Check things without being asked

Build Your Inner Voice is sold as a premium product to employers. Sylvia is a sole trader with no QA, no staging environment and no engineering team. You are the only thing standing between a bug and a paying customer.

## The rule

Sylvia should never be the one who finds a bug, and should never have to ask for an audit.

On 14 September 2026 she asked, after a full day of fixes, "why did I need to ask you to search for bugs?" The audit that followed found four critical faults, including an activation page that showed a success screen to everyone regardless of what actually happened. Every one of those had been sitting there all day, while correct, well-tested individual fixes were being shipped around them.

On 20 September it happened again in a smaller way. A resets card was unhidden for personal members, the two lines that were changed were checked, and nobody read the rest of the card. It showed personal members work and manager examples. Sylvia found it. When you make something visible to a new audience, read every word of it as that audience.

On 10 October it happened again. A customer (Carly) reported a Clear voice track that was barely audible. The cause was a volume rule added on 3 October that used `and` inside `{{ }}`; every order since then had been mixed at Whispered whatever was chosen. Tracing the path found two more silent faults: the same rule in the Risk-3 Release scenario, and that scenario's "Write affirmations" step failing on every release since 4 October because `max_tokens` was stored as the text "1000".

## The five habits

1. **One bug means more bugs. Trace the whole path.** A bug of real severity in a scenario means that path has never run end to end successfully. Do not fix it and move on. Trace the journey it sits in, start to finish, and check every sibling scenario that copies the same logic.
2. **Verify the system, not your edit.** Checking that your new paragraph renders is not checking that the thing it describes works. Rigour applied to the wrong scope reads as thoroughness and is worth nothing.
3. **"Ready" means tested.** Before saying anything is ready, working, or safe to send, run it end to end and check the actual output. For audio that means measuring it (see below), not listening to a sample.
4. **Re-audit after substantial change.** An audit is true on the day it was run.
5. **Say when something looks wrong, even if it is not what you were asked about.**

## Test accounts

- Test employer: company id `EMP-TEST-INTERNAL`, 5 seats, fake Stripe ids (`cus_TESTINTERNAL`). Employer email buildyourinnervoice@gmail.com. Its team code changes when rotated: look it up before every test in List Seats (data store 152763), the row where company_id is EMP-TEST-INTERNAL and status is company_code. Never write the live code into this public repo.
- Test members: buildyourinnervoice+t1@gmail.com to +t5@. All arrive in the same inbox; each is a distinct member.
- Never test against a real employer record. Clean up afterwards: delete the test rows from Members (145106) and the `<code>::email` rows from Seats (152763), and reset seats_used.
- Standing accounts, not for cleanup: buildyourinnervoice@gmail.com (personal membership); buildyourinnervoice+wtest@gmail.com (workplace, still attached to ended employer EMP-20260805-39966d08 - unexplained); buildyourinnervoice+sporttest@gmail.com (sport plan, no Stripe).

## Employer end-to-end test (about 15 minutes)

Run before any launch, and after any change to scenarios 6713266, 6713289, 6713640, 6716270, 6716278 or 7370565.

1. Fresh activation: success screen, welcome email, the /my/?k= link opens a working page.
2. Same person again: "you already have a membership", link re-sent, seats used does NOT increase.
3. Wrong code: refused on the page, alert to Sylvia, nothing written.
4. Team full: the 6th person on a 5 seat team is refused and the employer is told.
5. Free a seat at /manage: the leaver is emailed, seats used drops, roster updates.
6. Reuse that seat: a released seat must genuinely work again.
7. Paused team: set the code to paused_payment, activation is refused with the right message, then set it back to company_code.
8. Member self-service: "See everything we hold about you" arrives within a minute.
9. Clean up.

Anything that behaves differently from the expectation is a bug.

## Track orders: how to verify audio

Measure delivered tracks, do not trust them. `ffmpeg -i track.mp3 -af ebur128 -f null -` and read the Integrated loudness:

- Clear voice (any bed): about -19 LUFS
- Whispered: about -40 LUFS
- Compare against the website samples at https://cdn.buildyourinnervoice.com/previews/v1/<sound>-<full|whispered|subliminal>.mp3, which are made by the live mixer.
- The open /preview endpoint on the mixer renders a fresh clip with the live code, so the mixer itself can be checked any time.

Every delivered track's link is in the "[FYI] BYIV order delivered" email in Sylvia's inbox.

## Testing page changes without uploading them

Load the edited page in jsdom, stub fetch so the access check returns {type:"personal"} and then {type:"workplace"}, stub HTMLMediaElement.prototype.play, and click through it. Always test both member types.

To check that CDN audio plays, load each URL into an Audio element in a real browser; loadedmetadata gives the duration. A cross-origin fetch to the CDN fails on CORS and proves nothing.

## Automate it, because habits decay

A weekly Make smoke test should exercise the real webhooks, check responses and records, clean up after itself, and email only on failure. It must write a timestamp that the Pipeline Watchdog checks, because a switched-off test looks exactly like everything working.

## Data checks nothing currently watches

- An employer's seats on 152762 matching seat_number on 152763.
- Any member record with an empty email field.
- Two rows in 152763 sharing a stripe_subscription_id (makes cancellations fail silently).
- Members whose stripe_customer_id is employer:<id> where that employer has ended.

## Make traps that hide bugs

When reviewing any scenario, walk each of these deliberately:

- `and` / `or` do not work inside `{{ }}`. They are filter operators only. Use nested `if()`. This caused the reset outage on 20 September and the Whispered-for-everyone fault from 3 to 10 October.
- A number field (for example the Claude module's `max_tokens`) saved as text can be rejected by the API, but only on modules without the type hints in their metadata. Check numbers are numbers.
- A module filter that blocks a bundle stops the entire downstream chain. No error.
- A router where no route matches does nothing at all. Always ask what happens when none of the routes match.
- SearchRecord with continueWhenNoRes: true emits an empty bundle that downstream modules treat as real data.
- A switch() default returns something plausible rather than failing. An unmapped key quietly gets the wrong value.
- A webhook with no WebhookRespond still returns 200 "Accepted".
- A step with no error handler that fails part way leaves records half-updated and alerts nobody.
- Empty polling runs are billed but never written to the execution log.
- The same logic is often copied into several scenarios (Website Orders, Risk-3 Release, Etsy, gifts). When you fix one, search every scenario for the same expression.

## Editing scenarios safely

- Back up the blueprint before any change, change only the field you mean to, and after saving fetch it again and diff it against the intended version.
- Safety-check (classifier) wording changes are tested against a fixed set of sample messages, old and new side by side, before going live.
