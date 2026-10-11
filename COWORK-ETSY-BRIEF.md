# Brief for Claude Cowork: check the Etsy listings (look and report only)

Written 11 October 2026 for Build Your Inner Voice. This is the only task. Ignore everything else in HANDOVER.md.

## Why

Etsy buyers currently get an email asking them to tap a link to give consent before their track is made. People miss it, orders get refunded and sales are lost. Sylvia wants consent given on the Etsy order itself instead. Before anything changes, we need to know exactly what Etsy's listing editor allows.

## The one rule

**Look, don't save.** Do not save any change to any listing. The Etsy Orders scenario in Make finds each buyer's answers by the exact wording of each box label. If a label changes before that scenario is updated, orders stop working. A later session updates the scenario first, and the labels change after that.

## What to check, on each track listing (normal, gift and Christmas)

Open each listing in Etsy's listing editor and write down:

1. **The variations.** How many there are, their names and their options. At the moment there seem to be 2, sound and volume. Is a 3rd variation possible?
2. **The personalisation boxes.** How many boxes there are, the exact label of each one, the character limit, and whether each one is required.
3. **Whether a separate consent question is possible** without losing anything. That could be a 3rd variation, an extra personalisation box, or a required tick box. If a separate required box is possible, that's the preferred option.
4. **Gift and Christmas listings only:** whether there's room for one more box, "Their first name", like the planner listings already have. At the moment the gift email says "To you, from Sylvia" because there's no first name.

## The wording Sylvia has already approved (for reference, don't apply it)

If a separate consent box isn't possible, the consent goes into the label of the box buyers already fill in:

- Track listings: "What would you like this track to work on? By writing here, you agree we can use it, including any health details, to make your track."
- Gift and Christmas listings: "Tell us about them and what you'd like their track to help with. By writing here, you agree we can use it to make their track, and you haven't included anything about their health."

## What to report back

For each listing, give the listing title and link, the variations with their options, every personalisation box with its exact label, character limit and whether it's required, and yes or no for questions 3 and 4 (with how, if yes). Exact label text matters, so copy it character for character. Also note anything that looked like it would lose existing information if changed.

Give the report to Sylvia. A Claude Code session will then update the Etsy Orders scenario (Make 7001679) to read the new labels, keeping the old ones as fallbacks, and test it with fake receipts. After that, the labels are changed on Etsy and one real test order is placed.
