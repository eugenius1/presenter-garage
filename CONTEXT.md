# Context

The words this project uses, and what each means here. A glossary only: how
things are built is in [CONTRIBUTING.md](CONTRIBUTING.md). Add a term when its
meaning is settled.

## Rules

**RULES.md**
A team's rules for its slides, in its own words and language, written for a
person or an assistant to read. No tool reads it as rules.

**rules.json**
The rules an assistant compiled from a RULES.md, which the tools run. It lives
beside the RULES.md it came from and records that file's hash.

**Stale**
Said of a rules.json when its RULES.md has changed since it was compiled.

**Rule**
One entry in rules.json: an id the team chooses (ASCII, any language), a
check, the check's parameters, a tier, and optionally the libraries it is
kept to.

**Check**
One of the generic tests a rule can use, such as `line-marker` or
`slide-macros`. Checks know no team's group or macro names; those come from
the rules.

**Tier**
When a rule is dealt with. Tier 1: fixes safe to make in bulk. Tier 2: each
case reviewed by a person. Tier 3: last. A rule can also be off, kept written
down but not run.

**Finding** (also **rule break**)
One place a song breaks a rule: the rule, its tier, the slide, and the group
and line where there are ones.

**Exception**
A finding a person has said is fine, written in RULES.md with its reason.
It covers a rule for a song, a library, a value (a group name, a marker, a
macro) or any combination. An excepted finding is still listed but not
counted.

**Configured lists**
ProPresenter's own lists of groups and macros. A group in a song matches a
listed one by its exact name; a macro on a slide matches a listed one by its
uuid.

**Stored group order**
The order of a song's slides as ProPresenter numbers them: its groups as
stored, each group's slides in order. Rules read slides in this order, never
an arrangement's.

## Sync

**Base**
The library a merge is made into, kept wherever nothing says the other side
is better: the main library, which `compare --prefer` names.

**Difference**
One place two versions of a song differ: a pair of groups lined up side by
side. A version is proposed for each difference on its own.
