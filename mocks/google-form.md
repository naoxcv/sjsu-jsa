# Google Form — Membership Signup (MOCK / build checklist)

Creating the actual Google Form can't be done from this repo — this file is the
exact spec to build it manually on the shared officer account. Question titles
MUST match `FORM_FIELDS` in `apps-script.gs` character-for-character, and the
choice labels MUST match the `*_MAP` tables there.

## Form description (member-facing pricing)

Google Forms can't compute prices, so state them as static text in the form
description (keep in sync with `membership_plans`):

> Membership: **$15 per semester / $25 for the full year.**
> Signups on or after **October 3** pay a $5 late fee on all plans
> ($20 semester / $30 full year). Pay via Venmo, Zelle, or cash before
> submitting — you'll upload your payment screenshot below.

The Apps Script computes the expected amount from the DB using the submission
date, so a member who pays the wrong tier is caught at treasurer verification.

## Form settings

- Owner: the shared officer Google account (also owns the response Sheet and
  the Drive folder that receives screenshot uploads).
- Collect email: off (we ask explicitly, so the answer lands in a named column).
- Requires sign-in: yes (Google requires it for file-upload questions).
- Responses → link to a Sheet; the Apps Script is bound to that Sheet with an
  "On form submit" trigger.

## Questions (in order)

| # | Title (exact)        | Type            | Required | Choices (exact labels)                    | Destination |
|---|----------------------|-----------------|----------|-------------------------------------------|-------------|
| 1 | First name           | Short answer    | yes      | —                                         | members.first_name |
| 2 | Last name            | Short answer    | yes      | —                                         | members.last_name |
| 3 | Email                | Short answer    | yes      | (email validation)                        | members.email |
| 4 | Student ID           | Short answer    | yes      | —                                         | members.student_id (permanent identity) |
| 5 | Discord username     | Short answer    | no       | —                                         | members.discord_username |
| 6 | University year      | Dropdown        | yes      | 1st / 2nd / 3rd / 4th / 5+                | members.university_year |
| 7 | Fam interest         | Multiple choice | yes      | Yes / No                                  | **Sheet only** (headcount; assignment via later form) |
| 8 | Mentorship interest  | Multiple choice | yes      | Yes / No                                  | **Sheet only** |
| 9 | Membership plan      | Multiple choice | yes      | Semester 1 / Semester 2 / Full Year       | membership_fees.plan (explicit — no date inference) |
| 10| Payment method       | Multiple choice | yes      | Venmo / Zelle / Cash                      | membership_fees.payment_method |
| 11| Payment screenshot   | File upload     | yes      | images only, 1 file, 10 MB                | membership_fees.screenshot_url (Drive URL); raw file stays in Drive |

## Not on the form (by design)

- role (defaults `member`), is_active (defaults true), joined_date (set by
  script), gender, notes, amount paid (defaulted from `membership_plans`,
  treasurer-editable at verification), paid date (submission timestamp,
  treasurer-editable at verification).

## Before opening the form (annual rollover checklist)

1. Seed `academic_periods` rows for the new year (fee inserts fail without them).
2. Seed `membership_plans` rows (prices) for the new year.
3. Update the `ACADEMIC_YEAR` script property in the Apps Script project.
4. Test with one throwaway submission; verify the pending row appears in the
   admin tool; delete the throwaway member + fee rows.

## Screenshot hygiene

Uploads land in a Drive folder on the shared account and contain personal
data — purge the folder at end of year (see CLAUDE.md operational notes).
