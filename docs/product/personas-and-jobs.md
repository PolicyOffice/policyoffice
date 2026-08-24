# Personas and Jobs to be Done

Who uses this product, what they are trying to accomplish, and which of them decide
whether it gets bought.

The single most important thing to remember while reading it: **in a 200-person company,
one person is often four of these personas.** The model must represent responsibilities
rather than job titles, because the organisation will separate them later and the evidence
has to survive that separation.

## Personas

### They buy it

| Persona | Wants | Pain today | Influence |
|---|---|---|---|
| **Head of Compliance / CCO** | To know governance status without asking anyone, and to answer regulators fast | Spreadsheet chasing, unknown ownership, evidence assembled in a panic | Usually the economic buyer |
| **Chief Risk Officer / COO** | Organisation-wide accountability and visible overdue risk | Compliance work scattered across disconnected tools | Alternative economic buyer |
| **Security / procurement reviewer** | Tenant isolation, identity, logging, residency, exit | Vague SaaS security posture, "EU hosting" claims that do not survive a question | Gatekeeper — can stop the deal |
| **DPO / Legal** | Minimisation, lawful retention, defensible transfer posture | Compliance tools that become surveillance systems | Gatekeeper |

### They run it

| Persona | Wants | Pain today | Frequency |
|---|---|---|---|
| **Policy / Compliance Manager** | To coordinate ownership, reviews, approvals and campaigns without chasing people by email | Manual follow-up, duplicated reporting, no reliable status | Daily. The champion, and the power user |
| **Document Owner** | Their documents to stay correct and current without becoming a governance expert | Forgotten review dates, unclear accountability | Weekly |
| **Author / Editor** | To draft changes efficiently without damaging approved evidence | Fear of editing the wrong version; feedback arriving as email attachments | Bursty |
| **Local entity compliance lead** | To adapt group documents where local law requires, and prove the divergence was deliberate | Copy proliferation, master/local drift nobody can measure | Monthly |
| **IT / identity administrator** | Clean provisioning, SSO, and offboarding that actually removes access | Manual account administration, orphaned accounts | Setup, then rarely |

### They are governed by it

| Persona | Wants | Pain today | Frequency |
|---|---|---|---|
| **Reviewer** | To examine one exact proposal and say what is wrong with it | Reviewing a different attachment from everyone else | Occasional |
| **Approver** | To approve exactly what was presented, with evidence of what that was | Weak proof of what they actually approved | Occasional, and consequential |
| **Required reader / employee** | To find what applies to them and finish what they must do, quickly | Too many irrelevant documents; repeated acknowledgements of things that did not change | Rare, and impatient |

### They inspect it

| Persona | Wants | Pain today | Access |
|---|---|---|---|
| **Internal audit** | Verifiable history without write access | Screenshots, exports and manually assembled timelines | Read-only, scoped |
| **External auditor / regulator liaison** | To reconstruct state at a historical date | Being given far more access than the job requires | Time-bounded, document-scoped |

That last row is a product requirement disguised as a persona. Giving an external auditor
tenant-wide read access because the product cannot express anything narrower is a real
failure, and INV-AUTH-008 exists to prevent it.

## The two experiences this implies

The personas divide cleanly into people who **operate** governance and people who are
**subject** to it, and their needs share almost nothing.

An employee looking for the travel policy should never see a compliance cockpit. A
compliance manager should never have to navigate a reader experience to find out what is
overdue. `information-architecture.md` treats this as the organising principle.

## Jobs to be done

| Situation | The job | Done when |
|---|---|---|
| A regulator asks what governed a process six months ago | *Show the exact applicable version as of that date, and its governance history* | Answered in minutes, without reconstructing folders and mailboxes |
| A document is being revised | *Route one exact proposal through the people whose approval is required* | No approver signs a moving target |
| A material update takes effect | *Tell only the affected people what changed, and obtain the acknowledgements required* | The correct population receives the correct immutable version |
| An employee moves from Estonia to Poland | *Recalculate what applies to them* | New obligations appear, irrelevant ones stop, historical evidence is untouched |
| A subsidiary has stricter local requirements | *Preserve the group baseline while governing the local divergence* | The local rule is explicit and traceable to its source |
| An approval is overdue | *Escalate visibly without fabricating consent* | The workflow stays blocked and accountability is obvious |
| A document reaches its review date | *Force an accountable review even when nothing needs to change* | The review outcome is itself evidence |
| An employee leaves | *Remove access and future obligations, keep lawful historical proof* | No active access; history intact under retention rules |
| An external auditor needs evidence | *Give precisely limited, temporary access* | They cannot navigate anything unrelated |
| Compliance prepares for an audit | *Generate a reproducible evidence package* | Exact source records, a manifest, and integrity anyone can verify |
| Management asks what is broken | *Show overdue approvals, overdue reviews, missing attestations, governance conflicts* | Actionable exceptions, not vanity metrics |
| An employee wonders what applies to them | *Show me my documents and what I still have to do* | One screen, no compliance vocabulary required |

## What each persona needs from the Pilot

The Pilot must serve five personas end to end. Everyone else can wait.

| Persona | Pilot | Why |
|---|---|---|
| **Author** | Yes | Half the golden slice |
| **Approver** | Yes | The other half, and the hardest evidence to get right |
| **Required reader** | Yes | Without them, attestation proves nothing |
| **Compliance Manager** | Yes | The champion. If the Pilot does not make their week better, nothing else matters |
| **Auditor** | Yes | Evidence packs are the differentiator; they need a real consumer |
| Reviewer | Yes, as a role distinct from Approver | It costs almost nothing and the distinction is load-bearing |
| Document Owner | Yes | Ownership and review scheduling |
| Local entity lead | No | Variants are Commercial V1 |
| IT administrator | Partly | Local users and groups in the Pilot; SSO and SCIM in V1 |
| Security reviewer, DPO | Not as users | They are served by architecture and documentation, not screens |

## Reader experience as a first-class concern

Worth stating plainly, because compliance products routinely get this wrong and their own
buyers do not notice until adoption fails.

The highest-volume user of this product is an employee who does not care about it. They
open it a handful of times a year, usually because they received an email. Every
additional concept the interface asks them to understand — variant, materiality,
effectivity, scope — is a reason they will instead ask a colleague what the rule is, which
is precisely the behaviour the product exists to eliminate.

So the reader experience carries an unusual constraint: it must expose almost none of the
domain model, while resting entirely on it.
