# Portfolio project playbook (from Aura → reusable)

This repo’s documentation process is the **reference implementation**. The reusable agent skill + copy-paste prompt live in your personal Cursor skills:

| File | Path |
|------|------|
| Skill | `~/.cursor/skills/portfolio-project-hardening/SKILL.md` |
| Prompt | `~/.cursor/skills/portfolio-project-hardening/PROMPT.md` |
| Personal store copy | Agent personal store → `prompts/PORTFOLIO_PROJECT_HARDENING.md` |

## What “done” means for any project

| Pillar | Standard |
|--------|----------|
| **Verifiable claims** | Every public number → evidence grade A/B/C/D + pointer |
| **Recruiter-friendly** | ~12s README: role, demo, highlights, proof, architecture |
| **Owned differentiation** | Hard primitives / failure domains in *your* code |
| **Documented decisions** | `docs/DECISIONS.md` updated as you work |
| **Useful + measured** | Clear job-to-be-done + metrics glossary |
| **XYZ ready** | Scaffolds in POSITIONING — you write resume lines later |
| **CI** | Automated tests on push/PR when a suite exists |

## Aura as the worked example

| Doc | Role |
|-----|------|
| [README.md](../README.md) | Recruiter glance |
| [BENCHMARKS.md](./BENCHMARKS.md) | Claim ↔ evidence |
| [DECISIONS.md](./DECISIONS.md) | Decision catalog |
| [POSITIONING.md](./POSITIONING.md) | Differentiation + XYZ |
| [FAANG_RECRUITER_CHECK.md](./FAANG_RECRUITER_CHECK.md) | Sourcer audit |
| [INTERVIEW_GUIDE.md](./INTERVIEW_GUIDE.md) | How to talk |

## How to use on the next project

1. Open that repo in Cursor.
2. Paste the prompt from `PROMPT.md` (fill brackets).
3. Or say: “Apply portfolio-project-hardening skill to this repo.”
4. Do not skip VERIFY (tests, live URL, screenshot pixels).
