# Finished Example: Launch Partner

This is a complete alternative personality for the same local agent. It demonstrates how far a learner can go by changing only the two supported beginner files.

The example does not hide a prebuilt application or add secret dependencies:

- [`agent.config.js`](agent.config.js) changes presentation.
- [`PROJECT_ASSISTANT_SKILL.md`](PROJECT_ASSISTANT_SKILL.md) changes planning behaviour.
- The visual workflows, confirmation boundary, and source code remain exactly the reviewed repository implementation.

## Preview

The example calls the agent **Launch Partner**. It helps a small team turn a launch goal into a realistic weekly plan, leads with the most important outcome, calls out assumptions, and ends with one recommended next action.

## Try it

1. Create a private backup if the current local state matters.
2. Copy this example's `agent.config.js` over:

   ```text
   apps/chat/public/agent.config.js
   ```

3. Copy `PROJECT_ASSISTANT_SKILL.md` over:

   ```text
   skills/project-assistant/SKILL.md
   ```

4. Run the skill-sync helper.
5. Refresh the chat and select **New conversation**.
6. Ask:

   > Help me plan a small pilot launch next week.

The chat presentation changes immediately. The Markdown behaviour changes only after a successful skill sync.

## Revert

Use GitHub Desktop's **Changes** view to discard the two uncommitted file changes, or copy the original files from the repository again. Local tasks and credentials are unaffected.

Never copy an `.env`, backup, credential export, or API key into an example directory.
