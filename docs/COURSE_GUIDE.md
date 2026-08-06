# Course guide — eight incremental exercises

## Course outcome

By the end, each team has an independently runnable local agent, can explain its
main visual workflow, has changed the interface and one skill, has demonstrated
a factual read and a safely approved write, and has pushed its customisation.

Use [Getting started](GETTING_STARTED.md) as the learner source of truth. This
guide gives the instructor timing, checkpoints, and boundaries.

## Before learners arrive

Complete the [instructor checklist](INSTRUCTOR_CHECKLIST.md), prepare the
versioned [release kit](RELEASE.md), and keep the released baseline unchanged
during the class. Record problems as issues instead of editing shared files
mid-session.

## Exercise 1 — start the local stack

**Suggested time:** 25 minutes

**Learner actions**

1. Create a private repository from the template.
2. Clone it with GitHub Desktop.
3. Run the one-click setup.
4. Create the local n8n owner.
5. Add the Anthropic credential and publish workflows `00` and `90`.
6. Run diagnostics and send the first planning message.

**Proof:** diagnostics are green and the browser shows a real Claude response.

**Do not:** paste an API key into chat, GitHub, `.env`, or a screen-shared
window.

## Exercise 2 — build and brand the chat

**Suggested time:** 15 minutes

**Learner actions**

1. Open `apps/chat/public/agent.config.js`.
2. Change the name, welcome message, accent colour, and three starter prompts.
3. Save and refresh the browser.

**Proof:** another team can describe what the customised agent is for by looking
only at its chat screen.

**Reference:** [Customise the chat](CUSTOMISE_CHAT.md).

## Exercise 3 — change the agent’s role

**Suggested time:** 15 minutes

**Learner actions**

1. Open workflow `00 - START HERE - Project Partner`.
2. Read the visible role and boundaries.
3. Make one small role change appropriate to the team project.
4. Save and publish.
5. Ask the same question before and after the change.

**Proof:** the team can point to the changed node and explain the observed
difference.

Keep tool-safety and exact-confirmation instructions intact.

## Exercise 4 — inspect memory and Claude usage

**Suggested time:** 10 minutes

**Learner actions**

1. Ask the agent to remember a harmless project fact.
2. Refer to that fact in the same conversation.
3. Stop and restart the local stack, reopen the chat, and ask again.
4. Search for the original message in **Chats**.
5. Select **New conversation** and ask again.
6. Run `npm run inspect-chats` and inspect redacted row metadata.
7. Inspect the n8n execution for the Claude node without opening credentials.

**Proof:** the learner can explain that memory is local, conversation-scoped,
durable across restart, completely browsable, but bounded when supplied to the
model.

## Exercise 5 — use the task-reading tool

**Suggested time:** 10 minutes

**Learner actions**

1. Open the local `tasks` Data Table in n8n.
2. Ask `What tasks are in my local project?`
3. Compare the answer with the visible rows.

**Proof:** every task claimed by the answer exists in the table.

**Reference:** [Local task tools](LOCAL_TASK_TOOLS.md).

## Exercise 6 — add a Markdown skill

**Suggested time:** 15 minutes

**Learner actions**

1. Edit one instruction in `skills/project-assistant/SKILL.md`, or copy the
   supplied skill pattern into a new folder.
2. Add the skill folder to `skills/enabled.txt` when creating a new skill.
3. Run the skill-sync helper.
4. Start a new conversation and test the instruction.

**Proof:** the team can show the Markdown change and a response influenced by
it.

**Reference:** [Customise skills](CUSTOMISE_SKILLS.md).

## Exercise 7 — confirm a task creation

**Suggested time:** 10 minutes

**Learner actions**

1. Ask the agent to create one clearly named task.
2. Check the proposed title, priority, and status.
3. Send `yes` and confirm that nothing changes.
4. Ask again if needed and send the exact `CONFIRM XXXXXXXX` phrase.
5. Inspect the task and audit rows.

**Proof:** exactly one task and one corresponding audit record exist.

**Reference:** [Safe write confirmation](SAFE_WRITE_CONFIRMATION.md).

## Exercise 8 — export, document, and demonstrate

**Suggested time:** 20 minutes

**Learner actions**

1. Save interface and skill files.
2. Export reviewed visual workflow changes when applicable.
3. Commit and push with GitHub Desktop.
4. Create a private local backup.
5. Give a three-minute demonstration: purpose, read, approved write, and one
   customisation.

**Proof:** the GitHub repository contains the customisation, the local project
still starts, and the backup folder exists outside Git.

## Completion record

| Team | First response | Branded chat | Role change | Memory explained | Read | Skill | Confirmed write | Pushed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T01 |  |  |  |  |  |  |  |  |

Do not put names, API keys, private task content, or credential screenshots in
this record.

## If an exercise runs late

Protect Exercises 1, 5, 7, and 8. They prove the system works, reads factual
local data, gates writes, and remains independently runnable. Treat Exercises
3, 4, and 6 as guided demonstrations if time is short; record the schedule
change for the next course iteration.
